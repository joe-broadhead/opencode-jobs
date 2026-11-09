// A script job whose latest run was skipped because a tool is now denied: status must not say "approved" (SR-8).
import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createReport } from "../../src/jobs/report.js"
import { parseJob } from "../../src/jobs/model.js"
import { digestOf, filesDigest, manifestDigest, sourceHash } from "../../src/jobs/script.js"
import { putJob, putRun, putState } from "../../src/jobs/store.js"
import { agentsFake, memoryStorage, testClock } from "./fake.js"

const NOW = Date.UTC(2026, 11, 6, 9, 0, 0)
const HOST = { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }

const job = parseJob(
  { name: "Bookmarks", schedule: { every: "1h" }, action: { type: "script", script: { code: "return 1", uses: ["host:mem"] } } },
  { now: NOW, timezone: "UTC", id: "bookmarks", source: "tool", createdBy: "user" },
)
const script = (job.action as { type: "script"; script: { code: string; uses: string[] } }).script

async function report() {
  const storage = memoryStorage()
  const clock = testClock(NOW, { instantBelow: 0 })
  await putJob(storage.storage, job)
  await putState(storage.storage, {
    job: job.id,
    runCount: 0,
    consecutiveFailures: 0,
    nextDueAt: NOW,
    approval: { sourceHash: sourceHash(script.code), manifestDigest: manifestDigest(script.uses), filesDigest: filesDigest(), digest: digestOf(script), at: NOW, resolved: [], files: [] },
  })
  await putRun(storage.storage, { job: job.id, slot: new Date(NOW).toISOString(), status: "skipped", reason: "revoked", late: false, attempt: 1, error: "JOBS_SCRIPT_REVOKED: The script \"bookmarks\" uses tools its agent now denies: host:mem (mem). Next step: Remove the deny rule." })
  return createReport({ storage: storage.storage, location: "/nowhere", timezone: "UTC", clock: clock.clock, agent: agentsFake(), host: HOST, enabled: true, keepAliveMinutes: 20 })
}

describe("status and a revoked script", () => {
  test("names the job, says a tool is now denied, and gives the approve step", async () => {
    const status = await (await report()).status()
    expect(status.scriptJobs).toEqual({ approved: 0, unapproved: 1, names: ["bookmarks"], revoked: ["bookmarks"], automatic: 0 })
    expect(status.nextStep).toContain("/jobs-approve bookmarks")
    // The problem row names the job, the method and the action the agent now denies (D1).
    expect(status.problems[0]).toContain("JOBS_SCRIPT_REVOKED")
    expect(status.problems[0]).toContain("host:mem")
  })

  test("flags a resolved path that no longer matches the approval (DF-10)", async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "jobs-status-")))
    try {
      const withFile = parseJob(
        { name: "State", schedule: { every: "1h" }, action: { type: "script", script: { code: "return files.state", uses: ["host:mem"], files: { state: { path: "state.json", mode: "read", format: "json" } } } } },
        { now: NOW, timezone: "UTC", id: "state", source: "tool", createdBy: "user" },
      )
      const declared = (withFile.action as { script: { code: string; uses: readonly string[]; files: Record<string, unknown> } }).script
      const old = [{ name: "state", path: join(root, "old", "state.json"), mode: "read" as const, format: "json" as const, maxBytes: 1024 }]
      const storage = memoryStorage()
      const clock = testClock(NOW, { instantBelow: 0 })
      await putJob(storage.storage, withFile)
      await putState(storage.storage, {
        job: withFile.id,
        runCount: 0,
        consecutiveFailures: 0,
        nextDueAt: NOW,
        approval: { sourceHash: sourceHash(declared.code), manifestDigest: manifestDigest(declared.uses), filesDigest: filesDigest(declared.files as never), digest: digestOf(declared as never, old), at: NOW, resolved: [], files: old },
      })
      const report = createReport({ storage: storage.storage, location: root, timezone: "UTC", clock: clock.clock, agent: agentsFake(), host: HOST, enabled: true, keepAliveMinutes: 20 })
      const status = await report.status()
      // The declared path alone still matches; the resolved path does not, so status must not say approved.
      expect(status.scriptJobs).toMatchObject({ approved: 0, unapproved: 1, names: ["state"] })
      const view = (await report.list())[0]!.script!
      expect(view.needsApproval).toBe(true)
      expect(view.reason).toContain("/jobs-approve state")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a successful latest run is not flagged", async () => {
    const storage = memoryStorage()
    const clock = testClock(NOW, { instantBelow: 0 })
    await putJob(storage.storage, job)
    await putState(storage.storage, { job: job.id, runCount: 0, consecutiveFailures: 0, nextDueAt: NOW, approval: { sourceHash: sourceHash(script.code), manifestDigest: manifestDigest(script.uses), filesDigest: filesDigest(), digest: digestOf(script), at: NOW, resolved: [], files: [] } })
    await putRun(storage.storage, { job: job.id, slot: new Date(NOW + 1).toISOString(), status: "succeeded", late: false, attempt: 1 })
    await putRun(storage.storage, { job: job.id, slot: new Date(NOW).toISOString(), status: "skipped", reason: "revoked", late: false, attempt: 1 })
    const report = createReport({ storage: storage.storage, location: "/nowhere", timezone: "UTC", clock: clock.clock, agent: agentsFake(), host: HOST, enabled: true, keepAliveMinutes: 20 })
    expect((await report.status()).scriptJobs).toEqual({ approved: 1, unapproved: 0, names: [], revoked: [], automatic: 0 })
  })
})
