/**
 * The job model: what a job is, the documented defaults, and the one validation every source shares. Tool jobs and file
 * jobs both become a `Job` here, with every duration resolved to milliseconds and every time zone to an IANA name, so
 * the planner never re-reads a string.
 *
 * The clock is a parameter, never read here.
 */
import { randomBytes } from "node:crypto"
import { errorText } from "../constants.js"
import { cronProblem } from "./cron.js"
import { SCRIPT_FILE_MAX, SCRIPT_MAX, SCRIPT_MAX_FILES, SCRIPT_SOURCE_MAX, type Script, type ScriptFile, type ScriptFileFormat, type ScriptFileMode } from "./script.js"

export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** An interval or a one-off is at least this long: a job runs at most once a minute. */
export const MIN_INTERVAL = MINUTE

/** The defaults the docs state (D4). Durations are milliseconds in the model. */
export const DEFAULTS = {
  /** Run the newest missed slot once, within `maxLateMs`; the rest collapse into one `missed` record. */
  catchup: "latest",
  maxLateMs: HOUR,
  overlap: "skip",
  timeoutMs: 30 * MINUTE,
  /** A reminder is a post, not a run. */
  remindTimeoutMs: 5 * MINUTE,
  retries: 0,
  backoffMs: MINUTE,
  /** A recurring job the model created is not lasting consent. */
  expiryMs: 7 * DAY,
  jitterMs: 0,
} as const

export type Catchup = "latest" | "none"
export type Overlap = "skip" | "queue-one" | "replace" | "allow"
export type CreatedBy = "user" | "agent"
export type JobSource = "file" | "tool"

/** A schedule with every duration and zone resolved: cron and `at` carry the zone they were resolved in. */
export type JobSchedule =
  | { readonly kind: "cron"; readonly cron: string; readonly tz: string }
  | { readonly kind: "every"; readonly everyMs: number; readonly anchorMs: number }
  | { readonly kind: "at"; readonly atMs: number; readonly tz: string }

export type JobAction =
  | { readonly type: "prompt"; readonly text: string }
  | { readonly type: "command"; readonly name: string; readonly arguments?: string }
  | { readonly type: "remind"; readonly sessionID: string; readonly text: string; readonly wake: boolean }
  | { readonly type: "script"; readonly script: Script }

/** A narrowing rule. A job's list may only deny: a grant belongs to the agent's own `permissions`. */
export interface DenyRule {
  readonly action: string
  readonly resource: string
  readonly effect: "deny"
}

export interface JobPolicy {
  readonly catchup: Catchup
  readonly maxLateMs: number
  readonly overlap: Overlap
  readonly timeoutMs: number
  readonly retries: { readonly max: number; readonly backoffMs: number }
}

export interface JobEnds {
  /** The last slot this job may run at. */
  readonly at?: number
  /** How many finished runs end the job. */
  readonly times?: number
}

export interface JobTarget {
  /** The directory the run's session is created in. A project file defaults it to the project. */
  readonly directory?: string
  readonly model?: { readonly providerID: string; readonly id: string }
}

/**
 * A job definition, from a file or a tool. Runtime state such as `paused` and `nextDueAt` is not here: the store owns
 * it (D3), and the planner reads both.
 */
export interface Job {
  readonly id: string
  readonly name: string
  readonly source: JobSource
  readonly schedule: JobSchedule
  /** A deterministic delay after the slot, never before it. Zero unless the job sets it. */
  readonly jitterMs: number
  readonly action: JobAction
  /** The named agent whose own `permissions` are the run's whole profile. Required. */
  readonly agent: string
  readonly target: JobTarget
  readonly allow: readonly DenyRule[]
  readonly policy: JobPolicy
  readonly ends: JobEnds
  /** When the job stops being schedulable. */
  readonly expires?: number
  readonly notify?: { readonly sessionID: string }
  readonly createdAt: number
  readonly createdBy: CreatedBy
}

export type JobCode =
  | "JOBS_INVALID_SCHEDULE"
  | "JOBS_INVALID_JOB"
  | "JOBS_ALLOW_WIDENS"
  | "JOBS_TARGET_MISSING"
  | "JOBS_SCRIPT_UNKNOWN_TOOL"
  | "JOBS_SCRIPT_DENIED"
  | "JOBS_SCRIPT_HOST_TOOL"
  | "JOBS_SCRIPT_FAMILY_TOOL"

/**
 * Why a job definition was refused: the code and next step, and the field at fault, so a file job's error can name the
 * line the field is on. Its message is already the shared `CODE: what Next step: what` text.
 */
