/**
 * The job store: typed access to `ctx.storage`, with the keys of the design (§5.3), a schema version and its
 * migrations, run records, and retention.
 *
 * Storage is shared by every instance and survives reloads and restarts, and has no compare-and-set (F3, V-5): one key
 * per job, per state and per run, written only by the leader. `scan` is paged (`{ entries, next? }`), so every list here
 * follows `next`.
 *
 * The cross-process lease (`lease/leader`) and the runner record (`runner`) belong to the runner and arrive with it.
 */
import type { Plugin } from "@opencode/plugin"
import { jobsError } from "../constants.js"
import { cut } from "../redact.js"
import { DAY, type Job } from "./model.js"
import type { ResolvedFile, ScriptApproval, ScriptCall, ScriptLimitFlags } from "./script.js"
import type { FileRecord } from "./script-files.js"

/** The schema this build writes. A store with a later one is refused, not overwritten. */
export const SCHEMA_VERSION = 2

/** Retention keeps the last 50 runs of a job and the last 30 days, whichever keeps less (D9). */
export const MAX_RUNS = 50
export const RETENTION_MS = 30 * DAY

/** A run summary is job output and is capped before it is stored. */
export const SUMMARY_LIMIT = 2048
const ERROR_LIMIT = 500

const SCHEMA_KEY = "meta/schema"
const PAGE = 100
const PAGES = 1000

export type Storage = Pick<Plugin.Context["storage"], "get" | "set" | "remove" | "scan">

