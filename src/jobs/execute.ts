/**
 * One run: the dedup point, the session, the prompt, the timeout and the record.
 *
 * The run's key is `run/<job>/<slotISO>`, so it is deterministic per job and slot. The record is written `queued`
 * *before* anything starts and read back; a write that comes back with another leader's token did not own the slot, so
 * nothing runs. Storage has no compare-and-set (F3), so this read-back is what makes two overlapping leaders safe in
 * practice: the in-process lock is exact, the lease makes overlap rare, and the record decides the slot (DESIGN §5.2).
 *
 * A run never waits for a permission prompt. The session is created as the job's own agent, whose `permissions` are the
 * whole profile; the timeout is the bound of last resort, and a run that outlives its instance writes nothing, so the
 * next leader finalises it exactly once (`adopt.ts`).
 */
import type { Plugin } from "@opencode/plugin"
import { guardAgent } from "../host/permissions.js"
import type { Clock } from "./clock.js"
import { jobsError } from "../constants.js"
import type { Job, JobAction } from "./model.js"
import { forgetJobSession, jobOutput, openJobSession, SELF_DENIES } from "./safety.js"
import { approvalMatches, denied, limitsOf, manifestDigest, scriptSessionRules, sourceHash, type Script } from "./script.js"
import { createBridge } from "./script-bridge.js"
import type { ScriptGate } from "./script-gate.js"
import { commitFiles, resolveScriptFiles, snapshotFiles, type FileRecord, type FileSnapshot } from "./script-files.js"
import { runScript } from "./script-runtime.js"
import { getRun, putRun, readPauseAll, readState, slotISO, type RunOutcome, type RunRecord, type RunStatus, type Storage } from "./store.js"

/** The session members one run uses, and nothing else. */
export type Session = Pick<Plugin.Context["session"], "create" | "get" | "remove" | "prompt" | "command" | "synthetic" | "wait" | "interrupt" | "context">

/** How long a run may take to go idle after its interrupt before the record is written anyway. */
export const INTERRUPT_GRACE = 5_000
/** How long a run's claim waits before reading its own write back: storage was visible in ≤13 ms (V4). */
export const CLAIM_SETTLE = 25
/** The title of the one parked parent per project; its run sessions are its children (F11). */
export const PARENT_TITLE = "Jobs"

const TERMINAL: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "timed_out", "interrupted", "skipped", "missed"])

export const isTerminal = (status: RunStatus) => TERMINAL.has(status)

/** A run the runner tracks while it is in flight, so `replace` can interrupt it and a finish can ring the doorbell. */
export interface RunHandle {
  readonly slot: number
  readonly sessionID?: string
  readonly interrupt: () => Promise<void>
}

export interface RunRequest {
  readonly job: Job
  /** The planned fire time, before jitter. */
  readonly slot: number
  readonly attempt: number
  readonly late: boolean
  /** False once this instance has stopped being the leader: the run then finishes silently for the new leader. */
  readonly active: () => boolean
  readonly onSession?: (handle: RunHandle) => void
}

export interface RunResult {
  /** False when the slot belonged to someone else, or already had a record. */
  readonly claimed: boolean
  readonly status: RunStatus
  readonly outcome?: RunOutcome
  readonly record?: RunRecord
  readonly sessionID?: string
  readonly summary?: string
  readonly error?: string
  /** A run that outlived its instance: it wrote nothing, so the new leader adopts the record. */
  readonly abandoned?: boolean
}

export type Executor = (request: RunRequest) => Promise<RunResult>

export interface ExecutorInput {
  readonly storage: Storage
  readonly session: Session
  /** The agents a run is checked against at the moment it starts: a job refused at create is refused here too. */
  readonly agents: Pick<Plugin.Context["agent"], "get">
  readonly clock: Clock
  /** The directory a job without `target.directory` runs in: the leader's location. */
  readonly location: string
  /** The leader's token, recorded on every run it claims. */
  readonly token: string
  /** Aborted on cleanup, so a pending timeout does not outlive the instance. */
  readonly signal?: AbortSignal
  /** The script gate: a manifest's resolution and the one approval a script gets. A script run requires it. */
  readonly scripts?: ScriptGate
  /** The host's tools and tools RPCs, which a script's bridge calls. A script run requires both. */
  readonly tool?: Pick<Plugin.Context["tool"], "list">
  readonly rpc?: Plugin.Context["rpc"]
  /** Extra roots a script's declared files may live in, from the `scriptFilesRoots` option. */
  readonly scriptFilesRoots?: readonly string[]
}

