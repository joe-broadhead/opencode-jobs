// Untrusted text made safe before status, the dialog and the RPC see it (DR-8): a file name from a checkout and host
// error text can carry control, bidi and arbitrarily long characters, and must not reach a terminal or a session raw.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readJobFiles } from "../../src/jobs/files.js"
import { createReport } from "../../src/jobs/report.js"
import { buildStatus, formatStatus } from "../../src/status.js"
import { agentsFake, memoryStorage, testClock } from "./fake.js"

const NOW = Date.UTC(2026, 11, 6, 9, 0, 0)
const HOST = { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }

describe("untrusted names and host text", () => {
  test("a file name with bidi and control characters is reported as one safe line", async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "jobs-untrusted-")))
    try {
      const folder = join(root, ".opencode", "jobs")
      mkdirSync(folder, { recursive: true })
      // A right-to-left override and a BEL: a name a checkout can carry and a terminal must not obey.
      const name = `evil\u202Ename\u0007.md`
      writeFileSync(join(folder, name), "not a job file\n")
      const { invalid } = await readJobFiles({ now: NOW, timezone: "UTC", projects: [root] })
      expect(invalid).toHaveLength(1)
      const message = invalid[0]!.message
      expect(message).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u0000-\u001f\u007f-\u009f]/)
      expect(message.length).toBeLessThan(1200)
      expect(invalid[0]!.path).not.toMatch(/\u202E/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a failure code made of host text is one line, bounded, and carries no controls or bidi", async () => {
    const storage = memoryStorage()
    const clock = testClock(NOW, { instantBelow: 0 })
    const job = { id: "job_x", name: "X", source: "tool" as const, schedule: { kind: "every" as const, everyMs: 60_000, anchorMs: NOW }, jitterMs: 0, action: { type: "prompt" as const, text: "go" }, agent: "jobs", target: {}, allow: [], policy: { catchup: "latest" as const, maxLateMs: 3_600_000, overlap: "skip" as const, timeoutMs: 1_800_000, retries: { max: 0, backoffMs: 60_000 } }, ends: {}, createdAt: NOW, createdBy: "user" as const }
    await storage.storage.set("job/job_x", job as never)
    await storage.storage.set("run/job_x/2026-12-06T08:59:00.000Z", {
      job: "job_x",
      slot: "2026-12-06T08:59:00.000Z",
      status: "failed",
      late: false,
      attempt: 1,
      error: `BOOM\u202E\u0007${"x".repeat(400)}: rest of the host text`,
    })
    const report = createReport({ storage: storage.storage, location: "/nowhere", timezone: "UTC", clock: clock.clock, agent: agentsFake(), host: HOST, enabled: true, keepAliveMinutes: 20 })
    const status = await report.status()
    expect(status.failures).toHaveLength(1)
    const code = status.failures[0]!.code
    expect(code).not.toMatch(/[\u202A-\u202E\u0000-\u001f]/)
    expect(Array.from(code).length).toBeLessThanOrEqual(160)
    // The rendered rows are safe too.
    const text = formatStatus(buildStatus({ host: HOST, enabled: true, keepAliveMinutes: 20, failures: status.failures }))
    expect(text).not.toMatch(/[\u202A-\u202E\u0000-\u0008]/)
  })
})
