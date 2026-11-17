// source-contract's conformance kit over the one source this plugin declares in package.json's `sources` (`jobs.runs`),
// run on the plugin's own tools RPC methods `events_list` and `probe` (`sourceMethods`, as setup registers them), over a
// store read from test/fixtures/runs-source.json: invented jobs and runs, no OpenCode and no network. Each method's
// asserts go to the kit's recording permission, as the host's `ctx.permission.assert` would take them, so declared must
// equal asserted. `npm run conformance` writes the report (reports/conformance-report.json); test/unit/source.test.ts
// asserts it.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sourceConformance, type ConformanceReport, type PageCase, type SessionContext } from "@we-the-rebel-alliance/source-contract/conformance"
import { encodeBoundCursor, encodeCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { readInstalledDescriptor, type InstalledDescriptor } from "@we-the-rebel-alliance/source-contract/descriptor"
import { SOURCES_SCHEMA, type Sources } from "@we-the-rebel-alliance/source-contract/schema"
import { TOOLS_RPC_ID, type PluginMethod, type ToolCall } from "../../src/host/tools-rpc.js"
import { identityOf, PACKAGE, RUNS_SOURCE, sourceMethods, type LocalIdentity, type SourceInput } from "../../src/jobs/source.js"
import { ownedMethods, type ToolInput } from "../../src/jobs/tools.js"
import type { Storage } from "../../src/jobs/store.js"
import { memoryStorage } from "../unit/fake.js"

export const ROOT = join(import.meta.dir, "..", "..")

export interface Fixture {
  readonly now: string
  readonly user: string
  readonly host: string
  readonly names: Readonly<Record<string, string>>
  readonly store: Readonly<Record<string, unknown>>
}

export const FIXTURE = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "runs-source.json"), "utf8")) as Fixture

/** The fixture's machine and OS user. */
export const IDENTITY: LocalIdentity = identityOf(FIXTURE.user, FIXTURE.host)
export const ACCOUNT = IDENTITY.account

/** The fixture's store, in the host's paged storage. */
export async function fixtureStorage(fixture: Fixture = FIXTURE): Promise<Storage> {
  const { storage } = memoryStorage(3)
  for (const [key, value] of Object.entries(fixture.store)) await storage.set(key, value as never)
  return storage
}

/** The source's input over a store: the fixture's names and time. */
export function sourceInput(storage: Storage, fixture: Fixture = FIXTURE): SourceInput {
  return { storage, names: async () => new Map(Object.entries(fixture.names)), identity: identityOf(fixture.user, fixture.host), now: () => Date.parse(fixture.now) }
}

const call = (): ToolCall => ({ sessionID: "ses_conformance", agent: "build", messageID: "msg_conformance", id: "call_conformance", signal: new AbortController().signal, progress: async () => {} })

/** The plugin's tools RPC methods, as describe lists them: every tool a source may name, each read-only or not. */
export function declaredTools(): { id: string; readOnly: boolean }[] {
  const owned = ownedMethods({} as ToolInput)
  const source = sourceMethods({ ...sourceInput({} as Storage), assert: async () => {} })
  return [...owned, ...source].map((method) => ({ id: method.name, readOnly: method.class === "read" }))
}

/** The repository's package.json, read as a consumer reads an installed plugin: checked, then hashed. */
export function installed(): InstalledDescriptor {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
  const checked = readInstalledDescriptor(ROOT, { version: pkg.version })
  if (!checked.ok) throw new Error(`package.json's sources: ${checked.problems.join("; ")}`)
  return checked.value
}

/** package.json's sources, as Memory's schema parses them for the kit. */
export function declaredSources(): Sources {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { sources: unknown }
  const checked = SOURCES_SCHEMA.check(pkg.sources)
  if (!checked.ok) throw new Error(`package.json's sources: ${checked.problems.join("; ")}`)
  return checked.value
}

/** The jobs.runs cursor at a position, as the source writes it: the binding, the owner and where the read stands. */
export function cursorAt(at: number, key: string, answered?: readonly [number, string], identity: LocalIdentity = IDENTITY, plugin = "jobs"): string {
  return encodeBoundCursor(
    { plugin, source: RUNS_SOURCE, account: identity.account, scope: {} },
    { a: identity.account, o: identity.owner.id, p: [at, key], ...(answered === undefined ? {} : { g: [...answered] }) },
  )
}