export class JobInputError extends Error {
  readonly code: JobCode
  readonly field: string
  /** What is wrong, without the code or the next step. */
  readonly what: string
  readonly nextStep: string

  constructor(code: JobCode, field: string, what: string, nextStep: string) {
    super(errorText(code, what, nextStep))
    this.name = "JobInputError"
    this.code = code
    this.field = field
    this.what = what
    this.nextStep = nextStep
  }
}

/** What a source adds to the definition: its id, where its default zone and directory come from, and who made it. */
export interface JobContext {
  readonly now: number
  /** The zone a job that names none runs in: the `timezone` option, or the server's zone. */
  readonly timezone: string
  readonly id: string
  readonly source: JobSource
  /** The project directory a file job defaults `target.directory` to. */
  readonly directory?: string
  /** A file's modification time; the time the job was defined. */
  readonly createdAt?: number
  readonly createdBy?: CreatedBy
}

const SCHEDULE_NEXT = `Use a five-field cron expression, an interval of at least a minute, or a time with a valid IANA time zone, such as "Europe/London".`
const POLICY_NEXT = `Use "latest" or "none" for catchup, "skip", "queue-one", "replace" or "allow" for overlap, and a duration such as "30m" for maxLate, timeout and backoff.`

function fail(code: JobCode, field: string, what: string, nextStep: string): never {
  throw new JobInputError(code, field, what, nextStep)
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const label = (field: string) => (field === "" ? "The job" : `"${field}"`)

const describe = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "string" ? JSON.stringify(value) : typeof value === "object" ? "an object" : String(value)

/** Refuses a value that is not an object, with the field named. */
function object(value: unknown, field: string, code: JobCode = "JOBS_INVALID_JOB"): Record<string, unknown> {
  if (!isObject(value)) fail(code, field, `${label(field)} must be an object, found ${describe(value)}.`, `Set ${label(field).toLowerCase()} to an object.`)
  return value
}

/** Refuses a field the model does not know, so a typo is an error and not a silently ignored setting. */
function keys(input: Record<string, unknown>, field: string, allowed: readonly string[], code: JobCode = "JOBS_INVALID_JOB", next = `Remove the field, or check docs/configuration.md for the fields a job has.`) {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key))
  if (unknown.length) {
    fail(code, field, `${label(field)} has ${unknown.length === 1 ? "an unknown field" : "unknown fields"} ${unknown.map((key) => JSON.stringify(key)).join(", ")}; accepted fields are ${allowed.map((key) => JSON.stringify(key)).join(", ")}.`, next)
  }
}

function string(value: unknown, field: string, code: JobCode = "JOBS_INVALID_JOB", next = `Set ${label(field).toLowerCase()} to a non-empty string.`): string {
  if (typeof value !== "string" || value.trim() === "") fail(code, field, `${label(field)} must be a non-empty string, found ${describe(value)}.`, next)
  return value.trim()
}

/** A non-empty string of at most `max` characters, with no control characters. */
function text(value: unknown, field: string, max: number, code: JobCode = "JOBS_INVALID_JOB"): string {
  const found = string(value, field, code)
  if (/[\u0000-\u001f\u007f]/.test(found)) fail(code, field, `${label(field)} must be one line of text, without control characters.`, `Write ${label(field).toLowerCase()} as plain text on one line.`)
  if (found.length > max) fail(code, field, `${label(field)} is longer than ${max} characters.`, `Shorten ${label(field).toLowerCase()} to at most ${max} characters.`)
  return found
}

/** A duration such as `"30s"`, `"30m"`, `"24h"` or `"7d"`, in milliseconds. */
export function parseDuration(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(value.trim())
  if (!match) return undefined
  const size = DURATION_UNITS[match[2]!.toLowerCase()]
  if (size === undefined) return undefined
  return Math.round(Number(match[1]) * size)
}

const DURATION_UNITS: Readonly<Record<string, number>> = {
  s: SECOND,
  sec: SECOND,
  secs: SECOND,
  second: SECOND,
  seconds: SECOND,
  m: MINUTE,
  min: MINUTE,
  mins: MINUTE,
  minute: MINUTE,
  minutes: MINUTE,
  h: HOUR,
  hr: HOUR,
  hrs: HOUR,
  hour: HOUR,
  hours: HOUR,
  d: DAY,
  day: DAY,
  days: DAY,
}

function duration(value: unknown, field: string, code: JobCode, next: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== "string") fail(code, field, `${label(field)} must be a duration such as "30m", found ${describe(value)}.`, next)
  const ms = parseDuration(value)
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) fail(code, field, `${label(field)} must be a duration such as "30m", found ${JSON.stringify(value)}.`, next)
  return ms
}

