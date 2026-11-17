/**
 * The `jobs.runs` source (package.json's `sources`, source contract version 1): one event per finished job run, read
 * from the plugin's own run records in `ctx.storage`, with no network. `events_list` and `probe` are tools RPC methods,
 * which a consumer such as Memory calls in a session fenced to this source's grants.
 *
 * - **What is listed.** A run once it has finished: succeeded, failed, timed out, interrupted or skipped. A queued or
 *   running record has not finished, and a collapsed `missed` record stands for slots that never started, so neither is
 *   listed. A retry of a slot replaces its record, so a failed attempt that a retry replaced before it was listed is not
 *   listed on its own; the retry's event names its attempt.
 * - **Order and time.** Runs are listed in the order they finished, and `occurred_at` is the run's end: a run is known
 *   only once it ends, and ordering by the end keeps a cursor from passing a run that was still in flight when it was
 *   issued. The start is in the event's text. A slot the runner skipped before it started (overlap, expired, ended)
 *   has no start, and its end is when the skip was recorded. A run is listed once it has been finished for `SETTLE_MS`, so a run whose
 *   record is still being written is never passed.
 * - **Words.** The title is the job's name and the run's status, as `/jobs-status` writes them; the text is the status
 *   row, the planned slot, the start, the end, the attempt and the failure's code. Never the prompt, a summary, a
 *   script's result or any other run output.
 * - **Retention.** The store keeps the last 50 runs of each job and 30 days. When retention has removed a finished run a
 *   cursor had not reached, the page says so once, with `gap` (`expired` after a cursor, `window-truncated` for a read
 *   from `since`), and lists what is left.
 */
import { hostname, userInfo } from "node:os"
import { decodeBoundCursor, encodeBoundCursor, type CursorBinding } from "@we-the-rebel-alliance/source-contract/cursor"
import {
  cut,
  eventsListResult,
  fitPage,
  makeEvent,
  parseEventsListInput,
  parseProbeInput,
  probeResult,
  screenEvents,
  SourceError,
  startTime,
  type EventsGap,
  type EventsListResult,
  type EventsOwner,
  type ProbeResult,
  type RefusedEvent,
  type SourceEvent,
} from "@we-the-rebel-alliance/source-contract/events"
import type { JsonSchema, PluginMethod, ToolCall } from "../host/tools-rpc.js"
import { runText } from "../status.js"
import { runView } from "./report.js"
import { after, finishedAt, readPruned, scanRuns, type RunPosition, type RunRecord, type Storage } from "./store.js"

/** The declared source's id, and its name as `events_list` and `probe` take it (`input.source`). */
export const SOURCE_ID = "jobs.runs"
export const RUNS_SOURCE = "runs"
/** The package every page names. */
export const PACKAGE = "@joe-broadhead/opencode-jobs"
/** The cursor binding's plugin: the source id's first segment, as the contract's D16 has it. */
export const CURSOR_PLUGIN = "jobs"
/** The event kind: a job run, the plugin's own kind (`reads` in package.json). */
export const RUN_KIND = "x-jobs/run"
/** The page limit in bytes: package.json's `maxBytes` for `jobs.runs`. */
export const PAGE_MAX_BYTES = 65_536
/** The actions: `events_list`'s, `probe`'s, and the run history it reads (`permission.operations`' `history`). */
export const EVENTS_ACTION = "jobs_events_list"
export const PROBE_ACTION = "jobs_probe"
export const HISTORY_ACTION = "jobs_history"
/** How long a run must have been finished before it is listed. */
export const SETTLE_MS = 60_000

/** Whose this machine's jobs are: the account is the machine, and the owner the OS user who runs OpenCode on it. */
export interface LocalIdentity {
  readonly account: string
  readonly owner: EventsOwner
}

const slug = (text: string, max: number) =>
  text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, max)

/** The identity for an OS user and a host name: `os-user:<user>@<host>`, labelled `<user> on <host>`. */
export function identityOf(user: string, host: string): LocalIdentity {
  const account = slug(host.replace(/\.local\.?$/i, ""), 63) || "local"
  const name = slug(user, 64) || "user"
  return { account, owner: { id: `os-user:${name}@${account}`, label: `${name} on ${account}` } }
}

