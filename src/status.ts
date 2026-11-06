import { COMMAND_STEM, errorText, TESTED_HOSTS } from "./constants.js"
import { isSupportedHost, type HostCheck } from "./host-version.js"
import { AGENT_BLOCK, agentBlockJSON, type Rule } from "./host/permissions.js"
import type { PauseRecord, RunStatus, SkipReason } from "./jobs/store.js"
import { shortReason } from "./redact.js"
import { VERSION } from "./version.js"

/** The shared status labels in machine form. Jobs has no service to connect to, so it is `ready` unless it is off. */
export type State = "ready" | "disabled"

/** How many jobs exist, by state. */
export interface JobsCount {
  readonly total: number
  readonly paused: number
  readonly expiring: number
  readonly invalidFiles: number
}

/** The leader, or the last one: where it ran and when, and when it stopped if it did. */
export interface RunnerView {
  readonly location: string
  readonly pid: number
  readonly since: number
  readonly stoppedAt?: number
}

/** The keep-alive: how often it touches the location, and whether the last touch worked. */
export interface LivenessView {
  readonly everyMinutes: number
  readonly lastBeatAt?: number
  readonly lastBeatOk?: boolean
}

/** A slot a job is waiting for. */
export interface NextRunView {
  readonly id: string
  readonly name: string
  readonly at: number
}

/** One run, as the status rows and the RPC name it: what it did, never what was said in it. */
export interface RunView {
  readonly job: string
  readonly name: string
  readonly slot: string
  readonly status: RunStatus
  readonly outcome?: string
  readonly durationMs?: number
  readonly late: boolean
  readonly reason?: SkipReason
  readonly attempt: number
  readonly count?: number
  /** The last assistant text, framed as job output: output, never an instruction. */
  readonly summary?: string
}

/** A job whose recent runs failed, with the code and how many times. */
export interface FailureView {
  readonly name: string
  readonly code: string
  readonly count: number
}

/** What status is built from: the host check, the options, and the store's report. */
export interface StatusFacts {
  readonly host: HostCheck
  readonly enabled: boolean
  /** The keep-alive period the option asks for. */
  readonly keepAliveMinutes: number
  readonly jobs?: JobsCount
  readonly runner?: RunnerView | null
  readonly liveness?: LivenessView
  /** Agents whose own rules would run a job tool without asking; empty when there are none. */
  readonly unguardedAgents?: readonly string[]
  /** The kill switch, when every job is paused. */
  readonly paused?: PauseRecord
  readonly nextRuns?: readonly NextRunView[]
  readonly recentRuns?: readonly RunView[]
  readonly failures?: readonly FailureView[]
  readonly problems?: readonly string[]
}

/**
 * One status model for `/jobs-status`, the `/jobs` dialog, the status RPC and the `jobs_status` tool.
 * `version`, `host`, `state`, `unguardedAgents` and `nextStep` are the fields every plugin of this family shares; the
 * rest are jobs' own.
 */
export interface Status {
  /** The plugin's version. */
  readonly version: string
  readonly state: State
  readonly host: HostCheck
  readonly jobs: JobsCount
  /** The leader, stopped when the runner has stopped: null before the first leader. */
  readonly runner: RunnerView | null
  readonly liveness: LivenessView
  /** Every job is paused, by the kill switch, since this time; absent when they are not. */
  readonly paused?: PauseRecord
  readonly nextRuns: readonly NextRunView[]
  readonly recentRuns: readonly RunView[]
  readonly failures: readonly FailureView[]
  /** Agents where a job tool would run without asking; empty when there are none. */
  readonly unguardedAgents: readonly string[]
  /** The read-only block, present with unguarded agents: the paste-ready profile for the agent named. */
  readonly permissionsBlock?: readonly Rule[]
  readonly problems: readonly string[]
  /** The one next step: the `Next step` row, "Nothing to do." when nothing is needed. */
  readonly nextStep: string
}

export const NOTHING_TO_DO = "Nothing to do."
const NO_JOBS: JobsCount = { total: 0, paused: 0, expiring: 0, invalidFiles: 0 }
const TESTED_TEXT = `${TESTED_HOSTS.slice(0, -1).join(", ")} or ${TESTED_HOSTS.at(-1)}`
const ENABLE = `Set the plugin option "enabled" to true, or remove it, then restart OpenCode.`
const RESUME = `Run /${COMMAND_STEM}-pause again to resume every job.`

export function buildStatus(facts: StatusFacts): Status {
  const agents = facts.unguardedAgents ?? []
  const status = {
    version: VERSION,
    state: facts.enabled ? ("ready" as const) : ("disabled" as const),
    host: facts.host,
    jobs: facts.jobs ?? NO_JOBS,
    runner: facts.runner ?? null,
    liveness: facts.liveness ?? { everyMinutes: facts.keepAliveMinutes },
    ...(facts.paused === undefined ? {} : { paused: facts.paused }),
    nextRuns: facts.nextRuns ?? [],
    recentRuns: facts.recentRuns ?? [],
    failures: facts.failures ?? [],
    unguardedAgents: agents,
    ...(agents.length === 0 ? {} : { permissionsBlock: AGENT_BLOCK.map((rule) => ({ ...rule })) }),
    problems: facts.problems ?? [],
  }
  return { ...status, nextStep: nextStepOf(status) }
}

