/**
 * The changes a person or the model may make, one place each: create, update, delete, pause, resume, extend and run a
 * job now. `jobs_*` tools, the `/jobs-run` command and the dialog all call these, so a job is changed the same way
 * whatever surface asked.
 *
 * Everything here validates before it writes: a definition goes through `parseJob`/`updateJob`, an agent through the
 * guarded check (D7), and a schedule that has no slot left is refused rather than resurrected. Nothing here asserts a
 * permission: the tool's own action asks, and the prompt is the yes.
 */
import { jobsError } from "../constants.js"
import { reasonOf } from "../redact.js"
import { guardAgent, type AgentRefusal } from "../host/permissions.js"
import type { Plugin } from "@opencode/plugin"
import type { Clock } from "./clock.js"
import { nextRun } from "./cron.js"
import { DEFAULTS, nextId, parseJob, serverTimezone, updateJob, type Job } from "./model.js"
import { stopReason } from "./policy.js"
import type { Source } from "./report.js"
import { approvalMatches, denied, worstClass, type ScriptApproval } from "./script.js"
import type { Access } from "../options.js"
import { resolveScriptFiles } from "./script-files.js"
import type { ScriptGate } from "./script-gate.js"
import { getRun, putJob, putState, readState, removeJob, setPauseAll, slotISO, updateState, type PauseRecord } from "./store.js"

export interface ActionInput {
  readonly storage: Pick<Plugin.Context["storage"], "get" | "set" | "remove" | "scan">
  readonly agent: Pick<Plugin.Context["agent"], "get">
  readonly clock: Clock
  readonly timezone: string
  /** The leader's directory: an agent is resolved in the directory the run happens in. */
  readonly location: string
  readonly source: () => Promise<Source>
  /** Rings the runner's doorbell, so a change starts within a tick rather than at the next cap. */
  readonly wake: () => void
  /** False when the store could not be brought to this build's schema: nothing is written to a store a newer build owns. */
  readonly ready: boolean
  /** The script gate: resolving a manifest, and the one approval a script gets. Absent only in unit fakes. */
  readonly scripts?: ScriptGate
  /** Extra roots a script's declared files may live in, from the `scriptFilesRoots` option. */
  readonly scriptFilesRoots?: readonly string[]
  /** The family access policy (`all`, `ask-changes`, `read-only`), R18. */
  readonly access?: Access
}

/** The tool call an approval is made in, so the host's prompt carries its own source. */
export interface ApprovalCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID?: string
  readonly id?: string
}

/** The directory an agent resolves in, when the job targets one other than the leader's own; undefined otherwise. */
const elsewhere = (job: Job, input: Pick<ActionInput, "location">) =>
  job.target.directory === undefined || job.target.directory === input.location ? undefined : job.target.directory

/** Refuses any change to a store this build does not understand, so a downgrade never writes it (JR-2). */
export function ensureWritable(input: Pick<ActionInput, "ready">): void {
  if (input.ready) return
  throw jobsError("JOBS_STORAGE_VERSION", `The job store could not be brought to this build's schema, so nothing was changed.`, `Update the plugin to the version that wrote the store, or clear its storage to start again.`)
}

/** The job with this id, or a refusal. A refused job file is reported by the reader and is not a job here. */
export async function findJob(input: Pick<ActionInput, "source">, id: string): Promise<Job> {
  const { jobs } = await input.source()
  const job = jobs.find((candidate) => candidate.id === id)
  if (job === undefined) {
    throw jobsError("JOBS_TARGET_MISSING", `There is no job with the id ${JSON.stringify(id)}.`, `Run the jobs_list tool to see the jobs there are.`)
  }
  return job
}

/** A file job's file is its definition: tools pause it, and never edit or delete it (D3). */
function mutable(job: Job, action: "change" | "delete"): Job {
  if (job.source === "tool") return job
  throw jobsError(
    "JOBS_INVALID_JOB",
    `The job ${JSON.stringify(job.id)} is defined by a file, and a file job cannot be ${action === "delete" ? "deleted" : "changed"} by a tool.`,
    `Edit or remove the job's file in .opencode/jobs, then run /jobs-status again.`,
  )
}

/** The refusal of an unguarded agent as the coded error a tool or a command throws. */
export function refuseAgent(refusal: AgentRefusal): never {
  throw jobsError(refusal.code, refusal.what, refusal.nextStep)
}