/** This process's OS user and host name. A user without a password entry, as in some containers, falls back to $USER. */
export function localIdentity(): LocalIdentity {
  let user: string
  try {
    user = userInfo().username
  } catch {
    user = process.env["USER"] ?? process.env["LOGNAME"] ?? ""
  }
  return identityOf(user, hostname())
}

/** What the source reads: the store, the jobs' names now, whose jobs they are, and the time. */
export interface SourceInput {
  readonly storage: Storage
  readonly names: () => Promise<ReadonlyMap<string, string>>
  readonly identity: LocalIdentity
  readonly now: () => number
}

const refuse = (code: string, what: string, next: string, gap?: EventsGap): never => {
  throw new SourceError({ code, what, next, ...(gap === undefined ? {} : { gap }) })
}

const START_AGAIN = "Start again: call events_list with source runs and since, without a cursor."

/** The cursor's binding: the plugin, the source and this machine's account; the source declares no scope. */
const binding = (account: string): CursorBinding => ({ plugin: CURSOR_PLUGIN, source: RUNS_SOURCE, account, scope: {} })

/** Where a read stands: after `from`, with the newest removal it has already answered a gap for, if any. */
interface CursorState {
  readonly from: RunPosition
  readonly answered?: RunPosition
}

/** A position as the cursor holds it. */
const asPosition = (value: unknown): RunPosition | undefined => {
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const [at, key] = value as unknown[]
  return typeof at === "number" && Number.isSafeInteger(at) && at >= 0 && typeof key === "string" ? { at, key } : undefined
}

/**
 * The other machine a cursor belongs to: one this source issued for another account, which is ACCOUNT_MISMATCH. Only a
 * cursor that decodes under this source's binding for the account it names counts; any other cursor, another plugin's
 * included, is left to `readCursor`, which refuses it as CURSOR_INVALID.
 */
function otherMachine(cursor: string, account: string): string | undefined {
  let named: unknown
  try {
    named = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>)["a"]
  } catch {
    return undefined
  }
  if (typeof named !== "string" || named === account) return undefined
  return decodeBoundCursor(binding(named), cursor).ok ? named : undefined
}

function readCursor(cursor: string, identity: LocalIdentity): CursorState {
  const decoded = decodeBoundCursor(binding(identity.account), cursor)
  if (!decoded.ok) return refuse("CURSOR_INVALID", "The cursor is not one this machine's jobs.runs source issued.", START_AGAIN)
  const { a, o, p, g } = decoded.state
  const from = asPosition(p)
  const answered = g === undefined ? undefined : asPosition(g)
  if (a !== identity.account || o !== identity.owner.id || from === undefined || (g !== undefined && answered === undefined)) {
    return refuse("CURSOR_INVALID", "The cursor is not one this machine's jobs.runs source issued.", START_AGAIN)
  }
  return { from, ...(answered === undefined ? {} : { answered }) }
}

function writeCursor(state: CursorState, identity: LocalIdentity): string {
  return encodeBoundCursor(binding(identity.account), {
    a: identity.account,
    o: identity.owner.id,
    p: [state.from.at, state.from.key],
    ...(state.answered === undefined ? {} : { g: [state.answered.at, state.answered.key] }),
  })
}

/** The first segment of a coded error, such as `JOBS_TIMEOUT`; nothing when the error is not coded. */
function codeOf(error: string | undefined): string | undefined {
  const code = error?.split(":", 1)[0]?.trim()
  return code !== undefined && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : undefined
}

const iso = (time: number) => new Date(time).toISOString()

/** One finished run as an event, in the plugin's own words: its name and status, never anything a run said. */
export function runEvent(record: RunRecord, at: RunPosition, names: ReadonlyMap<string, string>, account: string): SourceEvent {
  const view = runView(record, names)
  const code = codeOf(record.error)
  const text = [
    `${runText(view)}.`,
    `Planned for ${record.slot}.`,
    ...(record.startedAt === undefined ? [] : [`Started ${iso(record.startedAt)}.`]),
    // A slot skipped before it started has no start: its time is when the skip was recorded.
    record.startedAt === undefined ? `Recorded ${iso(at.at)}.` : `Ended ${iso(at.at)}.`,
    `Attempt ${record.attempt}.`,
    ...(code === undefined ? [] : [`Code ${code}.`]),
  ].join(" ")
  return makeEvent({
    source: RUNS_SOURCE,
    account,
    external_id: `${record.job}/${record.slot}/${record.attempt}`,
    kind: RUN_KIND,
    occurred_at: at.at,
    thread: `jobs-job:${record.job}`,
    actors: [],
    title: `${view.name} ${record.status}`,
    text,
    url: null,
    labels: [`status:${record.status}`, ...(record.late ? ["late"] : []), ...(record.reason === undefined ? [] : [`skipped:${record.reason}`])],
  })
}