/** What the store holds for a job between runs: all of it runtime state, so a file job's file stays the definition. */
export interface JobState {
  readonly job: string
  /** The next slot, as an instant; absent while the schedule has no slot left. */
  readonly nextDueAt?: number
  /** The schedule has no slot left: the job ran its `at`, reached its end or expired. It never runs again. */
  readonly done?: boolean
  /** Finished runs, which `ends.times` counts. */
  readonly runCount: number
  /** The slot of the last run that started, as an ISO time. */
  readonly lastRun?: string
  /** Consecutive slots whose run failed; five pause the job. */
  readonly consecutiveFailures: number
  readonly paused?: { readonly at: number; readonly reason?: string }
  /** The slot the `queue-one` overlap policy remembered. */
  readonly queuedSlot?: number
  /** A retry the policy scheduled for a failed slot: the slot, the attempt it will be, and when it may start. */
  readonly retry?: { readonly slot: number; readonly attempt: number; readonly at: number }
  /** A manual run (`jobs_run_now`): its own slot key, which no scheduled slot consumes or collides with (DR-3). */
  readonly manual?: { readonly at: number }
  /** The approval a script job was given, bound to its source and manifest digests (D-A). Job state, not the file. */
  readonly approval?: ScriptApproval
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "interrupted" | "skipped" | "missed"
export type RunOutcome = "succeeded" | "failed" | "interrupted"
export type SkipReason = "overlap" | "expired" | "ended" | "unguarded" | "missing" | "unapproved" | "revoked"

/** One run, keyed by the job and the slot it belongs to. The slot is the planned time, before jitter. */
export interface RunRecord {
  readonly job: string
  readonly slot: string
  readonly status: RunStatus
  readonly late: boolean
  readonly attempt: number
  /** The leader token that claimed the slot: a write that reads back another token did not win the slot. */
  readonly token?: string
  /**
   * The session the record names. A prompt or command run's own session is `sessionOwned`; a reminder's target is a
   * person's session, which retention must never remove (DR-2).
   */
  readonly sessionID?: string
  /** True only when this plugin created the session for the run. Absent on old records and on a reminder's target. */
  readonly sessionOwned?: boolean
  readonly startedAt?: number
  readonly endedAt?: number
  readonly outcome?: RunOutcome
  /** The last assistant text, capped, and job output rather than instructions. */
  readonly summary?: string
  readonly error?: string
  readonly reason?: SkipReason
  /** A collapsed `missed` record: how many slots it stands for. */
  readonly count?: number
  /** A collapsed `missed` record: its first slot. */
  readonly from?: string
  /** What the run cost, when the host reports it. */
  readonly cost?: number
  /** A script run's source and manifest, never its code: the digest is what the approval is bound to. */
  readonly script?: { readonly sourceHash: string; readonly manifestDigest: string; readonly uses: readonly string[] }
  /** A script run's result, capped; framed as script output, never as an instruction. */
  readonly result?: { readonly ok: boolean; readonly value?: unknown; readonly error?: string }
  /** What each call did, with no payloads (D-C). */
  readonly calls?: readonly ScriptCall[]
  /** Which limit ended the run, when one did. */
  readonly limits?: ScriptLimitFlags
  /** The declared files this run read and wrote: name, path, mode, bytes and hashes, never the content. */
  readonly files?: readonly FileRecord[]
}

export interface Migration {
  /** The schema the store is on now. */
  readonly version: number
  /** The schema it was on, or null when it had none. */
  readonly previous: number | null
}

/**
 * One step per schema version, from the previous one. Version 1 is the first: it only writes the version, so a store
 * from before it (there is none) starts empty. A later version appends a step and raises `SCHEMA_VERSION`.
 */
const MIGRATIONS: Readonly<Record<number, (storage: Storage) => Promise<void>>> = {
  1: async () => undefined,
  // Schema 2 adds a script job's approval to its state and a script run's fields to its record. Both are additive and
  // absent on an older value, so no key is rewritten.
  2: async () => undefined,
}

/** Brings the store to the current schema, once. A store from a newer plugin is refused, never overwritten. */
export async function migrate(storage: Storage): Promise<Migration> {
  const stored = await storage.get(SCHEMA_KEY)
  const previous = typeof stored === "number" && Number.isInteger(stored) && stored >= 0 ? stored : 0
  if (previous > SCHEMA_VERSION) {
    throw jobsError(
      "JOBS_STORAGE_VERSION",
      `The job store uses schema ${previous}, and this build understands schema ${SCHEMA_VERSION}.`,
      `Update the plugin to the version that wrote this store, or clear the plugin's storage to start again.`,
    )
  }
  if (previous === SCHEMA_VERSION) return { version: previous, previous }
  for (let version = previous + 1; version <= SCHEMA_VERSION; version += 1) {
    const step = MIGRATIONS[version]
    if (step === undefined) throw new Error(`jobs: no migration to schema ${version}`)
    await step(storage)
  }
  await storage.set(SCHEMA_KEY, SCHEMA_VERSION)
  return { version: SCHEMA_VERSION, previous: previous === 0 ? null : previous }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const jobKey = (id: string) => `job/${id}`
const stateKey = (id: string) => `state/${id}`
const runKey = (job: string, slot: string) => `run/${job}/${slot}`
const runPrefix = (job?: string) => (job === undefined ? "run/" : `run/${job}/`)

/** Every entry under a prefix, following the host's `next`; a host that repeats a cursor stops the loop. */
async function scanAll(storage: Storage, prefix: string): Promise<{ key: string; value: unknown }[]> {
  const entries: { key: string; value: unknown }[] = []
  let after: string | undefined
  for (let page = 0; page < PAGES; page += 1) {
    const result = await storage.scan({ prefix, limit: PAGE, ...(after === undefined ? {} : { after }) })
    entries.push(...result.entries.map((entry) => ({ key: entry.key, value: entry.value })))
    if (result.next === undefined || result.next === after) break
    after = result.next
  }
  return entries
}

/** The tool jobs the store holds, by id. A value the store did not write is skipped rather than thrown. */
export async function readJobs(storage: Storage): Promise<Job[]> {
  const entries = await scanAll(storage, "job/")
  return entries.flatMap((entry) => (isJob(entry.value) ? [entry.value] : []))
}

/** Stores a job created through a tool. File jobs are never stored: their file is the definition. */
export async function putJob(storage: Storage, job: Job): Promise<void> {
  if (job.source !== "tool") throw new Error(`jobs: only a tool job is stored, and ${job.id} is a ${job.source} job`)
  await storage.set(jobKey(job.id), job as unknown as Parameters<Storage["set"]>[1])
}

/** Removes a tool job and its runtime state. Its run records stay for history and retention. */
export async function removeJob(storage: Storage, id: string): Promise<void> {
  await storage.remove(jobKey(id))
  await storage.remove(stateKey(id))
}

const isJob = (value: unknown): value is Job =>
  isObject(value) &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  typeof value.agent === "string" &&
  isObject(value.schedule) &&
  typeof value.schedule.kind === "string" &&
  isObject(value.action) &&
  typeof value.action.type === "string"

const NO_STATE = (job: string): JobState => ({ job, runCount: 0, consecutiveFailures: 0 })

/** A job's runtime state, with the defaults a job that has never run has. */
export async function readState(storage: Storage, id: string): Promise<JobState> {
  const value = await storage.get(stateKey(id))
  if (!isObject(value)) return NO_STATE(id)
  const pause = isObject(value.paused) && typeof value.paused.at === "number" ? value.paused : undefined
  return {
    job: id,
    runCount: typeof value.runCount === "number" ? value.runCount : 0,
    consecutiveFailures: typeof value.consecutiveFailures === "number" ? value.consecutiveFailures : 0,
    ...(value.done === true ? { done: true } : {}),
    ...(typeof value.nextDueAt === "number" ? { nextDueAt: value.nextDueAt } : {}),
    ...(typeof value.lastRun === "string" ? { lastRun: value.lastRun } : {}),
    ...(typeof value.queuedSlot === "number" ? { queuedSlot: value.queuedSlot } : {}),
    ...(isObject(value.retry) && typeof value.retry.slot === "number" && typeof value.retry.attempt === "number" && typeof value.retry.at === "number"
      ? { retry: { slot: value.retry.slot, attempt: value.retry.attempt, at: value.retry.at } }
      : {}),
    ...(isObject(value.manual) && typeof value.manual.at === "number" ? { manual: { at: value.manual.at } } : {}),
    ...(asApproval(value.approval) === undefined ? {} : { approval: asApproval(value.approval)! }),
    ...(pause === undefined ? {} : { paused: { at: pause.at as number, ...(typeof pause.reason === "string" ? { reason: pause.reason } : {}) } }),
  }
}

/** An approval read back from storage; anything malformed is treated as no approval, so a script fails closed. */
function asApproval(value: unknown): ScriptApproval | undefined {
  if (!isObject(value)) return undefined
  if (typeof value.sourceHash !== "string" || typeof value.manifestDigest !== "string" || typeof value.digest !== "string") return undefined
  if (typeof value.at !== "number" || !Array.isArray(value.resolved)) return undefined
  const resolved = value.resolved.flatMap((entry) => {
    if (!isObject(entry) || typeof entry.method !== "string" || typeof entry.action !== "string" || typeof entry.class !== "string") return []
    if (entry.kind !== "family" && entry.kind !== "host") return []
    if (entry.effect !== "allow" && entry.effect !== "ask" && entry.effect !== "deny") return []
    return [{ method: entry.method, action: entry.action, class: entry.class, kind: entry.kind, effect: entry.effect, ...(typeof entry.description === "string" ? { description: entry.description } : {}) }]
  })
  const files: ResolvedFile[] = Array.isArray(value.files)
    ? value.files.flatMap((entry) => {
        if (!isObject(entry) || typeof entry.name !== "string" || typeof entry.path !== "string") return []
        if (entry.mode !== "read" && entry.mode !== "write" && entry.mode !== "readwrite") return []
        if (entry.format !== "json" && entry.format !== "text") return []
        if (typeof entry.maxBytes !== "number") return []
        return [{ name: entry.name, path: entry.path, mode: entry.mode, format: entry.format, maxBytes: entry.maxBytes } as ResolvedFile]
      })
    : []
  return {
    sourceHash: value.sourceHash,
    manifestDigest: value.manifestDigest,
    filesDigest: typeof value.filesDigest === "string" ? value.filesDigest : "",
    digest: value.digest,
    at: value.at,
    ...(typeof value.requestID === "string" ? { requestID: value.requestID } : {}),
    resolved: resolved as ScriptApproval["resolved"],
    files,
    ...(value.approved === "auto" || value.approved === "prompt" ? { approved: value.approved } : {}),
  }
}

export async function putState(storage: Storage, state: JobState): Promise<void> {
  await storage.set(stateKey(state.job), state as unknown as Parameters<Storage["set"]>[1])
}

/** One promise chain per job **per store**: every state mutation is a read-modify-write inside it (DR-13). A chain that
 * belongs to one store keeps two hosts in one process from waiting on each other's writes. */
const CHAINS = new WeakMap<object, Map<string, Promise<unknown>>>()

function chainsOf(storage: Storage): Map<string, Promise<unknown>> {
  const found = CHAINS.get(storage)
  if (found !== undefined) return found
  const created = new Map<string, Promise<unknown>>()
  CHAINS.set(storage, created)
  return created
}

/**
 * Changes a job's state atomically as far as one process can: the change runs after every earlier one for that job, on
 * a fresh read. The runner, the tools and the commands all come through here, so a pause landing next to a run's finish
 * cannot lose a counter, and a run-now cannot drop a queued slot.
 */
export function updateState(storage: Storage, id: string, change: (state: JobState) => JobState): Promise<JobState> {
  const chains = chainsOf(storage)
  const previous = chains.get(id) ?? Promise.resolve()
  const next = previous.then(
    async () => {
      const updated = change(await readState(storage, id))
      await putState(storage, updated)
      return updated
    },
    async () => {
      const updated = change(await readState(storage, id))
      await putState(storage, updated)
      return updated
    },
  )
  chains.set(id, next.then(() => undefined, () => undefined))
  return next
}

/** The canonical key time: an ISO instant in UTC, which also sorts chronologically. */
export function slotISO(slot: number): string {
  return new Date(slot).toISOString()
}

/** Writes a run record, with its slot canonicalised and its summary capped. */
export async function putRun(storage: Storage, record: RunRecord): Promise<RunRecord> {
  const at = Date.parse(record.slot)
  if (!Number.isFinite(at)) throw new Error(`jobs: the run slot ${JSON.stringify(record.slot)} is not a time`)
  const stored: RunRecord = {
    ...record,
    slot: slotISO(at),
    ...(record.summary === undefined ? {} : { summary: cut(record.summary, SUMMARY_LIMIT) }),
    ...(record.error === undefined ? {} : { error: cut(record.error, ERROR_LIMIT) }),
  }
  await storage.set(runKey(stored.job, stored.slot), stored as unknown as Parameters<Storage["set"]>[1])
  return stored
}

export async function getRun(storage: Storage, job: string, slot: string): Promise<RunRecord | undefined> {
  return asRun(await storage.get(runKey(job, slot)))
}

export async function removeRun(storage: Storage, record: Pick<RunRecord, "job" | "slot">): Promise<void> {
  await storage.remove(runKey(record.job, record.slot))
}

/** One job's runs, or every job's, newest first. */
export async function scanRuns(storage: Storage, job?: string): Promise<RunRecord[]> {
  const entries = await scanAll(storage, runPrefix(job))
  return entries
    .flatMap((entry) => {
      const record = asRun(entry.value)
      return record === undefined ? [] : [record]
    })
    .sort((left, right) => Date.parse(right.slot) - Date.parse(left.slot))
}

function asRun(value: unknown): RunRecord | undefined {
  if (!isObject(value) || typeof value.job !== "string" || typeof value.slot !== "string" || typeof value.status !== "string") return undefined
  if (!Number.isFinite(Date.parse(value.slot))) return undefined
  return value as unknown as RunRecord
}

export interface Pruned {
  readonly keep: readonly RunRecord[]
  readonly remove: readonly RunRecord[]
}

/**
 * What retention keeps: the last `MAX_RUNS` runs of each job that are also within `RETENTION_MS`, plus a record that is
 * `running` and the job's newest run, which `jobs_get` always has something to show for. Everything else is removed.
 */
export function pruneRuns(records: readonly RunRecord[], now: number): Pruned {
  const cutoff = now - RETENTION_MS
  const groups = new Map<string, RunRecord[]>()
  for (const record of records) {
    const group = groups.get(record.job)
    if (group === undefined) groups.set(record.job, [record])
    else group.push(record)
  }
  const keep = new Set<RunRecord>()
  for (const group of groups.values()) {
    const newestFirst = [...group].sort((left, right) => Date.parse(right.slot) - Date.parse(left.slot))
    newestFirst.forEach((record, index) => {
      if (index < MAX_RUNS && runTime(record) >= cutoff) keep.add(record)
    })
    keep.add(newestFirst[0]!)
    for (const record of newestFirst) if (record.status === "running") keep.add(record)
  }
  return {
    keep: records.filter((record) => keep.has(record)),
    remove: records.filter((record) => !keep.has(record)),
  }
}

const runTime = (record: RunRecord) => record.endedAt ?? record.startedAt ?? Date.parse(record.slot)

/** Removes the records retention drops and returns them, so their sessions can go with them. */
export async function prune(storage: Storage, now: number): Promise<Pruned> {
  const pruned = pruneRuns(await scanRuns(storage), now)
  for (const record of pruned.remove) await removeRun(storage, record)
  return pruned
}

/** What retention removed in one pass: the run records, and the sessions that went with them. */
export interface PruneReport {
  readonly removed: readonly RunRecord[]
  readonly sessions: readonly string[]
  /** Sessions a removed record named but which are still busy, so they stay. */
  readonly keptBusy: readonly string[]
}

/**
 * Retention with its sessions (D9): a record retention drops loses its session too, unless that session is still busy.
 * A session OpenCode no longer has is nothing to remove. Called by the leader on start and once an hour after.
 */
export async function pruneWithSessions(
  storage: Storage,
  session: { get: (input: { sessionID: string }) => Promise<{ outcome?: unknown }>; remove: (input: { sessionID: string }) => Promise<unknown> },
  now: number,
): Promise<PruneReport> {
  const pruned = await prune(storage, now)
  const sessions: string[] = []
  const keptBusy: string[] = []
  for (const record of pruned.remove) {
    // Only a session this plugin created for the run may be removed: a reminder's target is a person's (DR-2), and an
    // old record without the flag is treated as not owned.
    if (record.sessionID === undefined || record.sessionOwned !== true) continue
    const info = await session.get({ sessionID: record.sessionID }).catch(() => undefined)
    if (info !== undefined && info.outcome === undefined) {
      keptBusy.push(record.sessionID)
      continue
    }
    if (info === undefined) continue
    await session.remove({ sessionID: record.sessionID }).catch(() => undefined)
    sessions.push(record.sessionID)
  }
  return { removed: pruned.remove, sessions, keptBusy }
}

/** What the leader's loop last did: it is the status `Runner` row, and how a stop is told from a running runner. */
export interface RunnerRecord {
  readonly startedAt: number
  readonly stoppedAt?: number
  readonly location: string
  readonly pid: number
}

const RUNNER_KEY = "runner"

export async function readRunner(storage: Storage): Promise<RunnerRecord | undefined> {
  const value = await storage.get(RUNNER_KEY)
  if (!isObject(value) || typeof value.startedAt !== "number" || typeof value.location !== "string") return undefined
  return {
    startedAt: value.startedAt,
    location: value.location,
    pid: typeof value.pid === "number" ? value.pid : 0,
    ...(typeof value.stoppedAt === "number" ? { stoppedAt: value.stoppedAt } : {}),
  }
}

export async function putRunner(storage: Storage, record: RunnerRecord): Promise<void> {
  await storage.set(RUNNER_KEY, record as unknown as Parameters<Storage["set"]>[1])
}

/**
 * The kill switch, as storage state: one record that stops every job at once, whichever leader is running and whether
 * or not anyone has a tool at hand. Setting it interrupts what is in flight and starts nothing new; clearing it lets
 * the schedule resume, with the usual catch-up for the slots that fell due while it was set.
 */
export interface PauseRecord {
  /** When the pause was set. */
  readonly at: number
  /** Why, in one line; absent for the documented pause. */
  readonly reason?: string
}

const PAUSE_KEY = "pause/all"

export async function readPauseAll(storage: Storage): Promise<PauseRecord | undefined> {
  const value = await storage.get(PAUSE_KEY)
  if (!isObject(value) || typeof value.at !== "number") return undefined
  return { at: value.at, ...(typeof value.reason === "string" ? { reason: value.reason } : {}) }
}

/** Sets or clears the pause, and returns what is stored afterwards. */
export async function setPauseAll(storage: Storage, paused: boolean, at: number, reason?: string): Promise<PauseRecord | undefined> {
  if (!paused) {
    await storage.remove(PAUSE_KEY)
    return undefined
  }
  const record: PauseRecord = { at, ...(reason === undefined ? {} : { reason }) }
  await storage.set(PAUSE_KEY, record as unknown as Parameters<Storage["set"]>[1])
  return record
}

/** The last keep-alive beat, so the `Liveness` row says whether the location is still being held open. */
export interface BeatRecord {
  readonly at: number
  readonly ok: boolean
}

const BEAT_KEY = "keepalive"

export async function readBeat(storage: Storage): Promise<BeatRecord | undefined> {
  const value = await storage.get(BEAT_KEY)
  if (!isObject(value) || typeof value.at !== "number") return undefined
  return { at: value.at, ok: value.ok === true }
}

export async function putBeat(storage: Storage, beat: BeatRecord): Promise<void> {
  await storage.set(BEAT_KEY, beat as unknown as Parameters<Storage["set"]>[1])
}
