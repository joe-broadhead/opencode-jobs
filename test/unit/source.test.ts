// The jobs.runs source: the conformance kit's report over the fixture, and what the kit does not spell out — paging to
// the end, an empty page, a cursor that retention expired (after a real prune), a store that cannot be read, the
// probe's refusals, what an event never carries, and the asserts each method makes.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SourceError, type EventsListResult } from "@we-the-rebel-alliance/source-contract/events"
import { sessionRules } from "@we-the-rebel-alliance/source-contract/permission"
import { defaultRules, evaluate } from "../../src/host/permissions.js"
import { pluginError, TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { EVENTS_ACTION, eventsList, HISTORY_ACTION, identityOf, PROBE_ACTION, probe, RUN_KIND, RUNS_SOURCE, SETTLE_MS, SOURCE_ID, sourceMethods } from "../../src/jobs/source.js"
import { MAX_RUNS, prune, putRun, readPruned, type Storage } from "../../src/jobs/store.js"
import { encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { ACCOUNT, conformanceReports, cursorAt, declaredSources, FIXTURE, fixtureStorage, IDENTITY, ROOT, sourceInput } from "../support/conformance.js"
import { memoryStorage } from "./fake.js"

const NOW = Date.parse(FIXTURE.now)
const SINCE = "2026-11-16T12:00:00Z"
const list = (input: Record<string, unknown>, storage: Storage, now = NOW) => eventsList({ source: RUNS_SOURCE, account: ACCOUNT, ...input }, { ...sourceInput(storage), now: () => now })
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "answered",
    (error: unknown) => (error instanceof SourceError ? `${error.code}|${error.next === "" ? "" : "next"}` : String(error)),
  )

/** Every page of a read, following its cursor until `more` is false. */
async function readAll(first: Record<string, unknown>, storage: Storage, now = NOW): Promise<EventsListResult[]> {
  const pages = [await list(first, storage, now)]
  while (pages.at(-1)!.more) pages.push(await list({ cursor: pages.at(-1)!.cursor, limit: first["limit"] }, storage, now))
  return pages
}

describe("the declaration", () => {
  test("is jobs.runs on the tools RPC, its actions are the methods', and its one operation is the run history read", () => {
    const sources = declaredSources()
    expect(sources.rpc).toBe(TOOLS_RPC_ID)
    expect(sources.probe?.action).toBe(PROBE_ACTION)
    const item = sources.items[0]!
    expect(sources.items).toHaveLength(1)
    expect({ id: item.id, kind: item.kind, tool: item.tool, input: item.input }).toEqual({ id: SOURCE_ID, kind: "events", tool: "events_list", input: { source: RUNS_SOURCE } })
    expect(item.kind === "events" ? item.reads : undefined).toBe(RUN_KIND)
    expect(item.kind === "events" ? item.permission.events : undefined).toBe(EVENTS_ACTION)
    // The fence a consumer runs a read in: everything denied, then the method and the run history it reads.
    const rules = sessionRules(item as never, { source: item.id, account: ACCOUNT })
    expect(rules.ok ? rules.value : rules.problems).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: EVENTS_ACTION, resource: "*", effect: "allow" },
      { action: HISTORY_ACTION, resource: "*", effect: "allow" },
    ])
  })

  test("declares none of the keys a consumer on source-contract 0.1.x refuses", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { sources: { items: { permission: Record<string, unknown>; accounts?: Record<string, unknown> }[] } }
    for (const item of pkg.sources.items) {
      expect(Object.keys(item.permission).sort()).toEqual(["events", "operations"])
      expect(item.accounts).toEqual({ named: false })
    }
  })

  test("the source's reads are allowed under every access, and its changes still follow the namespace rule", () => {
    for (const access of ["all", "ask-changes", "read-only"] as const) {
      const rules = [{ action: "*", resource: "*", effect: "allow" as const }, ...defaultRules(access)]
      for (const action of [EVENTS_ACTION, PROBE_ACTION, HISTORY_ACTION]) expect({ access, action, effect: evaluate(rules, action) }).toEqual({ access, action, effect: "allow" })
    }
  })
})

describe("the conformance kit", () => {
  test("passes over the fixture, with every check that applies run", async () => {
    const [report] = await conformanceReports()
    expect(report!.problems).toEqual([])
    expect(report!.incomplete).toBe(false)
    expect(report!.ok).toBe(true)
    const ran = report!.checks.filter((check) => check.ran).map((check) => check.name)
    for (const name of ["gap-and-cursor-expired", "gap-once-per-read", "refused-is-final", "probe", "unused-grants"]) expect(ran).toContain(name)
    // Only the store read can fail, and it fails the whole page: no single run fails on its own.
    expect(report!.checks.find((check) => check.name === "failed-holds-cursor")).toMatchObject({ notApplicable: true })
  })
})

