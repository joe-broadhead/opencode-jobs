// The agent a plugin update can make disappear from the running plugin's view: fail closed, say so, and resume with no
// user action once the host lists it again. The file watch is driven by a manual clock, so the test is deterministic.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createReport, type ReportInput } from "../../src/jobs/report.js"
import { memoryStorage, testClock } from "./fake.js"
import { MINUTE } from "../../src/jobs/model.js"
import { MISSING_NEXT } from "../../src/host/permissions.js"
import { createFileWatch } from "../../src/jobs/watch.js"

const NOW = Date.UTC(2026, 11, 6, 9, 0, 0)
const HOST = { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }
const RULES = [
  { action: "*", resource: "*", effect: "deny" as const },
  { action: "read", resource: "*", effect: "allow" as const },
]

/** An agent domain that lists every name except the ones in `missing`: a plugin update's stale view. */
function domain(missing: Set<string>) {
  const info = (id: string) => ({ id, name: id, mode: "primary" as const, hidden: false, permissions: RULES })
  return {
    list: async () => ({ location: { directory: "/work" }, data: ["jobs", "build"].filter((id) => !missing.has(id)).map(info) }),
    get: async ({ agentID }: { agentID: string }) => {
      if (missing.has(agentID)) throw Object.assign(new Error(`Agent not found: ${agentID}`), { _tag: "Agent.NotFoundError" })
      return { location: { directory: "/work" }, data: info(agentID) }
    },
  }
}

function project(): string {
  const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "jobs-missing-")))
  const folder = join(root, ".opencode", "jobs")
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, "minute.md"), "---\nname: minute\nschedule:\n  every: 1 hour\naction:\n  type: prompt\n  text: Say ok.\nagent: jobs\n---\nSay ok.\n")
  return root
}

function reportAt(root: string, missing: Set<string>, clock: ReturnType<typeof testClock>): ReportInput {
  return {
    storage: memoryStorage().storage,
    location: root,
    timezone: "UTC",
    clock: clock.clock,
    agent: domain(missing) as never,
    host: HOST,
    enabled: true,
    keepAliveMinutes: 20,
    watch: createFileWatch(() => clock.now()),
  }
}

describe("an agent the host no longer lists", () => {
  test("fails closed, names the agent, and gives the reload as the one next step", async () => {
    const root = project()
    try {
      const missing = new Set(["jobs"])
      const report = createReport(reportAt(root, missing, testClock(NOW)))
      const status = await report.status()
      expect(status.jobs).toMatchObject({ total: 0, invalidFiles: 1 })
      expect(status.missingAgents).toEqual(["jobs"])
      expect(status.unguardedAgents).toEqual([])
      expect(status.nextStep).toBe(MISSING_NEXT)
      expect(status.problems[0]).toStartWith("JOBS_AGENT_MISSING: ")
      expect(status.problems[0]).toContain("opencode reload")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("resumes on its own when the agent comes back, with no file change and no restart", async () => {
    const root = project()
    try {
      const missing = new Set(["jobs"])
      const clock = testClock(NOW)
      const report = createReport(reportAt(root, missing, clock))
      expect((await report.status()).jobs.total).toBe(0)

      // The host lists it again; the next scan, after the watch's minute, re-parses the refused file without a touch.
      missing.delete("jobs")
      clock.advance(MINUTE)
      const status = await report.status()
      expect(status.missingAgents).toEqual([])
      expect(status.jobs).toMatchObject({ total: 1, invalidFiles: 0 })
      expect(status.problems).toEqual([])
      expect(status.nextStep).toBe("Nothing to do.")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  test("names a stored job's agent too, and a slot for it is skipped, not run", async () => {
    const storage = memoryStorage()
    const clock = testClock(NOW)
    const job = {
      id: "job_stored",
      name: "Stored",
      source: "tool" as const,
      schedule: { kind: "every" as const, everyMs: 3_600_000, anchorMs: NOW },
      jitterMs: 0,
      action: { type: "prompt" as const, text: "go" },
      agent: "jobs",
      target: {},
      allow: [],
      policy: { catchup: "latest" as const, maxLateMs: 3_600_000, overlap: "skip" as const, timeoutMs: 1_800_000, retries: { max: 0, backoffMs: 60_000 } },
      ends: {},
      createdAt: NOW,
      createdBy: "user" as const,
    }
    await storage.storage.set("job/job_stored", job as never)
    const report = createReport({ ...reportAt("/nowhere", new Set(["jobs"]), clock), storage: storage.storage })
    const status = await report.status()
    expect(status.jobs.total).toBe(1)
    expect(status.missingAgents).toEqual(["jobs"])
    expect(status.nextStep).toBe(MISSING_NEXT)
  }, 60_000)
})
