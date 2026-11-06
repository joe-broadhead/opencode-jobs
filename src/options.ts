import { jobsError } from "./constants.js"

/** The plugin options from opencode.json. Every option is optional. */
export interface Options {
  /** Run the runner and its jobs. False stops everything and leaves the status surfaces working. */
  readonly enabled: boolean
  /** Run on an OpenCode version outside the supported range, with a warning in status. */
  readonly allowUntestedHost: boolean
}

export const DEFAULT_OPTIONS: Options = { enabled: true, allowUntestedHost: false }

const EXAMPLE = `"plugins": [{ "package": "@joe-broadhead/opencode-jobs", "options": { "enabled": true } }]`
const ACCEPTED = {
  enabled: "true or false (true by default)",
  allowUntestedHost: "true or false (false by default)",
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
  return { enabled: flag(input, "enabled"), allowUntestedHost: flag(input, "allowUntestedHost") }
}

function flag(input: Record<string, unknown>, key: keyof typeof ACCEPTED) {
  const value = Object.hasOwn(input, key) ? input[key] : key === "enabled"
  if (typeof value !== "boolean") throw invalid(`The option "${key}" must be ${ACCEPTED[key]}, found ${describe(value)}`)
  return value
}

const describe = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "string" ? JSON.stringify(value) : typeof value === "object" ? "an object" : String(value)
