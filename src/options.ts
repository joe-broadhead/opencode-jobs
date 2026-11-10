import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
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
  /** How often the keep-alive touches the leader's location, in minutes (D2). Below the user's idle timeout. */
  readonly keepAliveMinutes: number
  /** Extra directories a script's declared files may live in, besides the job's own directory. Absolute paths. */
  readonly scriptFilesRoots: readonly string[]
  /** How much Jobs and its scripts may do without asking: `all`, `ask-changes` or `read-only` (R18). */
  readonly access: Access
}

/** The family access policy: every tool allowed, changes asked, or reads only. */
export type Access = "all" | "ask-changes" | "read-only"
export const ACCESS_VALUES: readonly Access[] = ["all", "ask-changes", "read-only"]

export const DEFAULT_OPTIONS: Options = { enabled: true, allowUntestedHost: false, timezone: null, concurrency: 2, keepAliveMinutes: 20, scriptFilesRoots: [], access: "all" }

/** The most runs a person may allow at once: the option is a cost bound, not a throughput knob. */
export const MAX_CONCURRENCY = 8
/** The keep-alive's range: at least a minute, and no more than an hour. */
export const MIN_KEEPALIVE_MINUTES = 1
export const MAX_KEEPALIVE_MINUTES = 59

const EXAMPLE = `"plugins": [{ "package": "github:joe-broadhead/opencode-jobs#v0.0.0", "options": { "enabled": true } }]`
const ACCEPTED = {
  enabled: "true or false (true by default)",
  allowUntestedHost: "true or false (false by default)",
  timezone: 'an IANA time zone name such as "Europe/London" (the server\'s zone by default)',
  concurrency: `a whole number from 1 to ${MAX_CONCURRENCY} (2 by default)`,
  keepAliveMinutes: `a whole number of minutes from ${MIN_KEEPALIVE_MINUTES} to ${MAX_KEEPALIVE_MINUTES} (20 by default)`,
  scriptFilesRoots: "a list of absolute directory paths (none by default)",
  access: 'one of "all", "ask-changes" or "read-only" ("all" by default)',
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
    keepAliveMinutes: keepAlive(input),
    scriptFilesRoots: roots(input),
    access: access(input),
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

/** The keep-alive period, in minutes: below the user's idle timeout, so the leader's location never outlives it. */
function keepAlive(input: Record<string, unknown>): number {
  if (!Object.hasOwn(input, "keepAliveMinutes")) return DEFAULT_OPTIONS.keepAliveMinutes
  const value = input.keepAliveMinutes
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_KEEPALIVE_MINUTES || value > MAX_KEEPALIVE_MINUTES) {
    throw invalid(`The option "keepAliveMinutes" must be ${ACCEPTED.keepAliveMinutes}, found ${describe(value)}. Keep it below experimental.location_idle_timeout`)
  }
  return value
}

/** True when `child` lies inside `parent`, on the path's own components. */
const inside = (child: string, parent: string): boolean => {
  const path = relative(parent, child)
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/**
 * Extra roots a declared file may live in: absolute directories, resolved and de-duplicated. A root is a full
 * read/write grant to that tree, so `/`, the home directory and any ancestor of it or of OpenCode's own folders are
 * refused (DF-7).
 */
function roots(input: Record<string, unknown>): readonly string[] {
  if (!Object.hasOwn(input, "scriptFilesRoots")) return []
  const value = input.scriptFilesRoots
  if (!Array.isArray(value)) throw invalid(`The option "scriptFilesRoots" must be ${ACCEPTED.scriptFilesRoots}, found ${describe(value)}`)
  const home = resolve(homedir())
  const configHome = resolve(process.env["XDG_CONFIG_HOME"] ?? join(home, ".config"))
  const dataHome = resolve(process.env["XDG_DATA_HOME"] ?? join(home, ".local", "share"))
  const forbidden = [home, join(configHome, "opencode"), join(dataHome, "opencode")]
  const roots: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "" || !entry.startsWith("/")) throw invalid(`The option "scriptFilesRoots" must be ${ACCEPTED.scriptFilesRoots}, found ${describe(entry)}`)
    const root = resolve(entry.trim())
    if (root === "/") throw invalid(`The option "scriptFilesRoots" refuses "/", the whole disk; name a project or data directory`)
    if (root === home || inside(home, root)) throw invalid(`The option "scriptFilesRoots" refuses ${JSON.stringify(root)}, which contains the home directory; name a project or data directory`)
    if (forbidden.some((owned) => owned === root || inside(owned, root))) {
      throw invalid(`The option "scriptFilesRoots" refuses ${JSON.stringify(root)}, which contains OpenCode's own configuration or data; name a directory beside it`)
    }
    if (!roots.includes(root)) roots.push(root)
  }
  if (roots.length > 8) throw invalid(`The option "scriptFilesRoots" accepts at most 8 roots, found ${roots.length}`)
  return roots
}

function access(input: Record<string, unknown>): Access {
  if (!Object.hasOwn(input, "access")) return "all"
  const value = input.access
  if (value !== "all" && value !== "ask-changes" && value !== "read-only") throw invalid(`The option "access" must be ${ACCEPTED.access}, found ${describe(value)}`)
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
