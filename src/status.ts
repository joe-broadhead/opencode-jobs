import type { Plugin } from "@opencode/plugin"
import { COMMAND_STEM, errorText, TESTED_HOSTS } from "./constants.js"
import { isSupportedHost, type HostCheck } from "./host-version.js"
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

/** What status is built from: the host check and the option that stops the runner. The store fills the counts. */
export interface StatusFacts {
  readonly host: HostCheck
  readonly enabled: boolean
  readonly jobs?: JobsCount
  /** Agents whose own rules would run a job tool without asking; empty when there are none. */
  readonly unguardedAgents?: readonly string[]
  readonly problems?: readonly string[]
}

/**
 * One status model for `/jobs-status`, the `/jobs` dialog and the status RPC. `version`, `host`, `state`,
 * `unguardedAgents` and `nextStep` are the fields every plugin of this family shares; the rest are jobs' own.
 */
export interface Status {
  /** The plugin's version. */
  readonly version: string
  readonly state: State
  readonly host: HostCheck
  readonly jobs: JobsCount
  /** Agents where a job tool would run without asking; empty when there are none. */
  readonly unguardedAgents: readonly string[]
  readonly problems: readonly string[]
  /** The one next step: the `Next step` row, "Nothing to do." when nothing is needed. */
  readonly nextStep: string
}

export const NOTHING_TO_DO = "Nothing to do."
const NO_JOBS: JobsCount = { total: 0, paused: 0, expiring: 0, invalidFiles: 0 }
const TESTED_TEXT = `${TESTED_HOSTS.slice(0, -1).join(", ")} or ${TESTED_HOSTS.at(-1)}`
const ENABLE = `Set the plugin option "enabled" to true, or remove it, then restart OpenCode.`

export function buildStatus(facts: StatusFacts): Status {
  const status = {
    version: VERSION,
    state: facts.enabled ? ("ready" as const) : ("disabled" as const),
    host: facts.host,
    jobs: facts.jobs ?? NO_JOBS,
    unguardedAgents: facts.unguardedAgents ?? [],
    problems: facts.problems ?? [],
  }
  return { ...status, nextStep: nextStepOf(status) }
}

function nextStepOf(status: Omit<Status, "nextStep">): string {
  if (status.state === "disabled") return ENABLE
  // A problem reads `CODE: What happened. Next step: What to do.`; its own next step becomes the status's.
  const problem = status.problems[0]?.split(" Next step: ")[1]
  if (problem) return problem
  return NOTHING_TO_DO
}

function jobsText({ total, paused, expiring, invalidFiles }: JobsCount) {
  if (total === 0) return "none yet"
  return `${total} total, ${paused} paused, ${expiring} expiring, ${invalidFiles} invalid files`
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

export function formatStatus(status: Status) {
  const { unguardedAgents: agents } = status
  return [
    "Jobs status",
    `- Jobs: ${jobsText(status.jobs)}`,
    "- Next runs: none",
    "- Recent runs: none",
    `- Agents without default rules: ${agents.length ? agents.join(", ") : "none"}`,
    `- OpenCode: ${hostText(status)}`,
    `- Next step: ${status.nextStep}`,
  ].join("\n")
}

const strings = { type: "array", items: { type: "string" } }

/** The status RPC's output: the shared fields, with jobs' own beside them. */
export const STATUS_OUTPUT = {
  type: "object",
  required: ["version", "state", "host", "jobs", "unguardedAgents", "problems", "nextStep"],
  properties: {
    version: { type: "string" },
    state: { enum: ["ready", "disabled"] },
    host: {
      type: "object",
      required: ["version", "range", "tested"],
      properties: { version: { type: ["string", "null"] }, range: { type: "string" }, tested: { type: "boolean" } },
    },
    jobs: {
      type: "object",
      required: ["total", "paused", "expiring", "invalidFiles"],
      properties: { total: { type: "integer", minimum: 0 }, paused: { type: "integer", minimum: 0 }, expiring: { type: "integer", minimum: 0 }, invalidFiles: { type: "integer", minimum: 0 } },
    },
    unguardedAgents: strings,
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

export function registerStatusCommand(
  ctx: { readonly command: Pick<Plugin.Context["command"], "transform">; readonly session: Pick<Plugin.Context["session"], "synthetic"> },
  read: () => Promise<Status>,
) {
  const registration = ctx.command.transform((editor) =>
    editor.add({
      name: `${COMMAND_STEM}-status`,
      description: "Show how many jobs there are, when they next run, and the next step",
      execute: async ({ sessionID }) => {
        const text = await read().then(formatStatus, (error: unknown) => unavailable(error).message)
        await ctx.session.synthetic({ sessionID, text, description: "Jobs status", resume: false })
      },
    }),
  )
  return registration.then((registration) => registration.dispose)
}