export interface CreateInput {
  readonly name?: unknown
  readonly schedule?: unknown
  readonly action?: unknown
  readonly agent?: unknown
  readonly target?: unknown
  readonly allow?: unknown
  readonly policy?: unknown
  readonly ends?: unknown
  readonly expires?: unknown
  readonly jitter?: unknown
}

/**
 * A script job's manifest is its confinement, so D7's guarded-agent check is replaced by the manifest checks: every
 * entry must resolve, and none may resolve to deny. The approval is the host's one prompt, bound to the source and the
 * manifest (D-A), and it is stored as job state.
 */
async function scriptApproval(input: ActionInput, job: Job, call: ApprovalCall | undefined, previous?: ScriptApproval): Promise<ScriptApproval> {
  if (job.action.type !== "script") throw new Error("jobs: a script approval needs a script action")
  if (input.scripts === undefined) {
    throw jobsError("JOBS_SCRIPT_UNAPPROVED", `The script gate is not available, so ${JSON.stringify(job.id)} cannot be approved.`, `Restart OpenCode, then approve the script again.`)
  }
  if (call === undefined) {
    throw jobsError("JOBS_UNCHECKED", `The script ${JSON.stringify(job.id)} was changed with no tool call to check its approval against.`, `Call jobs_create or jobs_update from a session, where the approval can be asked.`)
  }
  const resolved = await input.scripts.resolve(job.action.script.uses, job.agent, elsewhere(job, input))
  const bad = denied(resolved)
  if (bad.length > 0) {
    const names = bad.map((tool) => `${tool.method} (${tool.action})`).join(", ")
    const rules = bad.map((tool) => ({ action: tool.action, resource: "*", effect: "allow" }))
    throw jobsError(
      "JOBS_SCRIPT_DENIED",
      `The script ${JSON.stringify(job.id)} uses tools its agent denies: ${names}.`,
      `To allow them, add these rules to that agent's permissions: ${JSON.stringify(rules)}. Or point the job at an agent that allows them; a script cannot be granted a tool its agent denies.`,
    )
  }
  const directory = elsewhere(job, input) ?? input.location
  const files = await resolveScriptFiles(job.action.script.files, directory, input.scriptFilesRoots ?? [])
  // R19: a file outside the project also needs the agent's own external_directory allow, at approval and at every run.
  const outside = await input.scripts.external?.({ agent: job.agent, project: directory, files, location: directory })
  if (outside !== undefined) {
    throw jobsError(
      "JOBS_SCRIPT_DENIED",
      `The script ${JSON.stringify(job.id)} declares the file ${JSON.stringify(outside.name)} at ${JSON.stringify(outside.path)}, outside the project, and its agent does not allow external_directory for it.`,
      `Add this rule to that agent's permissions: ${JSON.stringify({ action: "external_directory", resource: outside.resource, effect: "allow" })}, then approve the script again.`,
    )
  }
  const access = input.access ?? "all"
  const worst = worstClass(resolved, files)
  if (access === "read-only" && worst === "change") {
    throw jobsError(
      "JOBS_SCRIPT_DENIED",
      `The script ${JSON.stringify(job.id)} changes something, and the plugin's access option is "read-only".`,
      `Set the plugin option "access" to "ask-changes" or "all", then approve the script again. A read-only access allows only all-read scripts and no file writes.`,
    )
  }
  // An update that leaves the source, the manifest and the resolution unchanged keeps the approval it already had.
  if (previous !== undefined && approvalMatches(previous, job.action.script, resolved, files)) return previous
  // R18/GAP-21: `all` approves automatically; `ask-changes` auto-approves an all-read script and asks for a change.
  const approved = access === "all" || worst === "read" ? "auto" : "prompt"
  try {
    return await input.scripts.approve({
      sessionID: call.sessionID,
      agent: call.agent,
      script: job.action.script,
      resolved,
      files,
      job: job.id,
      ...(job.source === "file" && job.sourcePath !== undefined ? { jobFile: job.sourcePath } : {}),
      approved,
      ...(call.messageID === undefined || call.id === undefined ? {} : { source: { messageID: call.messageID, id: call.id } }),
    })
  } catch (error) {
    if (approved === "auto") throw error
    // GAP-20: a headless create has no one to answer; the RPC gets a coded refusal with the way to approve it, never a 500.
    throw jobsError(
      "JOBS_UNCHECKED",
      `The script ${JSON.stringify(job.id)} changes something and needs a person's approval, and no one answered (${reasonOf(error)}).`,
      `Approve it in the OpenCode TUI (or with /jobs-approve ${job.id}), or set the plugin option "access" to "all" for automatic approval.`,
    )
  }
}