/** True for an IANA zone name the runtime knows. */
export function isTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The zone the server runs in: the last fallback of the job → option → server chain. */
export function serverTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

/**
 * The zone a schedule runs in: the job's own, else the plugin's `timezone` option, else the server's. The option is
 * `null` when it is not set.
 */
export function jobTimezone(jobTz: string | undefined, optionTz: string | null): string {
  if (jobTz !== undefined && jobTz !== "") return jobTz
  if (optionTz !== null && optionTz !== "") return optionTz
  return serverTimezone()
}

function zone(value: unknown, field: string, context: JobContext): string {
  if (value === undefined) return context.timezone
  const found = string(value, field, "JOBS_INVALID_SCHEDULE", `Use an IANA time zone, such as "Europe/London" or "UTC".`)
  if (!isTimezone(found)) fail("JOBS_INVALID_SCHEDULE", field, `${label(field)} is not a time zone: ${JSON.stringify(found)}.`, `Use an IANA time zone, such as "Europe/London" or "UTC".`)
  return found
}

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)?(?:Z|[+-]\d{2}:?\d{2})$/

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz)
  if (cached) return cached
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  formatters.set(tz, created)
  return created
}

function wallParts(tz: string, ms: number) {
  const parts = formatter(tz).formatToParts(ms)
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute"), second: read("second") }
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(tz: string, ms: number): number {
  const { year, month, day, hour, minute, second } = wallParts(tz, ms)
  return Date.UTC(year, month - 1, day, hour, minute, second) - ms
}

/**
 * A wall clock in a zone, as an instant; undefined when the clock skips it. An ambiguous time is the earlier of its
 * two instants.
 */
export function wallClock(text: string, tz: string): number | undefined {
  const match = WALL_CLOCK.exec(text)
  if (!match) return undefined
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match
  const asUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  const guess = asUtc - offsetAt(tz, asUtc)
  const instant = asUtc - offsetAt(tz, guess)
  const back = wallParts(tz, instant)
  if (Date.UTC(back.year, back.month - 1, back.day, back.hour, back.minute, back.second) !== asUtc) return undefined
  return instant
}

/** A time from JSON or YAML: an ISO string with an offset, or a wall clock in the job's zone. */
export function parseInstant(value: unknown, field: string, tz: string, code: JobCode = "JOBS_INVALID_JOB"): number {
  const found = typeof value === "string" ? value.trim() : value
  if (typeof found !== "string" || found === "") {
    fail(code, field, `${label(field)} must be a time, such as "2026-11-13T09:00:00Z", found ${describe(value)}.`, `Set ${label(field).toLowerCase()} to a time, such as "2026-11-13T09:00:00Z".`)
  }
  if (WITH_OFFSET.test(found)) {
    const ms = Date.parse(found)
    if (Number.isFinite(ms)) return ms
    fail(code, field, `${label(field)} is not a time: ${JSON.stringify(found)}.`, `Use an ISO time such as "2026-11-13T09:00:00Z".`)
  }
  const ms = wallClock(found, tz)
  if (ms === undefined) {
    fail(code, field, `${label(field)} is ${JSON.stringify(found)}, which is not a time in ${tz}: the clock skips it or the text is not ISO.`, `Use an ISO time such as "2026-11-13T09:00:00Z", or a wall clock such as "2026-11-13T09:00" that exists in ${tz}.`)
  }
  return ms
}

/** A stable id from a name: lower case, ASCII, hyphen-separated, at most 48 characters. */
export function slug(value: string): string {
  const base = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "")
  return base === "" ? "job" : base
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** A ULID: the time first, so ids sort by creation, then 80 random bits. */
export function ulid(now: number, random: Uint8Array = randomBytes(10)): string {
  if (random.length !== 10) throw new Error(`ulid: 10 random bytes are needed, found ${random.length}`)
  let time = ""
  let rest = Math.max(0, Math.floor(now))
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD[rest % 32]! + time
    rest = Math.floor(rest / 32)
  }
  let tail = ""
  let value = 0
  let bits = 0
  for (const byte of random) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      tail += CROCKFORD[(value >>> (bits - 5)) & 31]!
      bits -= 5
    }
  }
  return time + tail
}

/** The id of a job created through a tool. */
export const nextId = (now: number) => `job_${ulid(now)}`

/** A deterministic delay in `[0, jitterMs]`, from a job's id: the same job always starts at the same offset. */
export function jitterFor(id: string, jitterMs: number): number {
  if (jitterMs <= 0) return 0
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % (Math.floor(jitterMs) + 1)
}