export function createExecutor(input: ExecutorInput): Executor {
  return (request) => execute({ ...input, ...request })
}

export interface ExecuteInput extends ExecutorInput, RunRequest {}

export async function execute(input: ExecuteInput): Promise<RunResult> {
  // A step down before the claim leaves no record at all: the new leader owns the slot and will run it once.
  if (!input.active()) return { claimed: false, status: "queued", abandoned: true }
  const { job, slot, clock, storage } = input
  const key = slotISO(slot)
  const existing = await getRun(storage, job.id, key)
  // A terminal record ends the slot, unless this is a retry the policy scheduled: the same slot, a later attempt.
  if (existing !== undefined && isTerminal(existing.status) && input.attempt <= (existing.attempt ?? 1)) return { claimed: false, status: existing.status, record: existing }

  const lost = await claimSlot(input, existing)
  if (lost !== undefined) return lost
  if (!input.active()) return { claimed: true, status: "queued", abandoned: true }

  // A reminder posts into an existing session: no run session, no parked parent, and nothing to interrupt but the
  // target's own turn, which is the person's, so a replace never touches it.
  const action = job.action
  // A script runs no model turn: its session is created from the approved manifest, and the record carries no payloads.
  if (action.type === "script") return executeScript(input, action.script)
  // A reminder's session is the person's, so the record names it but never owns it.
  if (action.type === "remind") return complete(input, key, clock.now(), action.sessionID, await remind(input, action, slotISO(slot)), false)

  // A run needs an agent the host lists and that denies by default (D7). One that has become unguarded since the job was
  // created, or that the host no longer lists, is refused per slot rather than run: the slot is recorded as skipped, with
  // the code and the next step, and the schedule moves on. The check runs again on every slot, so the slot after the
  // agent is back runs normally.
  // The agent is the target directory's configuration. Only a job that targets another directory says so explicitly:
  // the leader's own location is what an omitted location resolves, and a host between reloads resolves it more reliably.
  const target = job.target.directory
  const refusal = await guardAgent(input.agents, job.agent, target === undefined || target === input.location ? undefined : target, input.location)
  if (refusal !== undefined) {
    const record = await putRun(storage, {
      job: job.id,
      slot: key,
      status: "skipped",
      reason: refusal.code === "JOBS_AGENT_MISSING" ? "missing" : "unguarded",
      late: input.late,
      attempt: input.attempt,
      token: input.token,
      startedAt: clock.now(),
      endedAt: clock.now(),
      error: refusal.message,
    })
    return { claimed: true, status: "skipped", record }
  }

  const directory = job.target.directory ?? input.location
  let sessionID: string | undefined
  let interrupt = async () => undefined
  try {
    const parentID = await jobsParent({ storage, session: input.session, directory })
    const created = await openJobSession({ session: input.session, job, directory, parentID, run: key, slot })
    sessionID = created.id
    interrupt = async () => {
      await input.session.interrupt({ sessionID: created.id }).catch(() => undefined)
    }
    const startedAt = clock.now()
    await putRun(storage, { job: job.id, slot: key, status: "running", late: input.late, attempt: input.attempt, token: input.token, sessionID, startedAt })
    input.onSession?.({ slot, sessionID, interrupt })
    const finished = await run(input, sessionID, action)
    await notifyRun(input, key, finished)
    return await complete(input, key, startedAt, sessionID, finished)
  } catch (error) {
    // A run that cannot start is a failed run: the record says so, and the runner counts it.
    if (sessionID !== undefined) forgetJobSession(sessionID)
    if (!input.active()) return { claimed: true, status: "running", ...(sessionID === undefined ? {} : { sessionID }), abandoned: true }
    const failed = await putRun(storage, {
      job: job.id,
      slot: key,
      status: "failed",
      late: input.late,
      attempt: input.attempt,
      token: input.token,
      ...(sessionID === undefined ? {} : { sessionID }),
      startedAt: clock.now(),
      endedAt: clock.now(),
      error: reason(error),
    })
    return { claimed: true, status: "failed", record: failed, ...(sessionID === undefined ? {} : { sessionID }), error: reason(error) }
  }
}