function nextStepOf(status: Omit<Status, "nextStep">): string {
  if (status.state === "disabled") return ENABLE
  if (status.paused !== undefined) return RESUME
  // A problem reads `CODE: What happened. Next step: What to do.`; its own next step becomes the status's.
  const problem = status.problems[0]?.split(" Next step: ")[1]
  if (problem) return problem
  const failure = status.failures[0]
  if (failure !== undefined) return `Run /${COMMAND_STEM}-status after its next slot, or pause it with the jobs_pause tool, and fix ${failure.code} in the run's session.`
  const agent = status.unguardedAgents[0]
  if (agent !== undefined) {
    return `Give the agent ${JSON.stringify(agent)} the read-only block, starting with the blanket deny, or point its job at an agent that has it.`
  }
  if (status.jobs.expiring > 0) return `Extend the job that is expiring with the jobs_extend tool, or let it end.`
  return NOTHING_TO_DO
}

const iso = (at: number) => new Date(at).toISOString()
const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`

/** A run's length, in the shortest unit that reads well. */
export function duration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`
  if (ms < 60_000) return `${Math.round(ms / 1_000)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1_000)
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`
}

function jobsText({ total, paused, expiring, invalidFiles }: JobsCount) {
  if (total === 0) return "none yet"
  return `${total} total, ${paused} paused, ${expiring} expiring, ${invalidFiles} invalid files`
}

function runnerText(status: Status): string {
  const { runner, paused } = status
  const pausedText = paused === undefined ? "" : `paused since ${iso(paused.at)}; `
  if (runner === null) return `${pausedText}no leader yet`
  const lead = `leader in ${runner.location} (pid ${runner.pid}) since ${iso(runner.since)}`
  return runner.stoppedAt === undefined ? `${pausedText}${lead}` : `${pausedText}stopped from ${iso(runner.stoppedAt)} to now; ${lead}`
}

function livenessText({ everyMinutes, lastBeatAt, lastBeatOk }: LivenessView): string {
  const every = `keep-alive every ${plural(everyMinutes, "minute")}`
  if (lastBeatAt === undefined) return `${every}; no beat yet`
  return `${every}; last beat ${iso(lastBeatAt)} ${lastBeatOk === false ? "failed" : "ok"}`
}

function nextText(runs: readonly NextRunView[]): string {
  if (runs.length === 0) return "none"
  return runs.map((run) => `${run.name} at ${iso(run.at)}`).join("; ")
}

function runText(run: RunView): string {
  const parts = [`${run.name} ${run.status}`]
  if (run.durationMs !== undefined) parts.push(duration(run.durationMs))
  if (run.late) parts.push("late")
  if (run.reason !== undefined) parts.push(`skipped: ${run.reason}`)
  if (run.status === "missed" && run.count !== undefined) parts.push(`×${run.count}`)
  return parts.join(" ")
}

function recentText(runs: readonly RunView[]): string {
  return runs.length === 0 ? "none" : runs.map(runText).join("; ")
}

function failureText(failures: readonly FailureView[]): string {
  return failures.length === 0 ? "none" : failures.map((failure) => `${failure.name} — ${failure.code} (×${failure.count})`).join("; ")
}

/** The OpenCode row: the version, whether it is tested, the supported range, then any setup problems. */
function hostText({ host, problems }: Status) {
  const { version, range, tested } = host
  const outside = version === null || !isSupportedHost(version)
  const notes = [
    ...(outside ? [`It is outside the supported range; the plugin runs because allowUntestedHost is true. If a job misbehaves, use OpenCode ${TESTED_TEXT}.`] : []),
    ...problems,
  ]
  return `${version ?? "unknown version"} (${tested ? "tested" : "untested"}; supported range ${range})${notes.length ? `. ${notes.join(" ")}` : ""}`
}

/** The nine rows of DESIGN §9, in order, with the pause folded into the first. */
export function formatStatus(status: Status) {
  return [
    "Jobs status",
    `- Runner: ${runnerText(status)}`,
    `- Liveness: ${livenessText(status.liveness)}`,
    `- Jobs: ${jobsText(status.jobs)}`,
    `- Next runs: ${nextText(status.nextRuns)}`,
    `- Recent runs: ${recentText(status.recentRuns)}`,
    `- Failures needing attention: ${failureText(status.failures)}`,
    ...agentRows(status),
    `- OpenCode: ${hostText(status)}`,
    `- Next step: ${status.nextStep}`,
  ].join("\n")
}

