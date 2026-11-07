// A file job's script is re-read from the file: an edited file with an old approval is skipped unapproved, never run
// (SR-5). The run receives the file's current definition.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { execute } from "../../src/jobs/execute.js"
import { readJobFiles } from "../../src/jobs/files.js"
import { approvalCurrent, approvalMatches, digestOf, manifestDigest, sourceHash, type ResolvedTool, type ScriptApproval } from "../../src/jobs/script.js"
import type { ScriptGate } from "../../src/jobs/script-gate.js"
import { putState, scanRuns } from "../../src/jobs/store.js"
import { memoryStorage, sessionFake, testClock } from "./fake.js"

const START = Date.UTC(2026, 11, 6, 9, 0, 0)
const RESOLVED: readonly ResolvedTool[] = [{ method: "host:mem", action: "mem", class: "unclassified", kind: "host", effect: "allow" }]
const file = (code: string) => `---\nname: File script\nschedule:\n  every: 1 hour\nagent: build\naction:\n  type: script\n  script:\n    uses:\n      - host:mem\n    code: |\n${code.split("\n").map((line) => `      ${line}`).join("\n")}\n---\n`

async function jobFrom(root: string) {
  const { jobs, invalid } = await readJobFiles({ now: START, timezone: "UTC", projects: [root] })
  expect(invalid).toEqual([])
  return jobs[0]!
}

describe("a file job's script", () => {
  test("a code edit makes the stored approval stale, and the run skips unapproved", async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "jobs-file-script-")))
    try {
      const folder = join(root, ".opencode", "jobs")
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, "status.md"), file("return 1"))
      const first = await jobFrom(root)
      expect(first.action.type).toBe("script")
      const script = first.action.type === "script" ? first.action.script : undefined!
      const approval: ScriptApproval = { sourceHash: sourceHash(script.code), manifestDigest: manifestDigest(script.uses), digest: digestOf(script), at: START, resolved: RESOLVED }
      expect(approvalCurrent(approval, script)).toBe(true)

      // The person edits the file. The next read is the new code, and the old approval no longer covers it.
      writeFileSync(join(folder, "status.md"), file("return 2"))
      const second = await jobFrom(root)
      const changed = second.action.type === "script" ? second.action.script : undefined!
      expect(changed.code).toContain("return 2")
      expect(approvalCurrent(approval, changed)).toBe(false)
      expect(approvalMatches(approval, changed, RESOLVED)).toBe(false)

      // The run reads the file's current job and the stored approval: it is skipped, and nothing starts.
      const storage = memoryStorage()
      const session = sessionFake()
      const scripts: ScriptGate = { resolve: async () => RESOLVED, approve: async () => approval }
      await putState(storage.storage, { job: second.id, runCount: 0, consecutiveFailures: 0, nextDueAt: START, approval })
      const result = await execute({
        storage: storage.storage,
        session: session.session,
        agents: { get: async () => ({ data: { id: "build", name: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] } }) } as never,
        clock: testClock(START, { instantBelow: 100 }).clock,
        location: root,
        token: "leader-1",
        job: second,
        slot: START,
        attempt: 1,
        late: false,
        active: () => true,
        scripts,
        tool: { list: async () => [] } as never,
        rpc: (() => ({})) as never,
      } as never)
      expect(result.status).toBe("skipped")
      expect(session.created).toHaveLength(0)
      expect((await scanRuns(storage.storage, second.id))[0]?.reason).toBe("unapproved")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