/** Writes the final record, unless this instance stopped leading: then the new leader adopts the open one. */
async function complete(input: ExecuteInput, key: string, startedAt: number, sessionID: string | undefined, result: Finished, owned = true): Promise<RunResult> {
  const { job, clock, storage } = input
  if (sessionID !== undefined) forgetJobSession(sessionID)
  if (!input.active()) return { claimed: true, status: result.status, ...(sessionID === undefined ? {} : { sessionID }), abandoned: true }
  const record = await putRun(storage, {
    job: job.id,
    slot: key,
    status: result.status,
    late: input.late,
    attempt: input.attempt,
    token: input.token,
    ...(sessionID === undefined ? {} : { sessionID }),
    ...(sessionID === undefined || !owned ? {} : { sessionOwned: true }),
    startedAt,
    endedAt: clock.now(),
    ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
    ...(result.summary === undefined ? {} : { summary: result.summary }),
    ...(result.cost === undefined ? {} : { cost: result.cost }),
    ...(result.script === undefined ? {} : { script: result.script }),
    ...(result.result === undefined ? {} : { result: result.result }),
    ...(result.calls === undefined ? {} : { calls: result.calls }),
    ...(result.limits === undefined ? {} : { limits: result.limits }),
    ...(result.files === undefined ? {} : { files: result.files }),
    ...(result.error === undefined ? {} : { error: result.error }),
  })
  return {
    claimed: true,
    status: result.status,
    record,
    ...(sessionID === undefined ? {} : { sessionID }),
    ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
    ...(result.summary === undefined ? {} : { summary: result.summary }),
  }
}

interface Finished {
  readonly status: RunStatus
  readonly outcome?: RunOutcome
  readonly summary?: string
  readonly cost?: number
  readonly script?: RunRecord["script"]
  readonly result?: RunRecord["result"]
  readonly calls?: RunRecord["calls"]
  readonly limits?: RunRecord["limits"]
  readonly files?: RunRecord["files"]
  /** A script run's coded error, when it did not succeed. */
  readonly error?: string
}

/**
 * The dedup point. A terminal record means the slot is done. Otherwise the record is written `queued` with our token,
 * the write is given time to be visible, and the record is read back: another token means another leader owns the slot
 * and this run does nothing. A record that is already `running` and still ours is a retry of the same slot, and is
 * claimed again deliberately.
 */
async function claimSlot(input: ExecuteInput, existing: RunRecord | undefined): Promise<RunResult | undefined> {
  const { job, slot, clock, storage } = input
  const key = slotISO(slot)
  if (existing !== undefined && existing.status === "running" && existing.token !== input.token) return { claimed: false, status: "running", record: existing }
  await putRun(storage, { job: job.id, slot: key, status: "queued", late: input.late, attempt: input.attempt, token: input.token })
  await clock.sleep(CLAIM_SETTLE, input.signal)
  const back = await getRun(storage, job.id, key)
  if (back?.token !== input.token) return { claimed: false, status: back?.status ?? "queued", ...(back === undefined ? {} : { record: back }) }
  return undefined
}

/**
 * A job's `notify` target: one post into that session, labelled as job output, after a prompt or command run. A notify
 * that fails is not the run's failure: the record already says what happened.
 */
async function notifyRun(input: ExecuteInput, key: string, finished: Finished): Promise<void> {
  const target = input.job.notify?.sessionID
  if (target === undefined) return
  const text = jobOutput(`${input.job.name} ${finished.status}.${finished.summary === undefined ? "" : `\n\n${finished.summary}`}`, { name: input.job.name, at: key })
  await input.session.synthetic({ sessionID: target, text, resume: false }).catch(() => undefined)
}

/** A reminder: posted into its own session with no model turn, or awaited when `wake` asks the agent to answer. */
async function remind(input: ExecuteInput, action: Extract<JobAction, { type: "remind" }>, at: string): Promise<Finished> {
  await input.session.synthetic({
    sessionID: action.sessionID,
    text: jobOutput(action.text, { name: input.job.name, at }),
    resume: action.wake,
  })
  if (!action.wake) return { status: "succeeded" }
  // A reminder that asks the agent to answer waits, but its timeout never interrupts the person's own turn: the record
  // says `timed_out` and the session is left exactly as it was.
  const finished = await bounded({ session: input.session, sessionID: action.sessionID, timeoutMs: input.job.policy.timeoutMs, clock: input.clock, signal: input.signal, interrupt: async () => undefined })
  return outcomeOf(input.session, action.sessionID, finished, input.signal)
}

