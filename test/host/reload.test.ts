// Reload and stall recovery, in an embedded host of one tested release.
//
// An in-place reload is what `opencode plugin update` does: the host runs `cleanup` and then `setup` again. The tests
// cover the three things a soak could not tell apart: an overdue slot surviving the reload and running once; the old
// instance's timers, lease and run sessions stopping; and a stall (a frozen event loop, which the injected clock jumps
// over) recovering on its own. Ticking is by hand where the assertion is about one pass, and by the plugin's own loop
// where it is about timers.
import { afterAll, describe, expect, test } from "bun:test"
import type { Clock } from "../../src/jobs/clock.js"
import { MINUTE, parseJob, type Job } from "../../src/jobs/model.js"
import { isJobSession } from "../../src/jobs/safety.js"
import { readState, scanRuns } from "../../src/jobs/store.js"
import { cleanup, HOST_VERSION, startHost, until, type Host } from "./harness.js"

const START = Date.UTC(2026, 11, 6, 9, 0, 0)

afterAll(cleanup)

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

/** A clock the test moves; a sleep resolves when its deadline passes or its signal aborts, as the real one's does. */
function manualClock(start: number) {
  let now = start
  const pending: { at: number; done: () => void }[] = []
  const clock: Clock = {
    now: () => now,
    sleep: (ms, signal) =>
      ms <= 100
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            if (signal?.aborted === true) return resolve()
            const entry = {
              at: now + ms,
              done: () => {
                signal?.removeEventListener("abort", entry.done)
                const index = pending.indexOf(entry)
                if (index !== -1) pending.splice(index, 1)
                resolve()
              },
            }
            signal?.addEventListener("abort", entry.done, { once: true })
            pending.push(entry)
          }),
  }
  return {
    clock,
    now: () => now,
    /** Moves the clock and releases every sleep whose deadline has passed. */
    set(at: number) {
      now = at
      for (const entry of [...pending]) if (entry.at <= at) entry.done()
    },
    pending: () => pending.length,
  }
}

const jobOf = (): Job =>
  parseJob(
    { name: "Minute", schedule: { every: "1 minute" }, action: { type: "prompt", text: "Say ok." }, agent: "jobs", policy: { timeout: "2m" } },
    { now: START, timezone: "UTC", id: "job_minute", source: "tool", createdBy: "user" },
  )

const at = (minute: number) => new Date(START + minute * MINUTE).toISOString()
const records = async (host: Host) => (await scanRuns(host.worker().storage)).filter((record) => record.job === "job_minute").sort((left, right) => Date.parse(left.slot) - Date.parse(right.slot))
/** Terminal runs: a record still queued or running is not a run that happened yet. */
const runsOf = async (host: Host) => (await records(host)).filter((record) => record.status !== "missed" && record.status !== "queued" && record.status !== "running")

const untilRuns = (host: Host, count: number, timeout = 30_000) =>
  until(`${count} run record(s)`, async () => {
    const runs = await runsOf(host)
    return runs.length >= count ? runs : undefined
  }, timeout)

/** Gives the store the slot a prior run planned, so a reload finds it overdue. */
const plan = async (host: Host, job: Job, minute: number) => {
  await host.worker().storage.set(`job/${job.id}`, job as never)
  await host.worker().storage.set(`state/${job.id}`, { job: job.id, nextDueAt: START + minute * MINUTE, runCount: 0, consecutiveFailures: 0 })
}

async function reloadAndLead(host: Host, setups: number): Promise<void> {
  await host.client.location.reload()
  await until("the plugin reloads and its leader leads", async () => host.setups() > setups && host.leader().isLeader, 30_000)
}