/** The kit's report for jobs.runs, over the fixture. */
export async function conformanceReports(fixture: Fixture = FIXTURE): Promise<ConformanceReport[]> {
  installed()
  const sources = declaredSources()
  const storage = await fixtureStorage(fixture)
  let current: SessionContext["permission"] | undefined
  const methods = sourceMethods({
    ...sourceInput(storage, fixture),
    assert: async (_call, action) => {
      if (current === undefined) throw new Error("an assert ran outside a kit call")
      await current.assert({ action, resources: ["*"] })
    },
  })
  const method = (name: string) => methods.find((entry) => entry.name === name) as PluginMethod
  const run = (name: string) => async (input: Readonly<Record<string, unknown>>, context: SessionContext) => {
    current = context.permission
    try {
      return await method(name).run(input, call())
    } finally {
      current = undefined
    }
  }
  const pruned = fixture.store["meta/pruned"] as { at: number; key: string }
  const timed = Date.parse("2026-11-16T18:10:00.000Z")
  const last = Date.parse("2026-11-17T08:01:00.000Z")
  const other = identityOf(fixture.user, "other-mac")
  const cases: PageCase[] = [
    { name: "a first listing from a day ago, which retention cut short, one run refused for a secret in its job's name", input: { source: RUNS_SOURCE, account: ACCOUNT, since: "2026-11-16T12:00:00Z" } },
    { name: "the same, two at a time", input: { source: RUNS_SOURCE, account: ACCOUNT, since: "2026-11-16T12:00:00Z", limit: 2 } },
    { name: "from after retention's removal", input: { source: RUNS_SOURCE, account: ACCOUNT, since: "2026-11-17T01:00:00Z" } },
    { name: "without an account, the machine's own", input: { source: RUNS_SOURCE, since: "2026-11-17T01:00:00Z" } },
    {
      name: "a cursor issued before retention removed a run it had not reached",
      input: { source: RUNS_SOURCE, account: ACCOUNT, cursor: cursorAt(timed, "inbox-sweep/2026-11-16T18:00:00.000Z") },
      expect: "expired",
    },
    {
      name: "nothing new since the last listing",
      input: { source: RUNS_SOURCE, account: ACCOUNT, cursor: cursorAt(last, "old-job/2026-11-17T08:00:00.000Z", [pruned.at, pruned.key]) },
      expect: "empty",
    },
    { name: "another machine's account", input: { source: RUNS_SOURCE, account: other.account, since: "2026-11-16T12:00:00Z" }, expect: { refuses: "ACCOUNT_MISMATCH" } },
    { name: "another machine's cursor", input: { source: RUNS_SOURCE, account: ACCOUNT, cursor: cursorAt(timed, "x", undefined, other) }, expect: { refuses: "ACCOUNT_MISMATCH" } },
    { name: "a cursor bound to another plugin", input: { source: RUNS_SOURCE, account: ACCOUNT, cursor: cursorAt(timed, "x", undefined, IDENTITY, "history") }, expect: { refuses: "CURSOR_INVALID" } },
    { name: "contract 1's cursor", input: { source: RUNS_SOURCE, account: ACCOUNT, cursor: encodeCursor(RUNS_SOURCE, { a: ACCOUNT, p: [timed, "x"] }) }, expect: { refuses: "CURSOR_INVALID" } },
    { name: "a source Jobs does not have", input: { source: "meetings", account: ACCOUNT }, expect: { refuses: "SOURCE_UNKNOWN" } },
    { name: "a limit outside 1 to 500", input: { source: RUNS_SOURCE, account: ACCOUNT, limit: 0 }, expect: { refuses: "INPUT_INVALID" } },
  ]
  const report = await sourceConformance({
    plugin: PACKAGE,
    source: sources.items[0]!,
    tools: declaredTools(),
    calls: { list: run("events_list"), probe: run("probe") },
    cases,
    account: ACCOUNT,
    sources,
    describe: { id: TOOLS_RPC_ID },
    atomicPages: { reason: "a page is one read of the plugin's own store, and no run is read on its own, so no single run can fail on its own" },
  })
  return [report]
}