/** A prompt or a command, then the wait against the timeout, then the outcome and the summary. */
async function run(input: ExecuteInput, sessionID: string, action: Exclude<JobAction, { type: "remind" | "script" }>): Promise<Finished> {
  const { job, clock, session } = input
  // The kill switch can arrive between the slot being taken and the turn starting. Checking it here, before and after
  // the turn is asked for, means a pause never pays for a model call it cannot stop (`bounded` covers the rest).
  if (await paused(input)) return { status: "interrupted" }
  if (action.type === "prompt") await session.prompt({ sessionID, text: action.text })
  else await session.command({ sessionID, name: action.name, text: action.arguments ?? "" })
  if (await paused(input)) {
    await session.interrupt({ sessionID }).catch(() => undefined)
    return { status: "interrupted" }
  }
  const finished = await bounded({
    session,
    sessionID,
    timeoutMs: job.policy.timeoutMs,
    clock,
    signal: input.signal,
    interrupt: async () => {
      await session.interrupt({ sessionID }).catch(() => undefined)
    },
  })
  return outcomeOf(session, sessionID, finished, input.signal)
}

/** True while the kill switch is set. A storage failure is not a pause: the hook and the timeout still bound the run. */
async function paused(input: Pick<ExecuteInput, "storage">): Promise<boolean> {
  return readPauseAll(input.storage).then(
    (record) => record !== undefined,
    () => false,
  )
}

/**
 * `wait` against the job's timeout. `wait` resolves rather than reporting an outcome, so a timeout means the run is
 * interrupted and the record says `timed_out`; the interruption is bounded too, and the record is written either way.
 * A cleanup during the wait returns `done`, so the old instance never interrupts a session the new leader adopts.
 */
async function bounded(input: { session: Session; sessionID: string; timeoutMs: number; clock: Clock; signal?: AbortSignal; interrupt: () => Promise<void> }): Promise<"done" | "timeout"> {
  const wait = input.session.wait({ sessionID: input.sessionID }).then(
    () => "done" as const,
    () => "done" as const,
  )
  const race = await Promise.race([wait, input.clock.sleep(input.timeoutMs, input.signal).then(() => "timeout" as const)])
  if (race === "done" || input.signal?.aborted === true) return "done"
  await input.interrupt()
  await Promise.race([wait, input.clock.sleep(INTERRUPT_GRACE, input.signal)])
  return "timeout"
}

/** The outcome the host reports, which is the source of truth after a wait, and the last assistant text as the summary. */
async function outcomeOf(session: Session, sessionID: string, finished: "done" | "timeout", signal?: AbortSignal): Promise<Finished> {
  const info = await session.get({ sessionID }).catch(() => undefined)
  const summary = await summaryOf(session, sessionID)
  const outcome = info?.outcome
  const status: RunStatus = finished === "timeout" && signal?.aborted !== true ? "timed_out" : outcome === "failed" ? "failed" : outcome === "interrupted" ? "interrupted" : "succeeded"
  return {
    status,
    ...(outcome === undefined ? {} : { outcome }),
    ...(summary === undefined ? {} : { summary }),
    ...(typeof info?.cost === "number" ? { cost: info.cost } : {}),
  }
}

/** The parked "Jobs" parent of a directory, recreated when it has been deleted, which also deletes its children (F11). */
export async function jobsParent(input: { storage: Storage; session: Pick<Session, "create" | "get">; directory: string }): Promise<string> {
  const key = `state/parent/${input.directory}`
  const stored = await input.storage.get(key)
  if (typeof stored === "string" && stored !== "") {
    const alive = await input.session.get({ sessionID: stored }).catch(() => undefined)
    if (alive !== undefined) return stored
  }
  const created = await input.session.create({ title: PARENT_TITLE, location: { directory: input.directory }, metadata: { jobs: { parent: true } } })
  await input.storage.set(key, created.id)
  return created.id
}

/** The last assistant text, which is the run's summary: job output, capped by the store, never a transcript. */
export async function summaryOf(session: Pick<Session, "context">, sessionID: string): Promise<string | undefined> {
  const messages = await session.context({ sessionID }).catch(() => [])
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { type?: string; content?: readonly { type?: string; text?: unknown }[] } | undefined
    if (message?.type !== "assistant" || !Array.isArray(message.content)) continue
    const text = message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim()
    return text === "" ? undefined : text
  }
  return undefined
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A slot a script job could not start because a declared file could not be read or parsed. */
async function failScript(input: ExecuteInput, key: string, error: unknown): Promise<RunResult> {
  const message = reason(error)
  const record = await putRun(input.storage, {
    job: input.job.id,
    slot: key,
    status: "failed",
    late: input.late,
    attempt: input.attempt,
    token: input.token,
    startedAt: input.clock.now(),
    endedAt: input.clock.now(),
    error: message,
  })
  return { claimed: true, status: "failed", record, error: message }
}