/**
 * What a page is read from: every run record, retention's newest removal and the jobs' names. UNAVAILABLE when the store
 * fails. The records are scanned before `meta/pruned` is read, and retention writes `meta/pruned` before it removes
 * anything: so a run that a prune running during the read removed is either in the scan or no newer than the `pruned`
 * read after it, and is never passed without a gap.
 */
async function readStore(input: SourceInput): Promise<{ pruned: RunPosition | undefined; records: readonly RunRecord[]; names: ReadonlyMap<string, string> }> {
  try {
    const records = await scanRuns(input.storage)
    const pruned = await readPruned(input.storage)
    return { pruned, records, names: await input.names() }
  } catch {
    return refuse("UNAVAILABLE", "The job store could not be read.", "Call events_list again with the same cursor later, and run /jobs-status if it keeps failing.")
  }
}

/**
 * `events_list` for `jobs.runs`: the finished runs after the cursor (or from `since`), oldest first. A call naming
 * another machine's account, or with its cursor, is ACCOUNT_MISMATCH; a cursor of another source or plugin is
 * CURSOR_INVALID. A run whose title or text holds a secret, such as a job named after a token, is refused for good and
 * the cursor moves past it.
 */
export async function eventsList(raw: unknown, input: SourceInput): Promise<EventsListResult> {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["source"] : undefined
  if (source !== undefined && source !== RUNS_SOURCE) refuse("SOURCE_UNKNOWN", `Jobs has no source ${JSON.stringify(String(source)).slice(0, 80)}.`, "Call events_list with source runs.")
  const parsed = parseEventsListInput(raw)
  if (!parsed.ok) return refuse("INPUT_INVALID", `The input is invalid: ${parsed.problems.join("; ")}.`, "Pass source, account, cursor or since, and limit, as the source contract defines them.")
  const request = parsed.value
  const { identity } = input
  const { account, owner } = identity
  if (request.account !== undefined && request.account !== account) {
    refuse("ACCOUNT_MISMATCH", "Jobs lists only this machine's runs, and that account is another machine's.", "Call events_list with this machine's account, as its probe names it.")
  }
  const now = input.now()
  let state: CursorState = { from: { at: startTime(request, now), key: "" } }
  if (request.cursor !== undefined) {
    if (otherMachine(request.cursor, account) !== undefined) {
      refuse("ACCOUNT_MISMATCH", "The cursor is another machine's, and Jobs lists only this machine's runs.", START_AGAIN)
    }
    state = readCursor(request.cursor, identity)
  }
  const whose = { source: RUNS_SOURCE, account, owner }
  const { pruned, records, names } = await readStore(input)
  // A run retention removed after where this read stands, and that no earlier page of it answered: history is lost.
  const lost = pruned !== undefined && after(pruned, state.from) && (state.answered === undefined || after(pruned, state.answered))
  const gap: EventsGap | undefined = lost ? { reason: request.cursor === undefined ? "window-truncated" : "expired", since: iso(state.from.at) } : undefined
  const answered = lost ? pruned : state.answered

  const settled = now - SETTLE_MS
  const finished = records
    .flatMap((record) => {
      const at = finishedAt(record)
      return at !== undefined && at.at <= settled && after(at, state.from) ? [{ record, at }] : []
    })
    .sort((left, right) => (after(left.at, right.at) ? 1 : after(right.at, left.at) ? -1 : 0))
  const listed: { at: RunPosition; event?: SourceEvent; refused?: RefusedEvent }[] = finished.slice(0, request.limit).map(({ record, at }) => {
    const screened = screenEvents([runEvent(record, at, names, account)])
    return screened.refused.length > 0 ? { at, refused: screened.refused[0]! } : { at, event: screened.events[0]! }
  })
  const events = listed.flatMap((entry) => (entry.event === undefined ? [] : [entry.event]))
  const fits = fitPage(events, request.limit, PAGE_MAX_BYTES)
  // The page ends after its last event that fits, with every refusal before it; the refusals after the last event that
  // fits ride along only when every event fits.
  const end = fits === events.length ? listed.length : listed.findIndex((entry) => entry.event === events[fits])
  const taken = listed.slice(0, end)
  const refused = taken.flatMap((entry) => (entry.refused === undefined ? [] : [entry.refused]))
  const last = taken.at(-1)?.at
  const cursor = writeCursor({ from: last ?? state.from, ...(answered === undefined ? {} : { answered }) }, identity)
  return eventsListResult(whose, taken.flatMap((entry) => (entry.event === undefined ? [] : [entry.event])), cursor, finished.length > taken.length, {
    plugin: PACKAGE,
    asOf: iso(now),
    ...(refused.length === 0 ? {} : { refused }),
    ...(gap === undefined ? {} : { gap }),
  })
}

