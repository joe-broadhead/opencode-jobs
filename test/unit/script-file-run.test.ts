// A declared file is written only when the run succeeds: an error, a timeout or a limit leaves it exactly as it was.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { execute } from "../../src/jobs/execute.js"
import { parseJob, type Job } from "../../src/jobs/model.js"
import { digestOf, filesDigest, manifestDigest, sourceHash, type ResolvedTool, type Script, type ScriptApproval } from "../../src/jobs/script.js"
import { resolveScriptFiles } from "../../src/jobs/script-files.js"
import type { ScriptGate } from "../../src/jobs/script-gate.js"
import { putState, scanRuns } from "../../src/jobs/store.js"
import { memoryStorage, sessionFake } from "./fake.js"

const START = Date.UTC(2026, 11, 6, 9, 0, 0)
const RESOLVED: readonly ResolvedTool[] = [{ method: "host:mem", action: "mem", class: "unclassified", kind: "host", effect: "allow" }]

describe("a script's declared file", () => {
  async function setup(code: string, extra: { timeoutMs?: string } = {}) {
    const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "jobs-file-run-")))
    writeFileSync(join(root, "state.json"), JSON.stringify({ n: 1 }))
    const script: Script = { code, uses: ["host:mem"], files: { state: { path: "state.json", mode: "readwrite", format: "json" } }, ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs as never }) }
    const job: Job = parseJob({ name: "State", schedule: { every: "1h" }, action: { type: "script", script } }, { now: START, timezone: "UTC", id: "state", source: "tool", createdBy: "user" })
    const files = await resolveScriptFiles((job.action as { script: Script }).script.files, root)
    const approval: ScriptApproval = {
      sourceHash: sourceHash(script.code),
      manifestDigest: manifestDigest(script.uses),
      filesDigest: filesDigest(script.files),
      digest: digestOf(script),
      at: START,
      resolved: RESOLVED,
      files,
    }
    const storage = memoryStorage()
    const session = sessionFake()
    const gate: ScriptGate = { resolve: async () => RESOLVED, approve: async () => approval }
    await putState(storage.storage, { job: job.id, runCount: 0, consecutiveFailures: 0, nextDueAt: START, approval })
    const run = (slot: number) =>
      execute({
        storage: storage.storage,
        session: session.session,
        agents: { get: async () => ({ data: { id: "build", name: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] } }) } as never,
        clock: { now: () => Date.now(), sleep: async () => undefined },
        location: root,
        token: "leader-1",
        job,
        slot,
        attempt: 1,
        late: false,
        active: () => true,
        scripts: gate,
        tool: { list: async () => [] } as never,
        rpc: (() => ({})) as never,
      } as never)
    return { root, storage, session, run, file: () => JSON.parse(readFileSync(join(root, "state.json"), "utf8")) }
  }

  test("is written after a successful run, and not after an error, a timeout or a limit", async () => {
    const ok = await setup(`const n = files.state?.n ?? 0; await files.write("state", { n: n + 1 }); return n;`)
    try {
      expect((await ok.run(START)).status).toBe("succeeded")
      expect(ok.file()).toEqual({ n: 2 })
      const record = (await scanRuns(ok.storage.storage, "state"))[0]!
      expect(record.files?.[0]).toMatchObject({ name: "state", bytesWritten: expect.any(Number), sha256After: expect.any(String) })
    } finally {
      rmSync(ok.root, { recursive: true, force: true })
    }

    const failed = await setup(`await files.write("state", { n: 99 }); throw new Error("boom")`)
    try {
      expect((await failed.run(START)).status).toBe("failed")
      expect(failed.file()).toEqual({ n: 1 })
      expect((await scanRuns(failed.storage.storage, "state"))[0]?.files?.[0]?.bytesWritten).toBe(0)
    } finally {
      rmSync(failed.root, { recursive: true, force: true })
    }

    const timedOut = await setup(`await files.write("state", { n: 99 }); for (;;) {}`, { timeoutMs: "1s" })
    try {
      expect((await timedOut.run(START)).status).toBe("timed_out")
      expect(timedOut.file()).toEqual({ n: 1 })
    } finally {
      rmSync(timedOut.root, { recursive: true, force: true })
    }
  }, 30_000)
})