/**
 * Approves file script jobs under the access policy, at load and whenever their digest changes. A file job has no
 * create call to approve it, so this is where `all` (and an all-read `ask-changes` script) gets its automatic approval
 * and its audit record. A changing script under `ask-changes` stays unapproved for a person's `/jobs-approve`.
 */
export async function reconcileFileScripts(input: Pick<ActionInput, "storage" | "scripts" | "location" | "scriptFilesRoots" | "access">, jobs: readonly Job[]): Promise<void> {
  if (input.scripts === undefined) return
  for (const job of jobs) {
    if (job.source !== "file" || job.action.type !== "script") continue
    const directory = elsewhere(job, input) ?? input.location
    let resolved
    let files
    try {
      resolved = await input.scripts.resolve(job.action.script.uses, job.agent, directory)
      files = await resolveScriptFiles(job.action.script.files, directory, input.scriptFilesRoots ?? [])
    } catch {
      // A path or tool the policy refuses is reported by the run and by status; there is nothing to approve.
      continue
    }
    const outside = await input.scripts.external?.({ agent: job.agent, project: directory, files, location: directory })
    if (outside !== undefined) continue
    const access = input.access ?? "all"
    const worst = worstClass(resolved, files)
    if (access === "read-only" && worst === "change") continue
    if (access === "ask-changes" && worst === "change") continue
    const state = await readState(input.storage, job.id)
    if (approvalMatches(state.approval, job.action.script, resolved, files)) continue
    try {
      const approval = await input.scripts.approve({
        sessionID: "jobs-reconcile",
        agent: job.agent,
        script: job.action.script,
        resolved,
        files,
        job: job.id,
        ...(job.sourcePath === undefined ? {} : { jobFile: job.sourcePath }),
        approved: "auto",
      })
      await updateState(input.storage, job.id, (current) => ({ ...current, approval }))
    } catch {
      // Leave the next step to the run and status, which name the approval command.
    }
  }
}

/** Creates a job from the model's or a person's input: validated, guarded (or approved), and stored. */
export async function createJob(input: ActionInput, definition: CreateInput, call?: ApprovalCall): Promise<Job> {
  ensureWritable(input)
  const now = input.clock.now()
  const job = parseJob(definition, { now, timezone: input.timezone, id: nextId(now), source: "tool", createdBy: "agent" })
  let approval: ScriptApproval | undefined
  if (job.action.type === "script") approval = await scriptApproval(input, job, call)
  else {
    const refusal = await guardAgent(input.agent, job.agent, elsewhere(job, input), input.location)
    // R18: an unguarded agent is a status warning; a missing or unreadable one is still refused.
    if (refusal !== undefined && refusal.code !== "JOBS_AGENT_UNGUARDED") refuseAgent(refusal)
  }
  await putJob(input.storage, job)
  const state = await readState(input.storage, job.id)
  await putState(input.storage, {
    ...state,
    nextDueAt: nextRun(job.schedule, now) ?? undefined,
    ...(approval === undefined ? {} : { approval }),
  })
  input.wake()
  return job
}

/** Replaces the fields a patch names, keeping the id, the source and who made it. */
export async function changeJob(input: ActionInput, id: string, patch: CreateInput, call?: ApprovalCall): Promise<Job> {
  ensureWritable(input)
  const existing = mutable(await findJob(input, id), "change")
  const now = input.clock.now()
  const job = updateJob(existing, patch, { now, timezone: input.timezone, id: existing.id, source: existing.source, createdAt: existing.createdAt, createdBy: existing.createdBy })
  const previous = await readState(input.storage, job.id)
  let approval: ScriptApproval | undefined
  if (job.action.type === "script") approval = await scriptApproval(input, job, call, previous.approval)
  else {
    const refusal = await guardAgent(input.agent, job.agent, elsewhere(job, input), input.location)
    // R18: an unguarded agent is a status warning; a missing or unreadable one is still refused.
    if (refusal !== undefined && refusal.code !== "JOBS_AGENT_UNGUARDED") refuseAgent(refusal)
  }
  await putJob(input.storage, job)
  // A changed schedule starts from now: the old slot belonged to the old schedule.
  await putState(input.storage, { ...previous, done: undefined, nextDueAt: nextRun(job.schedule, now) ?? undefined, approval })
  input.wake()
  return job
}