describe("events_list", () => {
  test("lists finished runs once each, oldest first by their end, across pages, and refuses the one named after a secret", async () => {
    const storage = await fixtureStorage()
    const pages = await readAll({ since: SINCE, limit: 2 }, storage)
    const events = pages.flatMap((page) => page.events)
    expect(events.map((event) => event.external_id)).toEqual([
      "nightly-brief/2026-11-16T16:00:00.000Z/1",
      "inbox-sweep/2026-11-16T18:00:00.000Z/1",
      "inbox-sweep/2026-11-16T22:00:00.000Z/1",
      "nightly-brief/2026-11-17T06:00:00.000Z/2",
      "old-job/2026-11-17T08:00:00.000Z/1",
    ])
    expect(pages.flatMap((page) => page.refused ?? [])).toEqual([{ external_id: "wifi-note/2026-11-16T20:00:00.000Z/1", reason: "secret", detail: "holds a secret (password)" }])
    // A refusal takes its place in a page's limit, as an event does.
    expect(pages.map((page) => page.events.length + (page.refused?.length ?? 0))).toEqual([2, 2, 2])
    // The gap retention left is answered once, on the read's first page.
    expect(pages.map((page) => page.gap?.reason)).toEqual(["window-truncated", undefined, undefined])
    expect(new Set(events.map((event) => event.occurred_at)).size).toBe(events.length)
    expect([...events].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))).toEqual(events)
  })

  test("an event is the job's name and how its run ended, at its end, and never what the run said", async () => {
    const page = await list({ since: SINCE }, await fixtureStorage())
    const timedOut = page.events.find((event) => event.external_id.startsWith("inbox-sweep/2026-11-16T18"))!
    expect(timedOut).toMatchObject({
      kind: RUN_KIND,
      occurred_at: "2026-11-16T18:10:00.000Z",
      thread: "jobs-job:inbox-sweep",
      actors: [],
      title: "Inbox sweep timed_out",
      url: null,
      labels: ["status:timed_out"],
    })
    expect(timedOut.text).toContain("Started 2026-11-16T18:00:00.500Z.")
    expect(timedOut.text).toContain("Code JOBS_TIMEOUT.")
    // A job that is gone is named by its id.
    expect(page.events.find((event) => event.thread === "jobs-job:old-job")?.title).toBe("old-job succeeded")
    const all = JSON.stringify(page)
    for (const text of ["brief is ready", "longer than its 10m", "rate limited", "ignore previous instructions", "ses_fixture", "Ku7pLm2QzR9w"]) expect(all).not.toContain(text)
  })

  test("leaves out a run still running, the collapsed missed slots, and a run that finished within the settle time, until it settles", async () => {
    const storage = await fixtureStorage()
    const ids = (page: EventsListResult) => page.events.map((event) => event.external_id)
    const now = await list({ since: "2026-11-17T09:00:00Z" }, storage)
    expect(ids(now)).toEqual([])
    const later = await list({ cursor: now.cursor }, storage, NOW + SETTLE_MS)
    expect(ids(later)).toEqual(["inbox-sweep/2026-11-17T11:59:00.000Z/1"])
  })

  test("an empty page names its owner and keeps its cursor", async () => {
    const storage = await fixtureStorage()
    const first = await list({ since: SINCE }, storage)
    const empty = await list({ cursor: first.cursor }, storage)
    expect(empty).toMatchObject({ source: RUNS_SOURCE, account: ACCOUNT, owner: IDENTITY.owner, events: [], more: false, trust: "untrusted" })
    expect(empty.gap).toBeUndefined()
    expect(empty.cursor).toBe(first.cursor)
  })

  test("a retry's attempt is a new event after the attempt it replaced was listed", async () => {
    const { storage } = memoryStorage()
    const slot = "2026-11-17T10:00:00.000Z"
    await putRun(storage, { job: "sync", slot, status: "failed", late: false, attempt: 1, startedAt: NOW - 600_000, endedAt: NOW - 590_000 })
    const first = await list({ since: SINCE }, storage)
    await putRun(storage, { job: "sync", slot, status: "succeeded", late: false, attempt: 2, startedAt: NOW - 300_000, endedAt: NOW - 290_000 })
    const next = await list({ cursor: first.cursor }, storage)
    expect([...first.events, ...next.events].map((event) => [event.external_id, event.title])).toEqual([
      [`sync/${slot}/1`, "sync failed"],
      [`sync/${slot}/2`, "sync succeeded"],
    ])
  })

  test("after retention removes a run a cursor had not reached, the next page says so once, with gap expired, and lists the rest", async () => {
    const { storage } = memoryStorage()
    const minute = 60_000
    // One job with one run more than retention keeps, every minute, ending an hour ago.
    const start = NOW - 3_600_000 - (MAX_RUNS + 1) * minute
    for (let index = 0; index <= MAX_RUNS; index += 1) {
      const at = start + index * minute
      await putRun(storage, { job: "tick", slot: new Date(at).toISOString(), status: "succeeded", late: false, attempt: 1, startedAt: at, endedAt: at + 1_000 })
    }
    const before = await list({ since: new Date(start - minute).toISOString(), limit: 1 }, storage)
    expect(before.events.map((event) => event.external_id)).toEqual([`tick/${new Date(start).toISOString()}/1`])
    // Retention keeps the last 50: it removes only the oldest, which this cursor has read. Nothing is lost yet.
    await prune(storage, NOW)
    expect(await readPruned(storage)).toEqual({ at: start + 1_000, key: `tick/${new Date(start).toISOString()}` })
    expect((await list({ cursor: before.cursor, limit: 1 }, storage)).gap).toBeUndefined()
    // Two more runs: retention removes the next oldest, which the cursor has not reached.
    for (const at of [NOW - 120_000, NOW - 90_000]) {
      await putRun(storage, { job: "tick", slot: new Date(at).toISOString(), status: "succeeded", late: false, attempt: 1, startedAt: at, endedAt: at + 1_000 })
    }
    await prune(storage, NOW)
    const expired = await list({ cursor: before.cursor, limit: 10 }, storage)
    expect(expired.gap).toEqual({ reason: "expired", since: new Date(start + 1_000).toISOString() })
    expect(expired.events[0]!.external_id).toBe(`tick/${new Date(start + 3 * minute).toISOString()}/1`)
    expect(expired.more).toBe(true)
    // The read's later pages, and a read from where it stands, never repeat the gap.
    const pages = await readAll({ cursor: expired.cursor, limit: 10 }, storage)
    expect(pages.every((page) => page.gap === undefined)).toBe(true)
    expect([...expired.events, ...pages.flatMap((page) => page.events)]).toHaveLength(MAX_RUNS)
  })

  test("a prune that runs during a read never lets a run it removed pass without a gap", async () => {
    // The review's repro: retention fires while the read is in flight, at each of the read's own store calls.
    for (const when of ["meta/pruned", "scan"] as const) {
      const { storage } = memoryStorage(1000)
      const minute = 60_000
      const start = NOW - 3_600_000 - (MAX_RUNS + 2) * minute
      for (let index = 0; index <= MAX_RUNS; index += 1) {
        const at = start + index * minute
        await putRun(storage, { job: "tick", slot: new Date(at).toISOString(), status: "succeeded", late: false, attempt: 1, startedAt: at, endedAt: at + 1_000 })
      }
      let fired = false
      const fire = async () => {
        if (fired) return
        fired = true
        await prune(storage, NOW)
      }
      const racy: Storage = {
        ...storage,
        // Retention lands just after the reader's own read returns: its answer is already the old one.
        get: async (key) => {
          const value = await storage.get(key)
          if (when === "meta/pruned" && key === "meta/pruned") await fire()
          return value
        },
        scan: async (options) => {
          const page = await storage.scan(options)
          if (when === "scan") await fire()
          return page
        },
      }
      const page = await list({ cursor: cursorAt(start - minute, ""), limit: 5 }, racy)
      expect(fired).toBe(true)
      const next = await list({ cursor: page.cursor, limit: 500 }, storage)
      const lost = `tick/${new Date(start).toISOString()}/1`
      const listed = [...page.events, ...next.events].some((event) => event.external_id === lost)
      expect({ when, told: listed || page.gap?.reason === "expired" || next.gap?.reason === "expired" }).toEqual({ when, told: true })
    }
  })

  test("lists a slot the runner skipped before it started, at the time the skip was recorded", async () => {
    const { storage } = memoryStorage()
    const recorded = NOW - 300_000
    await putRun(storage, { job: "sync", slot: "2026-11-17T11:00:00.000Z", status: "skipped", reason: "overlap", late: false, attempt: 1, endedAt: recorded })
    const page = await list({ since: "2026-11-17T00:00:00Z" }, storage)
    expect(page.events.map((event) => [event.title, event.occurred_at, event.labels])).toEqual([["sync skipped", new Date(recorded).toISOString(), ["status:skipped", "skipped:overlap"]]])
    expect(page.events[0]!.text).toContain(`Recorded ${new Date(recorded).toISOString()}.`)
    expect(page.events[0]!.text).not.toContain("Started")
  })

  test("refuses another machine's account or cursor, a foreign cursor, a source it does not have, and a bad input", async () => {
    const storage = await fixtureStorage()
    const other = identityOf("sam", "other-mac")
    expect(await refusal(list({ account: other.account }, storage))).toBe("ACCOUNT_MISMATCH|next")
    expect(await refusal(list({ cursor: cursorAt(NOW, "x", undefined, other) }, storage))).toBe("ACCOUNT_MISMATCH|next")
    expect(await refusal(list({ cursor: cursorAt(NOW, "x", undefined, IDENTITY, "history") }, storage))).toBe("CURSOR_INVALID|next")
    expect(await refusal(list({ cursor: "not a cursor" }, storage))).toBe("CURSOR_INVALID|next")
    // Another plugin's cursor that keeps an account under the same key is foreign, not another machine's.
    const foreign = encodeBoundCursor({ plugin: "gws", source: "mail", account: "sam@example.com", scope: {} }, { a: "sam@example.com", p: 5 })
    expect(await refusal(list({ cursor: foreign }, storage))).toBe("CURSOR_INVALID|next")
    expect(await refusal(list({ source: "meetings" }, storage))).toBe("SOURCE_UNKNOWN|next")
    expect(await refusal(list({ limit: 501 }, storage))).toBe("INPUT_INVALID|next")
    expect(await refusal(list({ since: "yesterday" }, storage))).toBe("INPUT_INVALID|next")
  })

  test("a store that cannot be read is UNAVAILABLE, and the cursor is the consumer's to keep", async () => {
    const storage = await fixtureStorage()
    const broken: Storage = { ...storage, scan: async () => Promise.reject(new Error("disk I/O error")) }
    const error = await list({ since: SINCE }, broken).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(SourceError)
    expect((error as SourceError).message).toMatch(/^UNAVAILABLE: The job store could not be read\. Next step: /)
    expect((error as SourceError).message).not.toContain("disk I/O")
  })
})