function parseSchedule(value: unknown, context: JobContext): JobSchedule {
  const input = object(value, "schedule", "JOBS_INVALID_SCHEDULE")
  const present = (["cron", "every", "at"] as const).filter((key) => input[key] !== undefined)
  if (present.length !== 1) {
    fail("JOBS_INVALID_SCHEDULE", "schedule", `${label("schedule")} must have exactly one of "cron", "every" or "at", found ${present.length ? present.join(" and ") : "none"}.`, SCHEDULE_NEXT)
  }
  const kind = present[0]!
  keys(input, "schedule", kind === "every" ? ["every", "anchor"] : [kind, "tz"], "JOBS_INVALID_SCHEDULE", SCHEDULE_NEXT)

  if (kind === "cron") {
    const cron = string(input.cron, "schedule.cron", "JOBS_INVALID_SCHEDULE", SCHEDULE_NEXT).trim().split(/\s+/).join(" ")
    const tz = zone(input.tz, "schedule.tz", context)
    const problem = cronProblem(cron, tz, context.now)
    if (problem !== undefined) fail("JOBS_INVALID_SCHEDULE", "schedule.cron", `The cron expression ${JSON.stringify(cron)} ${problem}.`, SCHEDULE_NEXT)
    return { kind, cron, tz }
  }

  if (kind === "every") {
    const everyMs = duration(input.every, "schedule.every", "JOBS_INVALID_SCHEDULE", SCHEDULE_NEXT)
    if (everyMs < MIN_INTERVAL) fail("JOBS_INVALID_SCHEDULE", "schedule.every", `"schedule.every" must be at least one minute, found ${JSON.stringify(input.every)}.`, SCHEDULE_NEXT)
    // A file's mtime is a float; a slot is a whole millisecond, so the anchor is floored like every other time here.
    const anchorMs = input.anchor === undefined ? Math.floor(context.createdAt ?? context.now) : parseInstant(input.anchor, "schedule.anchor", context.timezone, "JOBS_INVALID_SCHEDULE")
    return { kind, everyMs, anchorMs }
  }

  const tz = zone(input.tz, "schedule.tz", context)
  return { kind: "at", atMs: parseInstant(input.at, "schedule.at", tz, "JOBS_INVALID_SCHEDULE"), tz }
}

