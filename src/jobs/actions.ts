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
import { guardAgent, type AgentRefusal } from "../host/permissions.js"
import type { Plugin } from "@opencode/plugin"
import type { Clock } from "./clock.js"
import { nextRun } from "./cron.js"
import { DEFAULTS, nextId, parseJob, serverTimezone, updateJob, type Job } from "./model.js"
import type { Source } from "./report.js"
import { putJob, putState, readState, removeJob, setPauseAll, type PauseRecord } from "./store.js"

export interface ActionInput {
  readonly storage: Pick<Plugin.Context["storage"], "get" | "set" | "remove" | "scan">
  readonly agent: Pick<Plugin.Context["agent"], "get">
  readonly clock: Clock
  readonly timezone: string
  readonly source: () => Promise<Source>
  /** Rings the runner's doorbell, so a change starts within a tick rather than at the next cap. */
  readonly wake: () => void
  /** False when the store could not be brought to this build's schema: nothing is written to a store a newer build owns. */
  readonly ready: boolean
}

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

/** Creates a job from the model's or a person's input: validated, guarded, and stored. */
export async function createJob(input: ActionInput, definition: CreateInput): Promise<Job> {
  ensureWritable(input)
  const now = input.clock.now()
  const job = parseJob(definition, { now, timezone: input.timezone, id: nextId(now), source: "tool", createdBy: "agent" })
  const refusal = await guardAgent(input.agent, job.agent)
  if (refusal !== undefined) refuseAgent(refusal)
  await putJob(input.storage, job)
  const state = await readState(input.storage, job.id)
  await putState(input.storage, { ...state, nextDueAt: nextRun(job.schedule, now) ?? undefined })
  input.wake()
  return job
}

/** Replaces the fields a patch names, keeping the id, the source and who made it. */
export async function changeJob(input: ActionInput, id: string, patch: CreateInput): Promise<Job> {
  ensureWritable(input)
  const existing = mutable(await findJob(input, id), "change")
  const now = input.clock.now()
  const job = updateJob(existing, patch, { now, timezone: input.timezone, id: existing.id, source: existing.source, createdAt: existing.createdAt, createdBy: existing.createdBy })
  const refusal = await guardAgent(input.agent, job.agent)
  if (refusal !== undefined) refuseAgent(refusal)
  await putJob(input.storage, job)
  // A changed schedule starts from now: the old slot belonged to the old schedule.
  const state = await readState(input.storage, job.id)
  await putState(input.storage, { ...state, done: undefined, nextDueAt: nextRun(job.schedule, now) ?? undefined })
  input.wake()
  return job
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
 * Runs a job now: its next slot becomes this moment, and the runner picks it up within a tick. A paused job and a
 * paused runner are refused, because nothing would start.
 */
export async function runNow(input: ActionInput, id: string): Promise<Job> {
  ensureWritable(input)
  const job = await findJob(input, id)
  const state = await readState(input.storage, job.id)
  if (state.paused !== undefined) {
    throw jobsError("JOBS_DISABLED", `The job ${JSON.stringify(id)} is paused.`, `Resume it with the jobs_resume tool, then run it again.`)
  }
  // A slot already due is kept: the run-now slot is this moment, and the pass still handles anything older.
  await putState(input.storage, { ...state, done: undefined, nextDueAt: Math.min(state.nextDueAt ?? input.clock.now(), input.clock.now()) })
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