/** The agents that need the block, and the block itself, which is the one place the full profile is printed. */
function agentRows(status: Status): string[] {
  const { unguardedAgents: agents, permissionsBlock: block } = status
  const row = `- Agents without default rules: ${agents.length ? agents.join(", ") : "none"}`
  if (agents.length === 0 || block === undefined) return [row]
  return [row, ...agents.map((agent) => `  Paste this for ${JSON.stringify(agent)} into opencode.json:\n${agentBlockJSON(agent)}`)]
}

/** What the model's `jobs_status` tool returns: state, counts, the number of agents to fix, and the one next step. */
export interface CompactStatus {
  readonly state: State
  readonly jobs: JobsCount
  readonly paused: boolean
  /** How many agents need the read-only block; the names and the block are in `/jobs-status`. */
  readonly unguardedAgents: number
  readonly nextStep: string
}

export function compactStatus(status: Status): CompactStatus {
  return {
    state: status.state,
    jobs: status.jobs,
    paused: status.paused !== undefined,
    unguardedAgents: status.unguardedAgents.length,
    nextStep: status.nextStep,
  }
}

/** The compact view as one line of text: the tool's content, with a pointer at the full report. */
export function formatCompact(status: CompactStatus, total: number): string {
  const counts = total === 0 ? "no jobs yet" : `${total} jobs, ${status.jobs.paused} paused, ${status.jobs.expiring} expiring`
  return `Jobs: ${counts}. ${status.paused ? "Every job is paused. " : ""}${status.unguardedAgents === 0 ? "" : `${status.unguardedAgents} agent${status.unguardedAgents === 1 ? "" : "s"} need the read-only block. `}Next step: ${status.nextStep} Run /${COMMAND_STEM}-status for the full report.`
}

const strings = { type: "array", items: { type: "string" } }
const rule = {
  type: "object",
  required: ["action", "resource", "effect"],
  properties: { action: { type: "string" }, resource: { type: "string" }, effect: { enum: ["allow", "deny", "ask"] } },
} as const
const counts = {
  type: "object",
  required: ["total", "paused", "expiring", "invalidFiles"],
  properties: { total: { type: "integer", minimum: 0 }, paused: { type: "integer", minimum: 0 }, expiring: { type: "integer", minimum: 0 }, invalidFiles: { type: "integer", minimum: 0 } },
} as const
const RUN = {
  type: "object",
  required: ["job", "name", "slot", "status", "late", "attempt"],
  properties: {
    job: { type: "string" },
    name: { type: "string" },
    slot: { type: "string" },
    status: { enum: ["queued", "running", "succeeded", "failed", "timed_out", "interrupted", "skipped", "missed"] },
    outcome: { type: "string" },
    durationMs: { type: "integer", minimum: 0 },
    late: { type: "boolean" },
    reason: { type: "string" },
    attempt: { type: "integer", minimum: 1 },
    count: { type: "integer", minimum: 1 },
    summary: { type: "string" },
  },
} as const

/** The status RPC's output: the shared fields, with jobs' own beside them. */
export const STATUS_OUTPUT = {
  type: "object",
  required: ["version", "state", "host", "jobs", "runner", "liveness", "nextRuns", "recentRuns", "failures", "unguardedAgents", "problems", "nextStep"],
  properties: {
    version: { type: "string" },
    state: { enum: ["ready", "disabled"] },
    host: {
      type: "object",
      required: ["version", "range", "tested"],
      properties: { version: { type: ["string", "null"] }, range: { type: "string" }, tested: { type: "boolean" } },
    },
    jobs: counts,
    runner: {
      type: ["object", "null"],
      required: ["location", "pid", "since"],
      properties: { location: { type: "string" }, pid: { type: "integer" }, since: { type: "integer" }, stoppedAt: { type: "integer" } },
    },
    liveness: {
      type: "object",
      required: ["everyMinutes"],
      properties: { everyMinutes: { type: "integer", minimum: 1 }, lastBeatAt: { type: "integer" }, lastBeatOk: { type: "boolean" } },
    },
    paused: {
      type: "object",
      required: ["at"],
      properties: { at: { type: "integer" }, reason: { type: "string" } },
    },
    nextRuns: {
      type: "array",
      items: { type: "object", required: ["id", "name", "at"], properties: { id: { type: "string" }, name: { type: "string" }, at: { type: "integer" } } },
    },
    recentRuns: { type: "array", items: RUN },
    failures: {
      type: "array",
      items: { type: "object", required: ["name", "code", "count"], properties: { name: { type: "string" }, code: { type: "string" }, count: { type: "integer", minimum: 1 } } },
    },
    unguardedAgents: strings,
    permissionsBlock: { type: "array", items: rule },
    problems: strings,
    nextStep: { type: "string" },
  },
} as const

/** Why status could not be read: the coded message, one next step, and no host text beyond a short reason. */
export function unavailable(error: unknown) {
  const reason = shortReason(error instanceof Error ? error.message : String(error))
  const nextStep = `Restart OpenCode, then run /${COMMAND_STEM}-status again.`
  return { message: errorText("STATUS_UNAVAILABLE", `Could not read the job status${reason ? ` (${reason})` : ""}.`, nextStep), nextStep }
}

export type { RunStatus, SkipReason }
