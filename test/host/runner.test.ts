// The runner and the executor inside an embedded OpenCode host of one tested release, with the clock injected and a
// loopback mock model: a job fires once per slot, a run records its outcome and summary, a timeout interrupts at the
// bound, a guarded agent refuses a tool instead of hanging, and a hot reload hands the run to the next leader.
import { afterAll, describe, expect, test } from "bun:test"
import type { Clock } from "../../src/jobs/clock.js"
import { MINUTE, parseJob, type Job } from "../../src/jobs/model.js"
import { readState, scanRuns } from "../../src/jobs/store.js"
import { cleanup, HOST_VERSION, startHost, until, type Host, type Worker } from "./harness.js"

const START = Date.UTC(2026, 11, 6, 9, 0, 0)

afterAll(cleanup)

/** A clock the test sets; only the claim's settle delay resolves by itself, so a run's real work is what finishes it. */
function manualClock(start: number) {
  let now = start
  const clock: Clock = {
    now: () => now,
    // Short waits, such as the claim's settle, resolve; a job's timeout or a retry waits for the test, and a kick
    // (an aborted sleep) resolves it so a leader hand-over is immediate.
    sleep: (ms, signal) =>
      ms <= 100
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            if (signal?.aborted === true) resolve()
            else signal?.addEventListener("abort", () => resolve(), { once: true })
          }),
  }
  return {
    clock,
    set(at: number) {
      now = at
    },
  }
}

/** The documented read-only agent: a blanket deny first, then the reads. A tool it does not allow is never offered. */
const GUARDED = {
  jobs: {
    description: "Runs scheduled jobs with read-only access",
    mode: "primary",
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "list", resource: "*", effect: "allow" },
    ],
  },
}

const jobOf = (seed: number, overrides: Record<string, unknown> = {}, now = START): Job =>
  parseJob(
    { name: "Five", schedule: { every: "5 minutes" }, action: { type: "prompt", text: "Say ok." }, agent: "jobs", policy: { timeout: "2m" }, ...overrides },
    { now, timezone: "UTC", id: `job_${seed}`, source: "tool", createdBy: "user" },
  )

async function create(worker: Worker, job: Job): Promise<void> {
  await worker.storage.set(`job/${job.id}`, job as never)
}

const runSessionIDs = async (host: Host, worker: Worker, job: Job) => {
  const records = (await scanRuns(worker.storage)).filter((record) => record.job === job.id)
  void host
  return records
}