function parseAction(value: unknown): JobAction {
  if (value === undefined) fail("JOBS_INVALID_JOB", "action", `The job has no action.`, `Give the job an action: a "prompt" with its text, a "command" name, or a "remind" with its session.`)
  const input = object(value, "action")
  const type = string(input.type, "action.type", "JOBS_INVALID_JOB", `Use an action of type "prompt", "command" or "remind".`)

  if (type === "prompt") {
    keys(input, "action", ["type", "text"])
    return { type, text: string(input.text, "action.text", "JOBS_INVALID_JOB", `Add the prompt to the action's "text", or, in a job file, after the front matter.`) }
  }
  if (type === "command") {
    keys(input, "action", ["type", "name", "arguments"])
    const name = string(input.name, "action.name", "JOBS_INVALID_JOB", `Name the command to run, without the leading slash.`).replace(/^\//, "")
    if (name === "") fail("JOBS_INVALID_JOB", "action.name", `"action.name" is only a slash.`, `Name the command to run, without the leading slash.`)
    if (input.arguments === undefined) return { type, name }
    if (typeof input.arguments !== "string") fail("JOBS_INVALID_JOB", "action.arguments", `"action.arguments" must be text, found ${describe(input.arguments)}.`, `Write the command's arguments as text, or remove them.`)
    return { type, name, arguments: input.arguments }
  }
  if (type === "remind") {
    keys(input, "action", ["type", "sessionID", "text", "wake"])
    if (input.wake !== undefined && typeof input.wake !== "boolean") fail("JOBS_INVALID_JOB", "action.wake", `"action.wake" must be true or false, found ${describe(input.wake)}.`, `Remove it to post without a model turn, or set it true to let the agent answer.`)
    const sessionID = string(input.sessionID, "action.sessionID", "JOBS_TARGET_MISSING", `Create the session the reminder goes to, then set the job's "action.sessionID" to its id.`)
    return { type, sessionID, text: string(input.text, "action.text"), wake: input.wake === true }
  }
  if (type === "script") {
    keys(input, "action", ["type", "script"])
    return { type, script: parseScript(input.script) }
  }
  return fail("JOBS_INVALID_JOB", "action.type", `"action.type" is ${JSON.stringify(type)}; the types are "prompt", "command", "remind" and "script".`, `Use an action of type "prompt", "command", "remind" or "script".`)
}

/** The method grammar of one `uses` entry: `<plugin>.<method>` or `host:<tool id>`. Exactness is checked when it resolves. */
const METHOD = /^(?:host:[A-Za-z0-9][A-Za-z0-9_.-]*|[A-Za-z0-9][A-Za-z0-9_.-]*\.[A-Za-z0-9][A-Za-z0-9_.-]*)$/

/** A script's source, manifest, optional timeout and limits. The digest and the approval are job state, not here. */
function parseScript(value: unknown): Script {
  const input = object(value, "action.script")
  keys(input, "action.script", ["code", "uses", "files", "timeoutMs", "limits"])
  const code = source(input.code)
  if (!Array.isArray(input.uses)) fail("JOBS_INVALID_JOB", "action.script.uses", `"action.script.uses" must be a list of methods, found ${describe(input.uses)}.`, `List every tool the script calls, as "<plugin id>.<method>" or "host:<tool id>".`)
  if (input.uses.length === 0) fail("JOBS_INVALID_JOB", "action.script.uses", `"action.script.uses" is empty, so the script could call nothing.`, `List at least one tool, as "<plugin id>.<method>" or "host:<tool id>".`)
  if (input.uses.length > 200) fail("JOBS_INVALID_JOB", "action.script.uses", `"action.script.uses" has ${input.uses.length} entries; the limit is 200.`, `Name only the tools the script calls.`)
  const uses = input.uses.map((entry, index) => {
    if (typeof entry !== "string" || !METHOD.test(entry)) {
      fail("JOBS_INVALID_JOB", `action.script.uses.${index}`, `The manifest entry ${describe(entry)} is not a method.`, `Write it as "<plugin id>.<method>", such as "x.posts.get_users_bookmarks", or "host:<tool id>", such as "host:mem_mem_remember".`)
    }
    return entry
  })
  const unique = [...new Set(uses)]
  const timeoutMs = input.timeoutMs === undefined ? undefined : duration(input.timeoutMs, "action.script.timeoutMs", "JOBS_INVALID_JOB", `Use a duration such as "5m", or remove it.`)
  const limits = input.limits === undefined ? undefined : parseScriptLimits(input.limits)
  const files = input.files === undefined ? undefined : parseScriptFiles(input.files)
  return {
    code,
    uses: unique,
    ...(files === undefined ? {} : { files }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(limits === undefined ? {} : { limits }),
  }
}

/** A file name in the guest: lower-case, starts with a letter, at most 32 characters. */
const FILE_NAME = /^[a-z][a-z0-9_]{0,31}$/

/** The declared files: names, paths, modes, formats and caps. Paths are resolved and checked at approval and run. */
function parseScriptFiles(value: unknown): Record<string, ScriptFile> {
  const input = object(value, "action.script.files")
  const names = Object.keys(input)
  if (names.length === 0) fail("JOBS_INVALID_JOB", "action.script.files", `"action.script.files" is empty; remove it or declare a file.`, `Declare a file as "files": { "state": { "path": "state.json", "mode": "readwrite", "format": "json" } }.`)
  if (names.length > SCRIPT_MAX_FILES) fail("JOBS_INVALID_JOB", "action.script.files", `"action.script.files" declares ${names.length} files; the limit is ${SCRIPT_MAX_FILES}.`, `Declare at most ${SCRIPT_MAX_FILES} files.`)
  const files: Record<string, ScriptFile> = {}
  for (const name of names) {
    if (!FILE_NAME.test(name) || name === "write") fail("JOBS_INVALID_JOB", `action.script.files.${name}`, `The file name ${JSON.stringify(name)} must match [a-z][a-z0-9_]{0,31} and is not "write", which is the write function.`, `Use a lower-case name that starts with a letter, such as "bookmarks".`)
    const field = `action.script.files.${name}`
    const file = object(input[name], field)
    keys(file, field, ["path", "mode", "format", "maxBytes"])
    const path = string(file.path, `${field}.path`, "JOBS_INVALID_JOB", `Give the file's path, relative to the job's directory or absolute inside an allowed root.`)
    if (path.includes("\u0000")) fail("JOBS_INVALID_JOB", `${field}.path`, `The path contains a null byte.`, `Remove it.`)
    const mode: unknown = file.mode ?? "read"
    if (mode !== "read" && mode !== "write" && mode !== "readwrite") {
      fail("JOBS_INVALID_JOB", `${field}.mode`, `"mode" is ${describe(mode)}; the modes are "read", "write" and "readwrite".`, `Use "read", "write" or "readwrite".`)
    }
    const format: unknown = file.format ?? "json"
    if (format !== "json" && format !== "text") {
      fail("JOBS_INVALID_JOB", `${field}.format`, `"format" is ${describe(format)}; the formats are "json" and "text".`, `Use "json" or "text".`)
    }
    let maxBytes: number | undefined
    if (file.maxBytes !== undefined) {
      if (typeof file.maxBytes !== "number" || !Number.isInteger(file.maxBytes) || file.maxBytes < 1 || file.maxBytes > SCRIPT_FILE_MAX) {
        fail("JOBS_INVALID_JOB", `${field}.maxBytes`, `"maxBytes" must be a whole number from 1 to ${SCRIPT_FILE_MAX}, found ${describe(file.maxBytes)}.`, `Use a whole number of bytes up to ${SCRIPT_FILE_MAX}.`)
      }
      maxBytes = file.maxBytes
    }
    files[name] = { path, mode: mode as ScriptFileMode, format: format as ScriptFileFormat, ...(maxBytes === undefined ? {} : { maxBytes }) }
  }
  return files
}

/** Parses a script definition from a tool's input, the same validation a job file gets. */
export function parseScriptDefinition(value: unknown): Script {
  return parseScript(value)
}

/** A script's source as written: not trimmed, because its indentation is part of it. */
function source(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail("JOBS_INVALID_JOB", "action.script.code", `"action.script.code" must be the script's source, found ${describe(value)}.`, `Write the JavaScript the script runs in "action.script.code".`)
  }
  if (Buffer.byteLength(value, "utf8") > SCRIPT_SOURCE_MAX) {
    fail("JOBS_INVALID_JOB", "action.script.code", `"action.script.code" is over ${SCRIPT_SOURCE_MAX} bytes.`, `Keep the script under ${SCRIPT_SOURCE_MAX} bytes.`)
  }
  if (value.includes("\u0000")) fail("JOBS_INVALID_JOB", "action.script.code", `"action.script.code" contains a null byte.`, `Remove it.`)
  return value
}

/** The per-run limits D-E allows: whole numbers inside the hard caps. */
function parseScriptLimits(value: unknown): Partial<{ memoryMb: number; maxCalls: number; maxOutputBytes: number }> {
  const input = object(value, "action.script.limits")
  keys(input, "action.script.limits", ["memoryMb", "maxCalls", "maxOutputBytes"])
  const whole = (key: "memoryMb" | "maxCalls" | "maxOutputBytes", max: number): number | undefined => {
    const found = input[key]
    if (found === undefined) return undefined
    if (typeof found !== "number" || !Number.isInteger(found) || found < 1 || found > max) {
      fail("JOBS_INVALID_JOB", `action.script.limits.${key}`, `"action.script.limits.${key}" must be a whole number from 1 to ${max}, found ${describe(found)}.`, `Use a whole number from 1 to ${max}, or remove it.`)
    }
    return found
  }
  const memoryMb = whole("memoryMb", SCRIPT_MAX.memoryMb)
  const maxCalls = whole("maxCalls", SCRIPT_MAX.maxCalls)
  const maxOutputBytes = whole("maxOutputBytes", SCRIPT_MAX.maxOutputBytes)
  return {
    ...(memoryMb === undefined ? {} : { memoryMb }),
    ...(maxCalls === undefined ? {} : { maxCalls }),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
  }
}

function parsePolicy(value: unknown, remind: boolean): JobPolicy {
  const input = value === undefined ? {} : object(value, "policy")
  keys(input, "policy", ["catchup", "maxLate", "overlap", "timeout", "retries"])
  const catchup: unknown = input.catchup ?? DEFAULTS.catchup
  if (catchup !== "latest" && catchup !== "none") fail("JOBS_INVALID_JOB", "policy.catchup", `"policy.catchup" is ${describe(catchup)}; the values are "latest" and "none".`, POLICY_NEXT)
  const overlap: unknown = input.overlap ?? DEFAULTS.overlap
  if (overlap !== "skip" && overlap !== "queue-one" && overlap !== "replace" && overlap !== "allow") {
    fail("JOBS_INVALID_JOB", "policy.overlap", `"policy.overlap" is ${describe(overlap)}; the values are "skip", "queue-one", "replace" and "allow".`, POLICY_NEXT)
  }
  const defaultTimeout = remind ? DEFAULTS.remindTimeoutMs : DEFAULTS.timeoutMs
  const timeoutMs = duration(input.timeout, "policy.timeout", "JOBS_INVALID_JOB", POLICY_NEXT, defaultTimeout)
  if (timeoutMs === 0) fail("JOBS_INVALID_JOB", "policy.timeout", `"policy.timeout" must be more than zero.`, POLICY_NEXT)

  let max: number = DEFAULTS.retries
  let backoffMs: number = DEFAULTS.backoffMs
  if (input.retries !== undefined) {
    if (typeof input.retries === "number") {
      max = input.retries
    } else {
      const retries = object(input.retries, "policy.retries")
      keys(retries, "policy.retries", ["max", "backoff"])
      max = retries.max === undefined ? DEFAULTS.retries : (retries.max as number)
      backoffMs = duration(retries.backoff, "policy.retries.backoff", "JOBS_INVALID_JOB", POLICY_NEXT, DEFAULTS.backoffMs)
    }
    if (!Number.isInteger(max) || max < 0 || max > 10) fail("JOBS_INVALID_JOB", "policy.retries", `"policy.retries" must be a whole number from 0 to 10, found ${describe(input.retries)}.`, POLICY_NEXT)
  }
  return {
    catchup,
    maxLateMs: duration(input.maxLate, "policy.maxLate", "JOBS_INVALID_JOB", POLICY_NEXT, DEFAULTS.maxLateMs),
    overlap,
    timeoutMs,
    retries: { max, backoffMs },
  }
}

function parseAllow(value: unknown): DenyRule[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail("JOBS_INVALID_JOB", "allow", `"allow" must be a list of deny rules, found ${describe(value)}.`, `Write the job's "allow" list as deny rules, or remove it.`)
  return value.map((entry, index) => {
    const field = `allow.${index}`
    const input = object(entry, field)
    keys(input, field, ["action", "resource", "effect"])
    const action = string(input.action, `${field}.action`)
    const resource = input.resource === undefined ? "*" : string(input.resource, `${field}.resource`)
    const effect = input.effect ?? "deny"
    if (effect !== "deny") {
      fail("JOBS_ALLOW_WIDENS", field, `The job's "allow" list may only deny, and ${JSON.stringify(action)} is ${describe(effect)}.`, `Move the allow rule for ${action} to the job agent's own "permissions" in opencode.json, and keep the job's list to deny rules.`)
    }
    return { action, resource, effect: "deny" }
  })
}

function parseEnds(value: unknown, tz: string): JobEnds {
  if (value === undefined) return {}
  const input = object(value, "ends")
  keys(input, "ends", ["at", "times"])
  const ends: { at?: number; times?: number } = {}
  if (input.at !== undefined) ends.at = parseInstant(input.at, "ends.at", tz)
  if (input.times !== undefined) {
    if (typeof input.times !== "number" || !Number.isInteger(input.times) || input.times < 1) {
      fail("JOBS_INVALID_JOB", "ends.times", `"ends.times" must be a whole number of runs, at least 1, found ${describe(input.times)}.`, `Set "ends.times" to how many runs the job may make, or remove it.`)
    }
    ends.times = input.times
  }
  if (ends.at === undefined && ends.times === undefined) fail("JOBS_INVALID_JOB", "ends", `"ends" has neither "at" nor "times".`, `Set "ends.at" to a time or "ends.times" to a number of runs, or remove "ends".`)
  return ends
}

function parseTarget(value: unknown, context: JobContext): JobTarget {
  if (value === undefined) return context.directory === undefined ? {} : { directory: context.directory }
  const input = object(value, "target")
  keys(input, "target", ["directory", "model"])
  const target: { directory?: string; model?: { providerID: string; id: string } } = {}
  const directory = input.directory === undefined ? context.directory : string(input.directory, "target.directory")
  if (directory !== undefined) target.directory = directory
  if (input.model !== undefined) {
    const model = object(input.model, "target.model")
    keys(model, "target.model", ["providerID", "id"])
    target.model = { providerID: string(model.providerID, "target.model.providerID"), id: string(model.id, "target.model.id") }
  }
  return target
}

/** Validates one job definition from a file or a tool, filling every documented default. */
export function parseJob(value: unknown, context: JobContext): Job {
  if (context.timezone === "" || !isTimezone(context.timezone)) throw new Error(`jobs: the default time zone ${JSON.stringify(context.timezone)} is not an IANA zone`)
  const input = object(value, "")
  keys(input, "", ["name", "schedule", "action", "agent", "target", "allow", "policy", "ends", "expires", "notify", "jitter"])
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(context.id)) throw new Error(`jobs: the id ${JSON.stringify(context.id)} is not a slug`)

  const schedule = parseSchedule(input.schedule, context)
  // A deadline written as a wall clock belongs to the clock the job runs by.
  const tz = schedule.kind === "every" ? context.timezone : schedule.tz
  const action = parseAction(input.action)
  const policy = parsePolicy(input.policy, action.type === "remind")
  // A script's reach is its manifest, not an agent profile, so it may run as the built-in `build` when none is named
  // (D-B). A prompt, command or reminder still names its agent: its rules are the whole profile.
  const agent =
    input.agent === undefined && action.type === "script"
      ? "build"
      : string(input.agent, "agent", "JOBS_INVALID_JOB", `Name the agent that runs the job, then give that agent its own "permissions" in opencode.json.`)
  const name = input.name === undefined ? context.id : text(input.name, "name", 120)
  const createdAt = Math.floor(context.createdAt ?? context.now)
  const createdBy = context.createdBy ?? (context.source === "file" ? "user" : "agent")
  // A recurring job the model created is not lasting consent (D4); a file job, or a person's tool job, keeps running.
  const expires = input.expires !== undefined
    ? parseInstant(input.expires, "expires", tz)
    : createdBy === "agent" && schedule.kind !== "at"
      ? createdAt + DEFAULTS.expiryMs
      : undefined

  let notify: { sessionID: string } | undefined
  if (input.notify !== undefined) {
    const found = object(input.notify, "notify")
    keys(found, "notify", ["sessionID"])
    notify = { sessionID: string(found.sessionID, "notify.sessionID", "JOBS_TARGET_MISSING", `Create the session that receives the notice, then set "notify.sessionID" to its id.`) }
  }

  return {
    id: context.id,
    name,
    source: context.source,
    schedule,
    jitterMs: duration(input.jitter, "jitter", "JOBS_INVALID_JOB", `Use a duration such as "30s", or remove "jitter".`, DEFAULTS.jitterMs),
    action,
    agent,
    target: parseTarget(input.target, context),
    allow: parseAllow(input.allow),
    policy,
    ends: parseEnds(input.ends, tz),
    ...(expires === undefined ? {} : { expires }),
    ...(notify === undefined ? {} : { notify }),
    createdAt,
    createdBy,
  }
}

