/**
 * What the surfaces report: the status model, the jobs list and the run history, read from the store each time.
 *
 * One place gathers, so `/jobs-status`, the dialog, the status RPC and the `jobs_status` tool cannot disagree. Nothing
 * here writes, and nothing here names a prompt or a transcript: a run is its outcome, its times and its summary, and a
 * summary is framed as job output (never as an instruction). A job the store no longer holds keeps its runs, named by
 * its id.
 */
import type { Plugin } from "@opencode/plugin"
import { refusalFor, unguardedAgents, type AgentInfo } from "../host/permissions.js"
import {
  buildStatus,
  compactStatus,
  type CompactStatus,
  type FailureView,
  type JobsCount,
  type NextRunView,
  type RunnerView,
  type RunView,
  type Status,
} from "../status.js"
import type { HostCheck } from "../host-version.js"
import type { Clock } from "./clock.js"
import { nextRun } from "./cron.js"
import { readJobFiles, type AgentGuard, type JobFiles } from "./files.js"
import type { Job } from "./model.js"
import { jobOutput } from "./safety.js"
import { readBeat, readJobs, readPauseAll, readRunner, readState, scanRuns, type RunRecord } from "./store.js"

/** What a report reads: the store, the location, the clock, and the agents the files are checked against. */
export interface ReportInput {
  readonly storage: Pick<Plugin.Context["storage"], "get" | "set" | "remove" | "scan">
  readonly location: string
  readonly timezone: string
  readonly clock: Clock
  readonly agent: Pick<Plugin.Context["agent"], "list">
  readonly host: HostCheck
  readonly enabled: boolean
  readonly keepAliveMinutes: number
  /** Setup problems that are not a file's, such as a store from a newer build. */
  readonly problems?: readonly string[]
}

/** Every job this instance knows, and what the file reader refused. */
export interface Source {
  readonly files: JobFiles
  /** The store's tool jobs, with a file job of the same id winning, because the file is the definition a project commits. */
  readonly jobs: readonly Job[]
  readonly agents: readonly AgentInfo[]
  readonly guard?: AgentGuard
}

/** One job as `jobs_list` and the RPC's `list` name it, or one refused file, which is not a job at all. */
export interface JobView {
  readonly id: string
  readonly name: string
  readonly source: "file" | "tool"
  /** Active, paused, expired (its time, end or expiry is spent), or invalid (a file that was refused). */
  readonly state: "active" | "paused" | "expired" | "invalid"
  readonly agent?: string
  readonly schedule?: Job["schedule"]
  readonly action?: Job["action"]["type"]
  readonly nextRunAt?: number
  readonly lastRunAt?: string
  readonly expires?: number
  /** A refused file's coded message, with its path and the line at fault. */
  readonly message?: string
}

/** What `jobs_history` and the RPC's `history` return. */
export type RunViewWithSummary = RunView

const RECENT = 10
const NEXT = 5
const TOP_FAILURES = 5

/** The agents as the host reports them now; an empty list means no check, and the evaluate hook is the backstop. */
export async function readAgents(agent: Pick<Plugin.Context["agent"], "list">): Promise<readonly AgentInfo[]> {
  return agent.list().then(
    (found) => found.data,
    () => [],
  )
}

/** Every job this instance knows, read now: a refused file is reported, never thrown, and never becomes a job. */
export async function readSource(input: Omit<ReportInput, "host" | "enabled" | "keepAliveMinutes">): Promise<Source> {
  const agents = await readAgents(input.agent)
  const guard = agents.length === 0 ? undefined : (id: string) => refusalFor(agents, id)
  const stored = await readJobs(input.storage).catch(() => [])
  const files = await readJobFiles({
    now: input.clock.now(),
    timezone: input.timezone,
    projects: [input.location],
    ...(guard === undefined ? {} : { guard }),
  }).catch(() => ({ jobs: [], invalid: [], refused: [] }))
  const byId = new Map(files.jobs.map((job) => [job.id, job] as const))
  for (const job of stored) if (!byId.has(job.id)) byId.set(job.id, job)
  return { files, jobs: [...byId.values()], agents, ...(guard === undefined ? {} : { guard }) }
}

export interface HistoryInput {
  readonly id?: string
  readonly limit?: number
  readonly since?: string
}

export interface Report {
  status(): Promise<Status>
  compact(): Promise<CompactStatus>
  list(input?: { readonly state?: JobView["state"]; readonly limit?: number }): Promise<readonly JobView[]>
  history(input?: HistoryInput): Promise<readonly RunViewWithSummary[]>
  /** The jobs as the runner and the tools see them, with the source they came from. */
  source(): Promise<Source>
}