/**
 * `probe`: whose this machine's jobs are, as every page names them. Jobs is local, so the account is this machine and
 * the owner its OS user. It reads no run. A call naming another account, or another source, is refused.
 */
export function probe(raw: unknown, identity: LocalIdentity): ProbeResult {
  const parsed = parseProbeInput(raw)
  if (!parsed.ok) return refuse("INPUT_INVALID", `The input is invalid: ${parsed.problems.join("; ")}.`, "Pass only source and account.")
  const { source, account } = parsed.value
  if (source !== undefined && source !== RUNS_SOURCE) refuse("SOURCE_UNKNOWN", `Jobs has no source ${JSON.stringify(String(source)).slice(0, 80)}.`, "Call probe with source runs.")
  if (account !== undefined && account !== identity.account) {
    refuse("ACCOUNT_MISMATCH", "Jobs lists only this machine's runs, and that account is another machine's.", "Call probe without account, or with this machine's.")
  }
  return probeResult({ source: RUNS_SOURCE, account: identity.account, owner: identity.owner })
}

/** One permission check, as the method's caller makes it. */
export type SourceAssert = (call: Pick<ToolCall, "sessionID" | "agent">, action: string) => Promise<void>

const string = { type: "string" } as const
const EVENTS_INPUT: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string", enum: [RUNS_SOURCE], description: "The source: runs." },
    account: { ...string, description: "This machine's account, as probe names it. Required with a cursor's account." },
    cursor: { ...string, description: "The previous page's cursor: lists what finished after it." },
    since: { ...string, description: "Without a cursor: where to start, an ISO date or date-time. Default: 24 hours ago." },
    limit: { type: "integer", minimum: 1, maximum: 500, description: "Most runs to list; 100 by default." },
  },
}
const PROBE_INPUT: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { source: { type: "string", enum: [RUNS_SOURCE] }, account: string },
}
const OBJECT: JsonSchema = { type: "object" }

/**
 * The source's two tools RPC methods. `events_list` asserts its own action and the run history it reads
 * (`jobs_history`, the action of the `jobs_history` tool, which reads the same records); `probe` asserts only its own.
 */
export function sourceMethods(input: SourceInput & { readonly assert: SourceAssert }): readonly PluginMethod[] {
  return [
    {
      kind: "plugin",
      class: "read",
      name: "events_list",
      action: EVENTS_ACTION,
      description: cut(
        "For a consumer such as Memory, not for answering questions: this machine's finished job runs since a cursor, as source-contract events, oldest first. Each names the job and how its run ended, never what the run said. Pass the previous page's cursor to list what finished after it.",
        1024,
      ),
      input: EVENTS_INPUT,
      output: OBJECT,
      async run(value, call) {
        await input.assert(call, EVENTS_ACTION)
        await input.assert(call, HISTORY_ACTION)
        return JSON.parse(JSON.stringify(await eventsList(value ?? {}, input)))
      },
    },
    {
      kind: "plugin",
      class: "read",
      name: "probe",
      action: PROBE_ACTION,
      description: "For a consumer binding the jobs.runs source: this machine's account and its OS user, as every page names them. It reads no run.",
      input: PROBE_INPUT,
      output: OBJECT,
      async run(value, call) {
        await input.assert(call, PROBE_ACTION)
        return JSON.parse(JSON.stringify(probe(value ?? {}, input.identity)))
      },
    },
  ]
}