/** The fields `jobs_update` may change: everything a definition has, except its id and who made it. */
const UPDATABLE = ["name", "schedule", "action", "agent", "target", "allow", "policy", "ends", "expires", "notify", "jitter"] as const

/**
 * A job with some fields replaced, validated the same way a new one is. The id, the source and the creation stay: an
 * update is a new definition of the same job, never a second one. A schedule is re-read against the same zone chain, so
 * a partial patch cannot change a zone by accident.
 */
export function updateJob(job: Job, patch: unknown, context: JobContext): Job {
  const input = object(patch, "")
  keys(input, "", UPDATABLE)
  if (Object.keys(input).length === 0) {
    fail("JOBS_INVALID_JOB", "", `No field was given to change.`, `Give at least one field: ${UPDATABLE.join(", ")}.`)
  }
  const schedule = input.schedule === undefined ? job.schedule : parseSchedule(input.schedule, context)
  // A deadline written as a wall clock belongs to the clock the job runs by.
  const tz = schedule.kind === "every" ? context.timezone : schedule.tz
  const action = input.action === undefined ? job.action : parseAction(input.action)
  const policy = input.policy === undefined ? job.policy : parsePolicy(input.policy, action.type === "remind")
  const agent = input.agent === undefined ? job.agent : string(input.agent, "agent", "JOBS_INVALID_JOB", `Name the agent that runs the job, then give that agent its own "permissions" in opencode.json.`)
  const updated: Job = {
    ...job,
    name: input.name === undefined ? job.name : text(input.name, "name", 120),
    schedule,
    action,
    agent,
    target: input.target === undefined ? job.target : parseTarget(input.target, context),
    allow: input.allow === undefined ? job.allow : parseAllow(input.allow),
    policy,
    ends: input.ends === undefined ? job.ends : parseEnds(input.ends, tz),
    jitterMs: input.jitter === undefined ? job.jitterMs : duration(input.jitter, "jitter", "JOBS_INVALID_JOB", `Use a duration such as "30s", or remove "jitter".`),
  }
  const expires = input.expires === undefined ? job.expires : parseInstant(input.expires, "expires", tz)
  const { expires: _dropped, ...rest } = updated
  return { ...rest, ...(expires === undefined ? {} : { expires }) }
}