describe(`the runner in OpenCode ${HOST_VERSION}`, () => {
  test("an every-5-minutes job runs once per slot across 30 simulated minutes", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, loop: false, config: { agents: GUARDED } })
    try {
      const worker = host.worker()
      const job = jobOf(1)
      await create(worker, job)
      await worker.runner.tick(START)
      await worker.runner.settle()
      for (let minute = 5; minute <= 30; minute += 5) {
        manual.set(START + minute * MINUTE)
        await worker.runner.tick(START + minute * MINUTE)
        await worker.runner.settle()
      }

      const records = await runSessionIDs(host, worker, job)
      expect(records).toHaveLength(6)
      expect(records.every((record) => record.status === "succeeded")).toBe(true)
      expect(records.every((record) => record.summary === "ok")).toBe(true)
      const sessions = new Set(records.map((record) => record.sessionID).filter((id): id is string => id !== undefined))
      expect(sessions.size).toBe(6)
      expect((await readState(worker.storage, job.id)).nextDueAt).toBe(START + 35 * MINUTE)

      // Every run session is a child of one parked "Jobs" parent, and the top level holds only that parent.
      const top = await host.client.session.list({ directory: host.location.directory, parentID: null })
      const parent = top.data.find((session) => session.title === "Jobs")
      expect(parent).toBeDefined()
      const children = await host.client.session.list({ directory: host.location.directory, parentID: parent!.id })
      expect(new Set(children.data.map((session) => session.id))).toEqual(sessions)
      expect(host.mock().calls()).toBeGreaterThanOrEqual(6)
    } finally {
      await host.close()
    }
  }, 120_000)

  test("a timeout interrupts at the bound and records timed_out", async () => {
    // The timeout is real time, so this host keeps the system clock and places the slot a minute ago.
    const host = await startHost({ loop: false, config: { agents: GUARDED } })
    try {
      const worker = host.worker()
      const now = Date.now()
      const job = jobOf(2, { policy: { timeout: "1s" }, action: { type: "prompt", text: "[[mock:slow:30]]" } }, now)
      await create(worker, job)
      await worker.storage.set(`state/${job.id}`, { job: job.id, nextDueAt: now - MINUTE, runCount: 0, consecutiveFailures: 0 })
      const began = Date.now()
      await worker.runner.tick(now)
      const record = await until("the run times out", async () => {
        const found = (await scanRuns(worker.storage)).find((entry) => entry.job === job.id && entry.status !== "queued" && entry.status !== "running")
        return found
      }, 20_000)
      expect(record.status).toBe("timed_out")
      expect(Date.now() - began).toBeLessThan(20_000)
      const info = (await host.client.session.get({ sessionID: record.sessionID! })) as { outcome?: string }
      expect(info.outcome).toBe("interrupted")
      expect(await host.probe().permission.list({ sessionID: record.sessionID! })).toEqual([])
    } finally {
      await host.close()
    }
  }, 120_000)

  test("a guarded agent refuses a tool needing approval, and the run finishes instead of hanging", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, loop: false, config: { agents: GUARDED } })
    try {
      const worker = host.worker()
      const job = jobOf(3, { action: { type: "prompt", text: '[[mock:tool:shell:{"command":"echo job-ran"}]]' } })
      await create(worker, job)
      await worker.storage.set(`state/${job.id}`, { job: job.id, nextDueAt: START, runCount: 0, consecutiveFailures: 0 })
      const began = Date.now()
      await worker.runner.tick(START)
      await worker.runner.settle()
      const record = (await scanRuns(worker.storage)).find((entry) => entry.job === job.id)
      expect(record?.status).toBe("succeeded")
      expect(Date.now() - began).toBeLessThan(60_000)
      expect(await host.probe().permission.list({ sessionID: record!.sessionID! })).toEqual([])
      const context = (await host.probe().session.context({ sessionID: record!.sessionID! })) as { type: string; content?: { type: string; text?: string }[] }[]
      const toolError = context.flatMap((message) => message.content ?? []).map((part) => part.text ?? "").join(" ")
      expect(toolError).toContain("No tool named")
      expect(record?.summary).toContain("No tool named")
    } finally {
      await host.close()
    }
  }, 120_000)

  test("a hot reload mid-run: the session finishes and the new leader finalises the record once", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, loop: false, config: { agents: GUARDED } })
    try {
      const first = host.worker()
      const job = jobOf(4, { policy: { timeout: "2m" }, action: { type: "prompt", text: "[[mock:slow:4]]" } })
      await create(first, job)
      await first.storage.set(`state/${job.id}`, { job: job.id, nextDueAt: START, runCount: 0, consecutiveFailures: 0 })
      await first.runner.tick(START)

      const running = await until("the run starts", async () => (await scanRuns(first.storage)).find((record) => record.job === job.id && record.status === "running"))
      expect(running.sessionID).toBeString()
      const setups = host.setups()

      await host.client.location.reload()
      await until("the plugin reloads and the new leader takes over", async () => host.setups() > setups && host.leader().isLeader && host.worker().leader.token !== first.leader.token, 30_000)
      const second = host.worker()
      expect(second.leader.token).not.toBe(first.leader.token)

      const finished = await until("the new leader finalises the run", async () => {
        const record = (await scanRuns(second.storage)).find((entry) => entry.job === job.id && entry.status === "succeeded")
        return record
      }, 30_000)
      expect(finished.summary).toContain("slow done")
      const settledAt = finished.endedAt
      await Bun.sleep(1_000)

      const records = (await scanRuns(second.storage)).filter((record) => record.job === job.id)
      expect(records).toHaveLength(1)
      expect(records[0]!.endedAt).toBe(settledAt)
      const children = await host.client.session.list({ directory: host.location.directory, parentID: undefined })
      expect(children.data.filter((session) => session.id === running.sessionID)).toHaveLength(1)
    } finally {
      await host.close()
    }
  }, 120_000)

  test("two locations: one leader, and 50 slots with no double run", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, loop: false, config: { agents: GUARDED } })
    try {
      const leader = host.worker()
      const other = await host.open(host.sibling("second"))
      expect(leader.leader.isLeader).toBe(true)
      expect(other.probe).toBeDefined()
      expect(host.leader(host.sibling("second")).isLeader).toBe(false)

      const job = jobOf(5, { schedule: { every: "1 minute" } })
      await create(leader, job)
      await leader.runner.tick(START)
      await leader.runner.settle()

      for (let minute = 1; minute <= 50; minute += 1) {
        const at = START + minute * MINUTE
        manual.set(at)
        await leader.runner.tick(at)
        await leader.runner.settle()
      }

      const records = (await scanRuns(leader.storage)).filter((record) => record.job === job.id)
      expect(records).toHaveLength(50)
      expect(new Set(records.map((record) => record.slot)).size).toBe(50)
      expect(records.every((record) => record.status === "succeeded")).toBe(true)
    } finally {
      await host.close()
    }
  }, 180_000)

  test("the keep-alive creates and removes an empty session with no model call", async () => {
    const host = await startHost({ loop: false, config: { agents: GUARDED } })
    try {
      const worker = host.worker()
      const before = host.mock().calls()
      const top = await host.client.session.list({ directory: host.location.directory, parentID: null })
      expect(await worker.keepAlive.beat()).toBe(true)
      expect(await worker.keepAlive.beat()).toBe(true)
      expect(worker.keepAlive.beats).toBe(2)
      expect(host.mock().calls()).toBe(before)
      const after = await host.client.session.list({ directory: host.location.directory, parentID: null })
      expect(after.data).toHaveLength(top.data.length)
    } finally {
      await host.close()
    }
  }, 120_000)
})
