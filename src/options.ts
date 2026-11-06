import { jobsError } from "./constants.js"
import { isTimezone } from "./jobs/model.js"

/** The plugin options from opencode.json. Every option is optional. */
export interface Options {
  /** Run the runner and its jobs. False stops everything and leaves the status surfaces working. */
  readonly enabled: boolean
  /** Run on an OpenCode version outside the supported range, with a warning in status. */
  readonly allowUntestedHost: boolean
  /** The zone a job that names none runs in. Null uses the server's zone. */
  readonly timezone: string | null
  /** How many runs may be in flight at once, across every job. Bounds cost and file contention. */
  readonly concurrency: number
}

export const DEFAULT_OPTIONS: Options = { enabled: true, allowUntestedHost: false, timezone: null, concurrency: 2 }

/** The most runs a person may allow at once: the option is a cost bound, not a throughput knob. */
export const MAX_CONCURRENCY = 8

const EXAMPLE = `"plugins": [{ "package": "@joe-broadhead/opencode-jobs", "options": { "enabled": true } }]`
const ACCEPTED = {
  enabled: "true or false (true by default)",
  allowUntestedHost: "true or false (false by default)",
  timezone: 'an IANA time zone name such as "Europe/London" (the server\'s zone by default)',
  concurrency: `a whole number from 1 to ${MAX_CONCURRENCY} (2 by default)`,
} as const

const invalid = (problem: string) =>
  jobsError("OPTIONS_INVALID", `${problem}.`, `Fix the plugin options in opencode.json, for example ${EXAMPLE}.`)

/** Validates the plugin options from opencode.json. Every option is optional. */
export function parseOptions(raw: unknown): Options {
  if (raw === undefined || raw === null) return DEFAULT_OPTIONS
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid(`The plugin options must be an object, found ${describe(raw)}`)
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(ACCEPTED, key)) {
      throw invalid(`Unknown option "${key}". Accepted options: ${Object.keys(ACCEPTED).map((name) => `"${name}"`).join(", ")}`)
    }
  }
  return {
    enabled: flag(input, "enabled"),
    allowUntestedHost: flag(input, "allowUntestedHost"),
    timezone: zone(input),
    concurrency: count(input),
  }
}

function flag(input: Record<string, unknown>, key: "enabled" | "allowUntestedHost") {
  const value = Object.hasOwn(input, key) ? input[key] : key === "enabled"
  if (typeof value !== "boolean") throw invalid(`The option "${key}" must be ${ACCEPTED[key]}, found ${describe(value)}`)
  return value
}

function count(input: Record<string, unknown>): number {
  if (!Object.hasOwn(input, "concurrency")) return DEFAULT_OPTIONS.concurrency
  const value = input.concurrency
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
    throw invalid(`The option "concurrency" must be ${ACCEPTED.concurrency}, found ${describe(value)}`)
  }
  return value
}

function zone(input: Record<string, unknown>): string | null {
  if (!Object.hasOwn(input, "timezone")) return null
  const value = input.timezone
  if (typeof value !== "string" || value.trim() === "") throw invalid(`The option "timezone" must be ${ACCEPTED.timezone}, found ${describe(value)}`)
  const found = value.trim()
  if (!isTimezone(found)) throw invalid(`The option "timezone" is not a time zone: ${JSON.stringify(found)}. Accepted values are ${ACCEPTED.timezone}`)
  return found
}

const describe = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "string" ? JSON.stringify(value) : typeof value === "object" ? "an object" : String(value)
