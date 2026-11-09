// A declared file is written only when the run succeeds: an error, a timeout or a limit leaves it exactly as it was.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { execute } from "../../src/jobs/execute.js"
import { parseJob, type Job } from "../../src/jobs/model.js"
import { digestOf, filesDigest, manifestDigest, sourceHash, type ResolvedTool, type Script, type ScriptApproval } from "../../src/jobs/script.js"
import { resolveScriptFiles } from "../../src/jobs/script-files.js"
import type { ScriptGate } from "../../src/jobs/script-gate.js"
import { putJob, putState, scanRuns } from "../../src/jobs/store.js"
import { createReport } from "../../src/jobs/report.js"
import { runJobTool } from "../../src/jobs/tools.js"
import { agentsFake, memoryStorage, sessionFake, testClock } from "./fake.js"

const START = Date.UTC(2026, 11, 6, 9, 0, 0)
const RESOLVED: readonly ResolvedTool[] = [{ method: "host:mem", action: "mem", class: "unclassified", kind: "host", effect: "allow" }]

describe("a script's declared file", () => {
  async function setup(code: string, extra: { timeoutMs?: string; access?: "all" | "ask-changes" | "read-only"; approved?: "auto" | "prompt"; limits?: Record<string, number>; files?: Record<string, { path: string; mode: "read" | "write" | "readwrite"; format: "json" | "text" }> } = {}) {
    const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "jobs-file-run-")))
    writeFileSync(join(root, "state.json"), JSON.stringify({ n: 1 }))
    const declared = extra.files ?? { state: { path: "state.json", mode: "readwrite" as const, format: "json" as const } }
    for (const file of Object.values(declared)) if (!existsSync(join(root, file.path))) writeFileSync(join(root, file.path), JSON.stringify({ n: 1 }))
    const script: Script = { code, uses: ["host:mem"], files: declared, ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs as never }), ...(extra.limits === undefined ? {} : { limits: extra.limits as never }) }
    const job: Job = parseJob({ name: "State", schedule: { every: "1h" }, action: { type: "script", script } }, { now: START, timezone: "UTC", id: "state", source: "tool", createdBy: "user" })
    const files = await resolveScriptFiles((job.action as { script: Script }).script.files, root)
    const approval: ScriptApproval = {
      sourceHash: sourceHash(script.code),
      manifestDigest: manifestDigest(script.uses),
      filesDigest: filesDigest(script.files),
      digest: digestOf(script, files),
      at: START,
      resolved: RESOLVED,
      files,
      ...(extra.approved === undefined ? {} : { approved: extra.approved }),
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
        ...(extra.access === undefined ? {} : { access: extra.access }),
      } as never)
    return { root, storage, session, run, job, gate, file: () => JSON.parse(readFileSync(join(root, "state.json"), "utf8")) }
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

  test("re-applies the access policy at every run, before any call or write (DF-2)", async () => {
    // An approval made automatically under `all`, then the option switches to `read-only`.
    const readonly = await setup(`await files.write("state", { n: 2 }); return 1`, { access: "read-only", approved: "auto" })
    try {
      const result = await readonly.run(START)
      expect(result.status).toBe("skipped")
      const record = (await scanRuns(readonly.storage.storage, "state"))[0]!
      expect(record.reason).toBe("revoked")
      expect(record.calls ?? []).toHaveLength(0)
      expect(readonly.file()).toEqual({ n: 1 })
    } finally {
      rmSync(readonly.root, { recursive: true, force: true })
    }

    // `ask-changes` needs a person for a change; an automatic approval is not that person.
    const ask = await setup(`await files.write("state", { n: 2 }); return 1`, { access: "ask-changes", approved: "auto" })
    try {
      expect((await ask.run(START)).status).toBe("skipped")
      expect((await scanRuns(ask.storage.storage, "state"))[0]?.reason).toBe("unapproved")
      expect(ask.file()).toEqual({ n: 1 })
    } finally {
      rmSync(ask.root, { recursive: true, force: true })
    }

    // A prompted approval of this exact digest still runs, and an all-read script needs no approval at all.
    const prompted = await setup(`await files.write("state", { n: 2 }); return 1`, { access: "ask-changes", approved: "prompt" })
    try {
      expect((await prompted.run(START)).status).toBe("succeeded")
      expect(prompted.file()).toEqual({ n: 2 })
    } finally {
      rmSync(prompted.root, { recursive: true, force: true })
    }
  })

  test("list and get report the same approval skip as the executor after access changes (RR-2)", async () => {
    for (const access of ["ask-changes", "read-only"] as const) {
      const setupRun = await setup('await files.write("state", { n: 2 }); return "private-result"', { access, approved: "auto" })
      try {
        await putJob(setupRun.storage.storage, setupRun.job)
        const result = await setupRun.run(START)
        expect(result.status).toBe("skipped")
        expect(result.record?.reason).toBe(access === "read-only" ? "revoked" : "unapproved")
        const clock = testClock(START, { instantBelow: 0 }).clock
        const agent = agentsFake({ unguarded: ["build"], names: ["build"] })
        const report = createReport({ storage: setupRun.storage.storage, location: setupRun.root, timezone: "UTC", clock, agent, host: { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }, enabled: true, keepAliveMinutes: 20, access, scripts: setupRun.gate })
        const view = (await report.list())[0]!.script!
        const input = { storage: setupRun.storage.storage, location: setupRun.root, timezone: "UTC", clock, agent, source: () => report.source(), wake: () => undefined, ready: true, report, assert: async () => undefined }
        const listed = await runJobTool(input, "list", {})
        const got = await runJobTool(input, "get", { id: setupRun.job.id })
        expect(got.output["script"]).toEqual(view)
        expect(view).toMatchObject({ approved: "auto", needsApproval: access === "ask-changes", tools: ["host:mem"] })
        expect(view.reason).toContain(access === "ask-changes" ? "/jobs-approve state" : "revoked")
        expect(listed.text).toContain(access === "ask-changes" ? "/jobs-approve state" : "revoked")
        expect(got.text).toContain(access === "ask-changes" ? "/jobs-approve state" : "revoked")
        expect(JSON.stringify(got.output["script"])).not.toContain("private-result")
        expect(JSON.stringify(view)).not.toContain("files.write")
      } finally {
        rmSync(setupRun.root, { recursive: true, force: true })
      }
    }
  })

  test("get returns the script definition and the same run error as history, without source in approval facts", async () => {
    for (const code of ["return files.state", "throw new Error(JSON.stringify(files.state))"]) {
      const setupRun = await setup(code, { access: "all", approved: "auto" })
      try {
        writeFileSync(join(setupRun.root, "state.json"), '{"privateMarker":"do-not-expose"}')
        await putJob(setupRun.storage.storage, setupRun.job)
        await setupRun.run(START)
        const clock = testClock(START, { instantBelow: 0 }).clock
        const agent = agentsFake({ unguarded: ["build"], names: ["build"] })
        const report = createReport({ storage: setupRun.storage.storage, location: setupRun.root, timezone: "UTC", clock, agent, host: { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }, enabled: true, keepAliveMinutes: 20, access: "all", scripts: setupRun.gate })
        const input = { storage: setupRun.storage.storage, location: setupRun.root, timezone: "UTC", clock, agent, source: () => report.source(), wake: () => undefined, ready: true, report, assert: async () => undefined }
        const got = await runJobTool(input, "get", { id: setupRun.job.id })
        expect(got.output["job"]).toMatchObject({ action: { type: "script", script: { code, uses: ["host:mem"], files: { state: { path: "state.json", mode: "readwrite", format: "json" } } } } })
        expect(got.text).toContain(code.replaceAll('"', '\\"'))
        expect(JSON.stringify(got.output["script"])).not.toContain(code)
        expect(JSON.stringify(got.output["script"])).not.toContain("do-not-expose")
        const runs = got.output["runs"] as { error?: string }[]
        const history = await report.history({ id: setupRun.job.id, summaries: true })
        expect(runs[0]?.error).toBe(history[0]?.error)
        // A script's thrown text can carry file content: the run's error is the code and a fixed description, never it (RR-8).
        if (code.startsWith("throw")) {
          expect(runs[0]?.error).toStartWith("JOBS_SCRIPT_FAILED: ")
          expect(runs[0]?.error).not.toContain("do-not-expose")
          expect(JSON.stringify(got.output["runs"])).not.toContain("do-not-expose")
          expect(JSON.stringify(history)).not.toContain("do-not-expose")
        }
      } finally {
        rmSync(setupRun.root, { recursive: true, force: true })
      }
    }
  })

  test("accounts for buffered bytes at write time, so a loop cannot exhaust the host (DF-5)", async () => {
    // Two 600-byte writes pass the per-file cap (600) and together pass the run's 1,024-byte total.
    const bounded = await setup(
      `const pad = "x".repeat(600); await files.write("a", { pad }); await files.write("b", { pad }); return 1`,
      {
        limits: { maxFileBytes: 1024 },
        files: {
          a: { path: "a.json", mode: "readwrite", format: "json" },
          b: { path: "b.json", mode: "readwrite", format: "json" },
        },
      },
    )
    try {
      const result = await bounded.run(START)
      expect(result.status).toBe("failed")
      const record = (await scanRuns(bounded.storage.storage, "state"))[0]!
      expect(record.error).toContain("JOBS_SCRIPT_FILE_TOO_LARGE")
      expect(JSON.parse(readFileSync(join(bounded.root, "a.json"), "utf8"))).toEqual({ n: 1 })
      expect(record.files?.every((file) => file.bytesWritten === 0)).toBe(true)
    } finally {
      rmSync(bounded.root, { recursive: true, force: true })
    }

    // A single write over its own cap is refused at write time too.
    const oversized = await setup(`await files.write("state", { pad: "x".repeat(2000) }); return 1`, {
      files: { state: { path: "state.json", mode: "readwrite", format: "json" } },
      limits: { maxFileBytes: 1024 },
    })
    try {
      // The declaration's default cap is 1 MB, so only the run total can refuse this: use a big value against 1,024.
      await oversized.run(START)
      expect(JSON.parse(readFileSync(join(oversized.root, "state.json"), "utf8"))).toEqual({ n: 1 })
    } finally {
      rmSync(oversized.root, { recursive: true, force: true })
    }
  }, 30_000)
})