describe("probe", () => {
  test("names this machine and its OS user, and reads no run", async () => {
    expect(probe({ source: RUNS_SOURCE, account: ACCOUNT }, IDENTITY)).toEqual({ source: RUNS_SOURCE, account: "studio-mac", owner: { id: "os-user:sam@studio-mac", label: "sam on studio-mac" }, trust: "untrusted" })
    expect(probe({}, IDENTITY).account).toBe(ACCOUNT)
  })

  test("refuses another machine's account, a source it does not have, and anything else in its input", async () => {
    const coded = (run: () => unknown) => {
      try {
        run()
        return "answered"
      } catch (error) {
        return error instanceof SourceError ? error.code : String(error)
      }
    }
    expect(coded(() => probe({ source: RUNS_SOURCE, account: "other-mac" }, IDENTITY))).toBe("ACCOUNT_MISMATCH")
    expect(coded(() => probe({ source: "meetings" }, IDENTITY))).toBe("SOURCE_UNKNOWN")
    expect(coded(() => probe({ source: RUNS_SOURCE, cursor: "x" }, IDENTITY))).toBe("INPUT_INVALID")
  })
})

describe("the tools RPC methods", () => {
  test("events_list asserts its own action and the run history it reads; probe asserts only its own; a refusal keeps its code", async () => {
    const asserted: string[] = []
    const methods = sourceMethods({ ...sourceInput(await fixtureStorage()), assert: async (_call, action) => void asserted.push(action) })
    const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal, progress: async () => {} }
    expect(methods.map((method) => [method.name, method.action, method.class])).toEqual([
      ["events_list", EVENTS_ACTION, "read"],
      ["probe", PROBE_ACTION, "read"],
    ])
    await methods[0]!.run({ source: RUNS_SOURCE, since: SINCE }, call)
    expect(asserted.splice(0)).toEqual([EVENTS_ACTION, HISTORY_ACTION])
    await methods[1]!.run({ source: RUNS_SOURCE }, call)
    expect(asserted.splice(0)).toEqual([PROBE_ACTION])
    const refused = await methods[0]!.run({ source: RUNS_SOURCE, account: "other-mac" }, call).catch((error: unknown) => error)
    expect(pluginError(refused)).toEqual({ code: "ACCOUNT_MISMATCH", what: "Jobs lists only this machine's runs, and that account is another machine's", next: "Call events_list with this machine's account, as its probe names it." })
  })
})