describe(`reload and stall recovery in OpenCode ${HOST_VERSION}`, () => {
  test("an overdue slot survives an in-place reload, runs once, and the cadence continues", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, loop: false, config: { agents: GUARDED } })
    try {
      const first = host.worker()
      const job = jobOf()
      await plan(host, job, 1)
      // The slots at 09:01 and 09:02 fall due and a bundle update reloads the plugin before any pass reaches them.
      manual.set(START + 4 * MINUTE + 30_000)
      const setups = host.setups()
      await reloadAndLead(host, setups)
      const second = host.worker()
      expect(first.leader.isLeader).toBe(false)
      expect(second.leader.token).not.toBe(first.leader.token)

      // One tick of the new runner runs the newest overdue slot once, as catch-up.
      await second.runner.tick(manual.now())
      await second.runner.settle()
      const afterReload = await runsOf(host)
      expect(afterReload).toHaveLength(1)
      // The newest overdue slot is the one that ran; the older ones are the collapsed record below.
      expect(afterReload[0]).toMatchObject({ status: "succeeded", slot: at(4) })
      expect((await records(host)).filter((record) => record.status === "missed").map((record) => record.count)).toEqual([3])

      // The next slots run on time, one record each.
      for (const minute of [5, 6, 7]) {
        manual.set(START + minute * MINUTE)
        await second.runner.tick(manual.now())
        await second.runner.settle()
      }
      expect((await runsOf(host)).map((record) => record.slot)).toEqual([4, 5, 6, 7].map(at))
      expect((await readState(second.storage, job.id)).nextDueAt).toBe(START + 8 * MINUTE)
    } finally {
      await host.close()
    }
  }, 120_000)

  test("five reloads in quick succession leave one leader, and no slot runs twice", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, loop: false, config: { agents: GUARDED } })
    try {
      const first = host.worker()
      const job = jobOf()
      await plan(host, job, 1)
      manual.set(START + 3 * MINUTE)
      const tokens = new Set<string>([first.leader.token])
      for (let round = 0; round < 5; round += 1) {
        const setups = host.setups()
        await reloadAndLead(host, setups)
        tokens.add(host.leader().token)
      }
      expect(tokens.size).toBe(6)
      const worker = host.worker()
      await worker.runner.tick(manual.now())
      await worker.runner.settle()
      const runs = await runsOf(host)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.slot).toBe(at(3))
      expect(worker.leader.isLeader).toBe(true)
      // No earlier instance leads any more.
      expect(first.leader.isLeader).toBe(false)
    } finally {
      await host.close()
    }
  }, 180_000)

  test("a reload stops the old instance's keep-alive and runner, and only the new one acts", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, options: { keepAliveMinutes: 1 }, config: { agents: GUARDED } })
    try {
      const first = host.worker()
      const job = jobOf()
      await plan(host, job, 1)
      // Let the loop plan and run 09:01 on its own timers.
      manual.set(START + 30_000)
      await until("the loop plans the first slot", async () => (await readState(first.storage, job.id)).nextDueAt === START + MINUTE, 30_000)
      // Past the slot by half a minute: real time moves on, so the loop's capped sleep ends and the slot runs.
      // The runner's own loop is asleep on its doorbell before the clock moves: no race with setup.
      await until("the runner is asleep on its doorbell", async () => manual.pending() >= 3, 30_000)
      manual.set(START + MINUTE + 31_000)
      await untilRuns(host, 1)

      const oldBeats = first.keepAlive.beats
      expect(oldBeats).toBeGreaterThanOrEqual(0)
      const setups = host.setups()
      await reloadAndLead(host, setups)
      const second = host.worker()
      expect(first.leader.isLeader).toBe(false)
      // The old instance has no keep-alive and no runner at all: its timers were released on cleanup.
      expect(() => first.keepAlive).toThrow("the keep-alive is not running")
      expect(() => first.runner).toThrow("the runner is not running")
      const newBeats = second.keepAlive.beats

      // Two more slots elapse, one minute at a time: the new keep-alive beats, the old one is gone, and only the new
      // runner records runs.
      manual.set(START + 2 * MINUTE + 31_000)
      await untilRuns(host, 2)
      manual.set(START + 3 * MINUTE + 31_000)
      await untilRuns(host, 3)
      expect(second.keepAlive.beats).toBeGreaterThan(newBeats)
      const slots = (await runsOf(host)).map((record) => record.slot)
      expect(slots).toEqual([1, 2, 3].map(at))
      expect((await readState(second.storage, job.id)).nextDueAt).toBe(START + 4 * MINUTE)
    } finally {
      await host.close()
    }
  }, 180_000)

  test("a stall longer than the lease and several slots recovers on its own, with one collapsed missed record", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, options: { keepAliveMinutes: 1 }, config: { agents: GUARDED } })
    try {
      const job = jobOf()
      await plan(host, job, 1)
      // The event loop freezes after 09:01 is planned: the clock jumps past the 60-second lease and six slots at once.
      manual.set(START + 9 * MINUTE + 30_000)
      const runs = await untilRuns(host, 1, 40_000)
      // The newest due slot ran once; the ones before it are in the collapsed record.
      expect(runs[0]).toMatchObject({ slot: at(9) })
      const missed = (await records(host)).filter((record) => record.status === "missed")
      expect(missed).toHaveLength(1)
      expect(missed[0]!.count).toBe(8)
      // It re-leads (or keeps the lease) and the cadence resumes on the next slot.
      expect(host.leader().isLeader).toBe(true)
      manual.set(START + 10 * MINUTE)
      const after = await untilRuns(host, 2)
      expect(after.map((record) => record.slot)).toEqual([at(9), at(10)])
    } finally {
      await host.close()
    }
  }, 180_000)

  test("an old runner woken after a reload does not lead, and a run's session leaves the registry when it ends", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, loop: false, config: { agents: GUARDED } })
    try {
      const first = host.worker()
      const job = jobOf()
      await plan(host, job, 1)
      await first.runner.tick(START + MINUTE)
      await first.runner.settle()
      const runSession = (await runsOf(host))[0]!.sessionID
      expect(runSession).toBeString()
      // The run is finalised, so its session has left the registry: a backstop with nothing left to protect.
      expect(isJobSession(runSession!)).toBe(false)

      const setups = host.setups()
      await reloadAndLead(host, setups)
      expect(first.leader.isLeader).toBe(false)
      // The old instance has no runner at all after its step down: nothing of it can tick.
      expect(() => first.runner).toThrow("the runner is not running")
      manual.set(START + 2 * MINUTE)
      const second = host.worker()
      await second.runner.tick(manual.now())
      await second.runner.settle()
      expect((await runsOf(host)).map((record) => record.slot)).toEqual([at(1), at(2)])
      expect(second.leader.isLeader).toBe(true)
    } finally {
      await host.close()
    }
  }, 120_000)
})