export function createReport(input: ReportInput): Report {
  const source = () => readSource(input)

  const jobView = async (job: Job, now: number): Promise<JobView> => {
    const state = await readState(input.storage, job.id)
    const expired = job.expires !== undefined && now >= job.expires
    const view = state.paused !== undefined ? "paused" : expired || state.done === true ? "expired" : "active"
    const at = view === "active" ? (state.nextDueAt ?? nextRun(job.schedule, now) ?? undefined) : undefined
    return {
      id: job.id,
      name: job.name,
      source: job.source,
      agent: job.agent,
      state: view,
      schedule: job.schedule,
      action: job.action.type,
      ...(at === undefined ? {} : { nextRunAt: at }),
      ...(state.lastRun === undefined ? {} : { lastRunAt: state.lastRun }),
      ...(job.expires === undefined ? {} : { expires: job.expires }),
    }
  }

  const status = async (): Promise<Status> => {
    const now = input.clock.now()
    const { files, jobs, agents } = await source()
    const names = new Map(jobs.map((job) => [job.id, job.name] as const))
    const states = new Map(await Promise.all(jobs.map(async (job) => [job.id, await readState(input.storage, job.id)] as const)))
    const records = await scanRuns(input.storage).catch(() => [])

    let pausedJobs = 0
    let expiring = 0
    const nextRuns: NextRunView[] = []
    for (const job of jobs) {
      const state = states.get(job.id)!
      if (state.paused !== undefined) pausedJobs += 1
      if (job.expires !== undefined && job.expires > now) expiring += 1
      if (state.paused !== undefined || state.done === true) continue
      if (job.expires !== undefined && now >= job.expires) continue
      const at = state.nextDueAt ?? nextRun(job.schedule, now)
      if (at !== null) nextRuns.push({ id: job.id, name: job.name, at })
    }
    nextRuns.sort((left, right) => left.at - right.at)

    const counts: JobsCount = { total: jobs.length, paused: pausedJobs, expiring, invalidFiles: files.invalid.length }
    const runner = await readRunner(input.storage).catch(() => undefined)
    const beat = await readBeat(input.storage).catch(() => undefined)
    const paused = await readPauseAll(input.storage).catch(() => undefined)
    const runnerView: RunnerView | null =
      runner === undefined ? null : { location: runner.location, pid: runner.pid, since: runner.startedAt, ...(runner.stoppedAt === undefined ? {} : { stoppedAt: runner.stoppedAt }) }

    return buildStatus({
      host: input.host,
      enabled: input.enabled,
      keepAliveMinutes: input.keepAliveMinutes,
      jobs: counts,
      runner: runnerView,
      liveness: { everyMinutes: input.keepAliveMinutes, ...(beat === undefined ? {} : { lastBeatAt: beat.at, lastBeatOk: beat.ok }) },
      ...(paused === undefined ? {} : { paused }),
      nextRuns: nextRuns.slice(0, NEXT),
      recentRuns: records.slice(0, RECENT).map((record) => runView(record, names)),
      failures: failuresOf(records, names),
      unguardedAgents: unguardedAgents(agents, [...jobs.map((job) => job.agent), ...files.refused]),
      problems: [...(input.problems ?? []), ...files.invalid.map((file) => file.message)],
    })
  }

  const list = async (filter: { readonly state?: JobView["state"]; readonly limit?: number } = {}): Promise<readonly JobView[]> => {
    const now = input.clock.now()
    const { jobs, files } = await source()
    const invalid: JobView[] = files.invalid.map((file) => ({ id: file.path, name: file.path, source: "file", state: "invalid", message: file.message }))
    const views = [...(await Promise.all(jobs.map((job) => jobView(job, now)))), ...invalid]
    const matching = filter.state === undefined ? views : views.filter((view) => view.state === filter.state)
    return matching.sort((left, right) => left.name.localeCompare(right.name)).slice(0, Math.max(1, Math.min(100, filter.limit ?? 100)))
  }

  const history = async (filter: HistoryInput = {}): Promise<readonly RunViewWithSummary[]> => {
    const { jobs } = await source()
    const names = new Map(jobs.map((job) => [job.id, job.name] as const))
    const since = filter.since === undefined ? undefined : Date.parse(filter.since)
    const records = (await scanRuns(input.storage, filter.id)).filter((record) => since === undefined || !Number.isFinite(since) || Date.parse(record.slot) >= since)
    return records.slice(0, Math.max(1, Math.min(50, filter.limit ?? 20))).map((record) => runView(record, names))
  }

  return {
    status,
    compact: () => status().then((model) => compactStatus(model)),
    list,
    history,
    source,
  }
}

/** One run, as the surfaces name it: its job's name now, or its id when the job is gone. */
export function runView(record: RunRecord, names: ReadonlyMap<string, string>): RunView {
  const name = names.get(record.job) ?? record.job
  const durationMs = record.startedAt !== undefined && record.endedAt !== undefined ? Math.max(0, record.endedAt - record.startedAt) : undefined
  return {
    job: record.job,
    name,
    slot: record.slot,
    status: record.status,
    ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
    ...(durationMs === undefined ? {} : { durationMs }),
    late: record.late,
    attempt: record.attempt,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.count === undefined ? {} : { count: record.count }),
    ...(record.summary === undefined ? {} : { summary: jobOutput(record.summary, { name, at: record.slot }) }),
  }
}

/** The failures that need attention: per job, its failed and timed-out runs, with the code and how many. */
function failuresOf(records: readonly RunRecord[], names: ReadonlyMap<string, string>): readonly FailureView[] {
  const counted = new Map<string, FailureView>()
  for (const record of records) {
    if (record.status !== "failed" && record.status !== "timed_out") continue
    const code = record.error === undefined ? (record.status === "timed_out" ? "JOBS_TIMEOUT" : "JOBS_INVALID_JOB") : (record.error.split(":")[0] ?? record.status)
    const id = `${record.job}\u0000${code}`
    const found = counted.get(id)
    const name = names.get(record.job) ?? record.job
    counted.set(id, found === undefined ? { name, code, count: 1 } : { ...found, count: found.count + 1 })
  }
  return [...counted.values()].sort((left, right) => right.count - left.count).slice(0, TOP_FAILURES)
}
