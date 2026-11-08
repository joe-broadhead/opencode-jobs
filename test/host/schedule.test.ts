// GAP-31: an `every` job whose slots pass while nothing is ticking (a stopped or unloaded server) must re-anchor to
// the next interval on the first pass, with one collapsed `missed` record, exactly as a cron job does.
import { afterAll, describe, expect, test } from "bun:test"
import type { Clock } from "../../src/jobs/clock.js"
import { MINUTE, parseJob, type Job } from "../../src/jobs/model.js"
import { readState, scanRuns } from "../../src/jobs/store.js"
import { cleanup, HOST_VERSION, startHost } from "./harness.js"

const START = Date.UTC(2026, 11, 6, 9, 0, 0)

afterAll(cleanup)

function manualClock(start: number) {
  let now = start
  const clock: Clock = {
    now: () => now,
    // Only the claim's settle resolves by itself; a longer wait belongs to the test, and an abort ends it.
    sleep: (ms, signal) =>
      ms <= 100
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            if (signal?.aborted === true) resolve()
            else signal?.addEventListener("abort", () => resolve(), { once: true })
          }),
  }
  return { clock, set: (at: number) => void (now = at) }
}

const GUARDED = {
  jobs: {
    description: "Runs scheduled jobs with read-only access",
    mode: "primary",
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
    ],
  },
}

const job = parseJob(
  { name: "Quarter", schedule: { every: "15 minutes" }, action: { type: "prompt", text: "Say ok." }, agent: "jobs", policy: { catchup: "none", timeout: "2m" } },
  { now: START, timezone: "UTC", id: "quarter", source: "tool", createdBy: "user" },
) as Job

describe(`a missed every slot in OpenCode ${HOST_VERSION}`, () => {
  test("advances to the next interval with one collapsed missed record after 45 unloaded minutes", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, loop: false, config: { agents: GUARDED } })
    try {
      const worker = host.worker()
      await worker.storage.set(`job/${job.id}`, job as never)
      // First pass anchors the interval: next due is 15 minutes out.
      await worker.runner.tick(START)
      expect((await readState(worker.storage, job.id)).nextDueAt).toBe(START + 15 * MINUTE)
      // Nothing ticks for four slots: the server was stopped or the job unloaded.
      manual.set(START + 60 * MINUTE)
      await worker.runner.tick(START + 60 * MINUTE)
      await worker.runner.settle()
      const records = (await scanRuns(worker.storage)).filter((record) => record.job === job.id)
      const missed = records.filter((record) => record.status === "missed")
      expect(missed).toHaveLength(1)
      expect(missed[0]).toMatchObject({ count: 4, from: new Date(START + 15 * MINUTE).toISOString(), slot: new Date(START + 60 * MINUTE).toISOString() })
      // The schedule is re-anchored in the future, so the next pass has a slot to wait for.
      expect((await readState(worker.storage, job.id)).nextDueAt).toBe(START + 75 * MINUTE)
    } finally {
      await host.close()
    }
  }, 120_000)
})