/** One record per declared file: what it read, and what a commit wrote, never the content. */
function recordsOf(snapshots: readonly FileSnapshot[], writes: readonly FileRecord[] = []): readonly FileRecord[] {
  return snapshots.map((snapshot) => {
    const written = writes.find((record) => record.name === snapshot.file.name)
    return {
      name: snapshot.file.name,
      path: snapshot.file.path,
      mode: snapshot.file.mode,
      bytesRead: snapshot.bytes,
      bytesWritten: written?.bytesWritten ?? 0,
      ...(snapshot.sha256 === null ? {} : { sha256Before: snapshot.sha256 }),
      ...(written?.sha256After === undefined ? {} : { sha256After: written.sha256After }),
    }
  })
}

/** A slot a script job could not run, with the code and the one act that unlocks it. */
async function skipScript(input: ExecuteInput, key: string, skipReason: "unapproved" | "revoked", code: string, what: string, next: string): Promise<RunResult> {
  const message = jobsError(code, what, next).message
  const record = await putRun(input.storage, {
    job: input.job.id,
    slot: key,
    status: "skipped",
    reason: skipReason,
    late: input.late,
    attempt: input.attempt,
    token: input.token,
    startedAt: input.clock.now(),
    endedAt: input.clock.now(),
    error: message,
  })
  return { claimed: true, status: "skipped", record, error: message }
}

/**
 * A script job's run: re-resolve, re-check the approval, build the run session from the granted manifest, and run the
 * confined runtime. Nothing here calls a model, and nothing outside the manifest is reachable from the guest.
 */