/**
 * Approves a script job again, after its source, manifest or a tool's class changed. It is the one act a person takes
 * when status says re-approval is needed; the resolve and the denial check are the same as at create.
 */
export async function approveJob(input: ActionInput, id: string, call: ApprovalCall): Promise<{ job: Job; approval: ScriptApproval }> {
  ensureWritable(input)
  const job = await findJob(input, id)
  if (job.action.type !== "script") {
    throw jobsError("JOBS_INVALID_JOB", `The job ${JSON.stringify(id)} has no script action to approve.`, `Approve only a job whose action is a script.`)
  }
  const approval = await scriptApproval(input, job, call)
  await updateState(input.storage, job.id, (state) => ({ ...state, approval }))
  input.wake()
  return { job, approval }
}

export async function deleteJob(input: ActionInput, id: string): Promise<Job> {
  ensureWritable(input)
  const job = mutable(await findJob(input, id), "delete")
  await removeJob(input.storage, job.id)
  input.wake()
  return job
}

/** Pauses one job, or resumes it: its runtime state, never its definition. */
export async function pauseJob(input: ActionInput, id: string, paused: boolean): Promise<Job> {
  ensureWritable(input)
  const job = await findJob(input, id)
  const state = await readState(input.storage, job.id)
  if (!paused) {
    const next = nextRun(job.schedule, input.clock.now())
    if (next === null) throw jobsError("JOBS_EXPIRED", `The job ${JSON.stringify(id)} has no slot left to resume.`, `Extend it with the jobs_extend tool, or create a new job.`)
    await putState(input.storage, { ...state, paused: undefined, done: undefined, nextDueAt: next })
    input.wake()
    return job
  }
  await putState(input.storage, { ...state, paused: { at: input.clock.now(), reason: "Paused with jobs_pause." } })
  input.wake()
  return job
}

/** Sets a job's expiry: the deliberate act that moves it, and it asks like any other change. */
export async function extendJob(input: ActionInput, id: string, expires: number): Promise<Job> {
  ensureWritable(input)
  const existing = mutable(await findJob(input, id), "change")
  if (expires <= input.clock.now()) {
    throw jobsError("JOBS_INVALID_JOB", `The new expiry ${new Date(expires).toISOString()} is not in the future.`, `Give a time after now, such as tomorrow at 09:00.`)
  }
  const job: Job = { ...existing, expires }
  await putJob(input.storage, job)
  input.wake()
  return job
}

/**
 * Runs a job now, as a manual run with its own slot key: the schedule is untouched, so no scheduled slot is consumed,
 * skipped or collided with (DR-3). A paused job, an expired job and a job whose `at` has passed are refused with the
 * reason and the next step, because nothing could start.
 */
export async function runNow(input: ActionInput, id: string): Promise<Job> {
  ensureWritable(input)
  const job = await findJob(input, id)
  const state = await readState(input.storage, job.id)
  if (state.paused !== undefined) {
    throw jobsError("JOBS_DISABLED", `The job ${JSON.stringify(id)} is paused.`, `Resume it with the jobs_resume tool, then run it again.`)
  }
  const stop = stopReason(job, state, input.clock.now())
  if (stop === "expired" || stop === "ended") {
    throw jobsError("JOBS_EXPIRED", `The job ${JSON.stringify(id)} has no slot left, so it cannot run now.`, `Extend it with the jobs_extend tool, or create a new job.`)
  }
  // Its own slot key, so it never lands on a scheduled slot's record.
  let at = input.clock.now()
  while ((await getRun(input.storage, job.id, slotISO(at))) !== undefined) at += 1
  await updateState(input.storage, job.id, (current) => ({ ...current, manual: { at } }))
  input.wake()
  return job
}

/** The kill switch: every job at once, from any surface. The dialog, the tool and the command share this state. */
export async function pauseEveryJob(input: Pick<ActionInput, "storage" | "clock" | "wake" | "ready">, paused: boolean): Promise<PauseRecord | undefined> {
  ensureWritable(input)
  const next = await setPauseAll(input.storage, paused, input.clock.now())
  input.wake()
  return next
}

/** The zone a job runs in when the tool call names none: the plugin's, else the server's. */
export const zoneOf = (timezone: string | null) => timezone ?? serverTimezone()

export { DEFAULTS }