async function executeScript(input: ExecuteInput, script: Script): Promise<RunResult> {
  const { job, clock, storage } = input
  const key = slotISO(input.slot)
  const directory = job.target.directory ?? input.location
  const state = await readState(storage, job.id)
  if (input.scripts === undefined || input.tool === undefined || input.rpc === undefined) {
    return skipScript(input, key, "unapproved", "JOBS_SCRIPT_UNAPPROVED", `The script ${JSON.stringify(job.id)} cannot run here because the script runtime is not available.`, `Restart OpenCode, then approve the script again with /jobs-approve ${job.id}.`)
  }
  const gate = input.scripts
  const tools = input.tool
  const rpc = input.rpc
  let resolved
  try {
    resolved = await gate.resolve(script.uses, job.agent, directory)
  } catch (error) {
    return skipScript(input, key, "unapproved", "JOBS_SCRIPT_UNAPPROVED", `The script ${JSON.stringify(job.id)} could not re-resolve its manifest (${reason(error)}).`, `Approve it again with the jobs_approve tool or /jobs-approve ${job.id}.`)
  }
  let resolvedFiles
  try {
    resolvedFiles = await resolveScriptFiles(script.files, directory, input.scriptFilesRoots ?? [])
  } catch (error) {
    return skipScript(input, key, "unapproved", "JOBS_SCRIPT_UNAPPROVED", `The script ${JSON.stringify(job.id)} has a declared file the policy now refuses (${reason(error)}).`, `Fix the path, then approve the script again with /jobs-approve ${job.id}.`)
  }
  if (!approvalMatches(state.approval, script, resolved, resolvedFiles)) {
    return skipScript(input, key, "unapproved", "JOBS_SCRIPT_UNAPPROVED", `The script ${JSON.stringify(job.id)} has changed since it was approved, or its tools or files resolve differently now.`, `Approve it again with the jobs_approve tool or /jobs-approve ${job.id}.`)
  }
  const revoked = denied(resolved)
  if (revoked.length > 0) {
    const names = revoked.map((tool) => `${tool.method} (${tool.action})`).join(", ")
    const rules = revoked.map((tool) => ({ action: tool.action, resource: "*", effect: "allow" }))
    return skipScript(input, key, "revoked", "JOBS_SCRIPT_REVOKED", `The script ${JSON.stringify(job.id)} uses tools its agent now denies: ${names}.`, `Add these rules to that agent's permissions: ${JSON.stringify(rules)}, or remove the deny, then approve the script again.`)
  }
  // The declared files are read before the session, so an invalid or oversized file fails the slot without a run.
  let snapshots: readonly FileSnapshot[]
  try {
    snapshots = await snapshotFiles(resolvedFiles)
  } catch (error) {
    return await failScript(input, key, error)
  }
  // The kill switch can arrive between the claim and the session.
  if (await paused(input)) return { claimed: true, status: "interrupted" }

  const limits = limitsOf(script)
  const timeoutMs = Math.min(script.timeoutMs ?? job.policy.timeoutMs, job.policy.timeoutMs)
  const controller = new AbortController()
  let stopped = false
  const stop = () => {
    stopped = true
    controller.abort()
  }
  input.signal?.addEventListener("abort", stop, { once: true })
  let sessionID: string | undefined
  try {
    const parentID = await jobsParent({ storage, session: input.session, directory })
    const created = await openJobSession({ session: input.session, job, directory, parentID, run: key, slot: input.slot, permissions: scriptSessionRules(resolved, SELF_DENIES) })
    sessionID = created.id
    const startedAt = clock.now()
    await putRun(storage, {
      job: job.id,
      slot: key,
      status: "running",
      late: input.late,
      attempt: input.attempt,
      token: input.token,
      sessionID,
      startedAt,
      script: { sourceHash: sourceHash(script.code), manifestDigest: manifestDigest(script.uses), uses: [...script.uses] },
    })
    input.onSession?.({
      slot: input.slot,
      sessionID,
      interrupt: async () => {
        stopped = true
        controller.abort()
        await input.session.interrupt({ sessionID: created.id }).catch(() => undefined)
      },
    })
    const bridge = createBridge({ rpc, tool: tools, session: input.session, agent: input.agents, sessionID, agentID: job.agent, manifest: resolved })
    const outcome = await runScript({
      code: script.code,
      allowed: new Set(resolved.map((tool) => tool.method)),
      limits,
      timeoutMs,
      bridge,
      signal: controller.signal,
      now: clock.now,
      files: {
        values: Object.fromEntries(snapshots.filter((snapshot) => snapshot.file.mode !== "write").map((snapshot) => [snapshot.file.name, snapshot.value] as const)),
        writable: new Set(resolvedFiles.filter((file) => file.mode !== "read").map((file) => file.name)),
      },
    })
    const interrupted = stopped || input.signal?.aborted === true || outcome.limits.interrupted
    const status: RunStatus = outcome.ok ? "succeeded" : interrupted ? "interrupted" : outcome.limits.timedOut ? "timed_out" : "failed"
    let fileRecords = recordsOf(snapshots)
    if (outcome.ok) {
      try {
        fileRecords = recordsOf(snapshots, await commitFiles(snapshots, outcome.writes))
      } catch (error) {
        return await complete(input, key, startedAt, sessionID, {
          status: "failed",
          script: { sourceHash: sourceHash(script.code), manifestDigest: manifestDigest(script.uses), uses: [...script.uses] },
          result: { ok: true, value: outcome.value },
          calls: outcome.calls,
          limits: outcome.limits,
          files: fileRecords,
          error: reason(error),
        })
      }
    }
    return await complete(input, key, startedAt, sessionID, {
      status,
      script: { sourceHash: sourceHash(script.code), manifestDigest: manifestDigest(script.uses), uses: [...script.uses] },
      result: outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error },
      calls: outcome.calls,
      limits: outcome.limits,
      files: fileRecords,
      ...(outcome.ok || outcome.error === undefined ? {} : { error: outcome.error }),
    })
  } catch (error) {
    if (sessionID !== undefined) forgetJobSession(sessionID)
    if (!input.active()) return { claimed: true, status: "running", ...(sessionID === undefined ? {} : { sessionID }), abandoned: true }
    const failed = await putRun(storage, {
      job: job.id,
      slot: key,
      status: "failed",
      late: input.late,
      attempt: input.attempt,
      token: input.token,
      ...(sessionID === undefined ? {} : { sessionID }),
      startedAt: clock.now(),
      endedAt: clock.now(),
      error: reason(error),
    })
    return { claimed: true, status: "failed", record: failed, ...(sessionID === undefined ? {} : { sessionID }), error: reason(error) }
  } finally {
    input.signal?.removeEventListener("abort", stop)
  }
}
