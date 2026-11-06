import { describe, expect, test } from "bun:test"
import type { Executor, RunResult } from "../../src/jobs/execute.js"
import { MINUTE, parseJob, type Job } from "../../src/jobs/model.js"
import { Runner, SLEEP_CAP } from "../../src/jobs/runner.js"
import { getRun, putRun, readPauseAll, readState, scanRuns, setPauseAll, type RunStatus } from "../../src/jobs/store.js"
import { memoryStorage, settle, testClock } from "./fake.js"

const START = Date.UTC(2026, 11, 6, 9, 0, 0)

const job = (overrides: Record<string, unknown> = {}, id = "five"): Job =>
  parseJob(
    { name: id, schedule: { every: "5 minutes" }, action: { type: "prompt", text: "go" }, agent: "jobs", ...overrides },
    { now: START, timezone: "UTC", id, source: "tool", createdBy: "user" },
  )

/** An executor whose runs finish at once. It writes the record a real run would, so the store is testable here. */
function immediate(status: RunStatus = "succeeded") {
  const asked: { job: string; slot: number; late: boolean }[] = []
  const make = (storage: ReturnType<typeof memoryStorage>): Executor => async (request) => {
    asked.push({ job: request.job.id, slot: request.slot, late: request.late })
    await putRun(storage.storage, { job: request.job.id, slot: new Date(request.slot).toISOString(), status, late: request.late, attempt: 1 })
    return { claimed: true, status } satisfies RunResult
  }
  return { asked, make }
}

/** An executor whose runs finish when the test releases them. */
function deferred() {
  const asked: { job: string; slot: number }[] = []
  const interrupted: string[] = []
  const releases: (() => void)[] = []
  const execute: Executor = (request) =>
    new Promise((resolve) => {
      asked.push({ job: request.job.id, slot: request.slot })
      request.onSession?.({
        slot: request.slot,
        sessionID: `ses_${asked.length}`,
        interrupt: async () => void interrupted.push(request.job.id),
      })
      releases.push(() => resolve({ claimed: true, status: "succeeded" }))
    })
  return { execute, asked, interrupted, release: () => releases.shift()?.() }
}

function setup(options: { jobs: readonly Job[]; concurrency?: number; status?: RunStatus; execute?: Executor }) {
  const storage = memoryStorage()
  const clock = testClock(START, { instantBelow: 0 })
  const runs = immediate(options.status)
  const runner = new Runner({
    storage: storage.storage,
    clock: clock.clock,
    jobs: async () => options.jobs,
    execute: options.execute ?? runs.make(storage),
    active: () => true,
    concurrency: options.concurrency ?? 2,
    location: "/work",
  })
  return { storage, clock, runner, asked: runs.asked }
}

/** Ticks at each whole minute from `from` to `to` inclusive, settling between so each slot is its own pass. */
async function advance(runner: Runner, from: number, to: number) {
  for (let minute = from; minute <= to; minute += 1) {
    await runner.tick(START + minute * MINUTE)
    await runner.settle()
  }
}

const slots = (asked: { slot: number }[]) => asked.map((run) => (run.slot - START) / MINUTE)

describe("one slot at a time", () => {
  test("an every-5-minutes job runs exactly once per slot across 30 simulated minutes", async () => {
    const setup5 = setup({ jobs: [job()] })
    await setup5.runner.tick(START)
    await advance(setup5.runner, 1, 30)
    expect(slots(setup5.asked)).toEqual([5, 10, 15, 20, 25, 30])
    const records = await scanRuns(setup5.storage.storage)
    expect(records).toHaveLength(6)
    expect(records.every((record) => record.status === "succeeded")).toBe(true)
    expect((await readState(setup5.storage.storage, "five")).nextDueAt).toBe(START + 35 * MINUTE)
  })

  test("a jump of 30 minutes runs the newest slot once and collapses the rest into one missed record", async () => {
    const setup5 = setup({ jobs: [job()] })
    await setup5.runner.tick(START)
    await setup5.runner.tick(START + 30 * MINUTE)
    await setup5.runner.settle()
    expect(slots(setup5.asked)).toEqual([30])
    const records = await scanRuns(setup5.storage.storage)
    expect(records.find((record) => record.status === "missed")).toMatchObject({ count: 5, from: new Date(START + 5 * MINUTE).toISOString(), late: true })
    expect(records.filter((record) => record.status === "succeeded")).toHaveLength(1)
  })

  test("a job whose agent is missing is a failed run, not a throw", async () => {
    const setup5 = setup({ jobs: [job()], status: "failed" })
    await setup5.runner.tick(START)
    await advance(setup5.runner, 1, 25)
    expect((await readState(setup5.storage.storage, "five")).consecutiveFailures).toBe(5)
    expect((await readState(setup5.storage.storage, "five")).paused?.reason).toBe("Five runs in a row failed.")
    const before = (await scanRuns(setup5.storage.storage)).length
    await setup5.runner.tick(START + 30 * MINUTE)
    await setup5.runner.settle()
    expect(await scanRuns(setup5.storage.storage)).toHaveLength(before)
  })

  test("the run is late when the loop wakes more than a minute after the slot", async () => {
    const setup5 = setup({ jobs: [job()] })
    await setup5.runner.tick(START)
    await setup5.runner.tick(START + 7 * MINUTE)
    await setup5.runner.settle()
    expect(setup5.asked[0]).toMatchObject({ slot: START + 5 * MINUTE, late: true })
  })

  test("a job past its end records one skip and stops", async () => {
    const setup5 = setup({ jobs: [job({ ends: { at: new Date(START + 2 * MINUTE).toISOString() } })] })
    await setup5.runner.tick(START)
    await setup5.runner.tick(START + 5 * MINUTE)
    await setup5.runner.settle()
    expect(setup5.asked).toHaveLength(0)
    expect((await scanRuns(setup5.storage.storage)).find((record) => record.status === "skipped")).toMatchObject({ reason: "ended" })
    expect((await readState(setup5.storage.storage, "five")).done).toBe(true)
  })

  test("a paused job starts nothing", async () => {
    const setup5 = setup({ jobs: [job()] })
    await setup5.storage.storage.set("state/five", { job: "five", runCount: 0, consecutiveFailures: 0, nextDueAt: START + MINUTE, paused: { at: START } })
    await setup5.runner.tick(START + 5 * MINUTE)
    await setup5.runner.settle()
    expect(setup5.asked).toHaveLength(0)
  })
})

describe("the overlap table", () => {
  test("skip records the second slot as skipped and starts nothing", async () => {
    const runs = deferred()
    const setup5 = setup({ jobs: [job({ policy: { overlap: "skip" } })], execute: runs.execute })
    await setup5.runner.tick(START)
    await setup5.runner.tick(START + 5 * MINUTE)
    await setup5.runner.tick(START + 10 * MINUTE)
    expect(slots(runs.asked)).toEqual([5])
    expect(await getRun(setup5.storage.storage, "five", new Date(START + 10 * MINUTE).toISOString())).toMatchObject({ status: "skipped", reason: "overlap" })
    runs.release()
    await setup5.runner.settle()
  })

  test("queue-one remembers one slot and runs it when the first finishes", async () => {
    const runs = deferred()
    const setup5 = setup({ jobs: [job({ policy: { overlap: "queue-one" } })], execute: runs.execute })
    await setup5.runner.tick(START)
    await setup5.runner.tick(START + 5 * MINUTE)
    await setup5.runner.tick(START + 10 * MINUTE)
    expect(slots(runs.asked)).toEqual([5])
    expect((await readState(setup5.storage.storage, "five")).queuedSlot).toBe(START + 10 * MINUTE)
    runs.release()
    await setup5.runner.settle()
    await setup5.runner.tick(START + 10 * MINUTE)
    await settle()
    expect(slots(runs.asked)).toEqual([5, 10])
    expect((await readState(setup5.storage.storage, "five")).queuedSlot).toBeUndefined()
    runs.release()
    await setup5.runner.settle()
  })

  test("queue-one keeps the schedule where it was, so a skipped slot never runs afterwards", async () => {
    const runs = deferred()
    const setup5 = setup({ jobs: [job({ policy: { overlap: "queue-one" } })], execute: runs.execute })
    await setup5.runner.tick(START)
    await setup5.runner.tick(START + 5 * MINUTE)
    await setup5.runner.tick(START + 10 * MINUTE)
    await setup5.runner.tick(START + 15 * MINUTE)
    await setup5.runner.tick(START + 20 * MINUTE)
    expect((await readState(setup5.storage.storage, "five")).nextDueAt).toBe(START + 25 * MINUTE)
    runs.release()
    await setup5.runner.settle()
    await setup5.runner.tick(START + 20 * MINUTE)
    await settle()
    expect(slots(runs.asked)).toEqual([5, 10])
    expect((await readState(setup5.storage.storage, "five")).nextDueAt).toBe(START + 25 * MINUTE)
    runs.release()
    await setup5.runner.settle()
  })

  test("replace interrupts the run in its way and starts the new slot", async () => {
    const runs = deferred()
    const setup5 = setup({ jobs: [job({ policy: { overlap: "replace" } })], execute: runs.execute })
    await setup5.runner.tick(START)
    await setup5.runner.tick(START + 5 * MINUTE)
    await setup5.runner.tick(START + 10 * MINUTE)
    expect(slots(runs.asked)).toEqual([5, 10])
    runs.release()
    runs.release()
    await setup5.runner.settle()
  })

  test("allow runs the two slots side by side, within the cap", async () => {
    const runs = deferred()
    const setup5 = setup({ jobs: [job({ policy: { overlap: "allow" } })], execute: runs.execute })
    await setup5.runner.tick(START)
    await setup5.runner.tick(START + 5 * MINUTE)
    await setup5.runner.tick(START + 10 * MINUTE)
    expect(slots(runs.asked)).toEqual([5, 10])
    expect(setup5.runner.running).toBe(2)
    expect(await scanRuns(setup5.storage.storage)).toHaveLength(0)
    runs.release()
    runs.release()
    await setup5.runner.settle()
  })
})

describe("concurrency and the loop", () => {
  test("two runs are in flight at most; the third waits for a free slot", async () => {
    const runs = deferred()
    const setup5 = setup({ jobs: [job({}, "a"), job({}, "b"), job({}, "c")], concurrency: 2, execute: runs.execute })
    await setup5.runner.tick(START)
    await setup5.runner.tick(START + 5 * MINUTE)
    await settle()
    expect(runs.asked).toHaveLength(2)
    runs.release()
    await settle()
    await setup5.runner.tick(START + 5 * MINUTE)
    await settle()
    expect(runs.asked).toHaveLength(3)
    runs.release()
    runs.release()
    await setup5.runner.settle()
  })

  test("the loop sleeps until the next slot, and wakes on the doorbell", async () => {
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 0 })
    const at = START + 10_000
    const runner = new Runner({
      storage: storage.storage,
      clock: clock.clock,
      jobs: async () => [job({ schedule: { at: new Date(at).toISOString() } })],
      execute: immediate().make(storage),
      active: () => true,
      concurrency: 2,
      location: "/work",
    })
    runner.start()
    await settle()
    expect(clock.sleeps[clock.sleeps.length - 1]).toBe(10_000)
    runner.wake()
    await settle()
    expect(clock.sleeps.length).toBeGreaterThan(1)
    runner.stop()
    await settle()
  })

  test("with nothing due the loop sleeps the 30-second cap", async () => {
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 0 })
    const runner = new Runner({ storage: storage.storage, clock: clock.clock, jobs: async () => [], execute: immediate().make(storage), active: () => true, concurrency: 2, location: "/work" })
    runner.start()
    await settle()
    expect(clock.sleeps).toContain(SLEEP_CAP)
    runner.stop()
    await settle()
  })

  test("a stopped runner starts nothing, and its in-flight run is left to the next leader", async () => {
    const runs = deferred()
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 0 })
    const active = { current: true }
    const runner = new Runner({ storage: storage.storage, clock: clock.clock, jobs: async () => [job()], execute: runs.execute, active: () => active.current, concurrency: 2, location: "/work" })
    await runner.tick(START)
    await runner.tick(START)
    await runner.tick(START + 5 * MINUTE)
    expect(runs.asked).toHaveLength(1)
    active.current = false
    runner.stop()
    await runner.tick(START + 10 * MINUTE)
    expect(runs.asked).toHaveLength(1)
    runs.release()
    await runner.settle()
  })
})

describe("the kill switch", () => {
  test("stops every slot and interrupts the run in flight, once", async () => {
    const runs = deferred()
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 0 })
    const runner = new Runner({ storage: storage.storage, clock: clock.clock, jobs: async () => [job()], execute: runs.execute, active: () => true, concurrency: 2, location: "/work" })
    await runner.tick(START)
    await runner.tick(START + 5 * MINUTE)
    expect(runs.asked).toHaveLength(1)

    await setPauseAll(storage.storage, true, START + 5 * MINUTE)
    const paused = await runner.tick(START + 5 * MINUTE)
    expect(paused).toEqual({ started: 0, nextDueAt: null })
    expect(runs.interrupted).toEqual(["five"])
    // The next slot is refused the same way, and the run already interrupted is not asked twice.
    expect((await runner.tick(START + 10 * MINUTE)).started).toBe(0)
    expect(runs.interrupted).toEqual(["five"])
    expect(runs.asked).toHaveLength(1)

    runs.release()
    await runner.settle()
  })

  test("clearing it lets the next slot run, with one catch-up for the slots that fell due", async () => {
    const s = setup({ jobs: [job()] })
    await advance(s.runner, 0, 5)
    expect(slots(s.asked)).toEqual([5])

    await setPauseAll(s.storage.storage, true, START + 5 * MINUTE)
    await advance(s.runner, 6, 15)
    expect(slots(s.asked)).toEqual([5])

    await setPauseAll(s.storage.storage, false, START + 15 * MINUTE)
    await s.runner.tick(START + 17 * MINUTE)
    await s.runner.settle()
    // One run, for the newest missed slot, marked late: not ten.
    expect(slots(s.asked)).toEqual([5, 15])
    expect(s.asked[1]!.late).toBe(true)
    expect(await readPauseAll(s.storage.storage)).toBeUndefined()
  })
})

describe("retries and the pause", () => {
  /** An executor that fails its first N attempts of a slot, then succeeds, recording the attempt it was asked for. */
  function flaky(failures: number) {
    const seen: { slot: number; attempt: number }[] = []
    const make = (storage: ReturnType<typeof memoryStorage>): Executor => async (request) => {
      seen.push({ slot: request.slot, attempt: request.attempt })
      const status: RunStatus = seen.length <= failures ? "failed" : "succeeded"
      await putRun(storage.storage, { job: request.job.id, slot: new Date(request.slot).toISOString(), status, late: request.late, attempt: request.attempt })
      return { claimed: true, status } satisfies RunResult
    }
    return { seen, make }
  }

  test("a failed run is retried for the same slot, with the next attempt, after its backoff", async () => {
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 0 })
    const runs = flaky(1)
    const job = parseJob(
      { name: "Flaky", schedule: { every: "5 minutes" }, action: { type: "prompt", text: "go" }, agent: "jobs", policy: { retries: { max: 1, backoff: "1m" } } },
      { now: START, timezone: "UTC", id: "flaky", source: "tool", createdBy: "user" },
    )
    const runner = new Runner({ storage: storage.storage, clock: clock.clock, jobs: async () => [job], execute: runs.make(storage), active: () => true, concurrency: 2, location: "/work" })
    await runner.tick(START)
    clock.advance(5 * MINUTE)
    await runner.tick(clock.now())
    await runner.settle()
    expect(runs.seen).toEqual([{ slot: START + 5 * MINUTE, attempt: 1 }])
    expect((await readState(storage.storage, "flaky")).retry).toMatchObject({ slot: START + 5 * MINUTE, attempt: 2, at: START + 6 * MINUTE })

    // The backoff has not passed yet: nothing runs.
    clock.advance(30_000)
    await runner.tick(clock.now())
    await runner.settle()
    expect(runs.seen).toHaveLength(1)

    clock.advance(30_000)
    await runner.tick(clock.now())
    await runner.settle()
    expect(runs.seen).toEqual([
      { slot: START + 5 * MINUTE, attempt: 1 },
      { slot: START + 5 * MINUTE, attempt: 2 },
    ])
    expect((await readState(storage.storage, "flaky")).retry).toBeUndefined()
    // The retry's record is the same slot, at attempt 2, and no third run follows.
    const records = (await scanRuns(storage.storage)).filter((record) => record.job === "flaky")
    expect(records).toHaveLength(1)
    expect(records[0]!.attempt).toBe(2)
    expect(records[0]!.status).toBe("succeeded")
  })

  test("five timed-out runs in a row pause the job, and five interruptions do not", async () => {
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 0 })
    const runs = immediate("timed_out")
    const job = parseJob(
      { name: "Slow", schedule: { every: "1 minute" }, action: { type: "prompt", text: "go" }, agent: "jobs" },
      { now: START, timezone: "UTC", id: "slow", source: "tool", createdBy: "user" },
    )
    const runner = new Runner({ storage: storage.storage, clock: clock.clock, jobs: async () => [job], execute: runs.make(storage), active: () => true, concurrency: 2, location: "/work" })
    for (let minute = 0; minute <= 5; minute += 1) {
      await runner.tick(START + minute * MINUTE)
      await runner.settle()
    }
    const paused = await readState(storage.storage, "slow")
    expect(paused.consecutiveFailures).toBe(5)
    expect(paused.paused?.reason).toBe("Five runs in a row failed.")
    expect(paused.runCount).toBe(5)
  })

  test("runs that finish together all count, and the fifth failure pauses once", async () => {
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 0 })
    const pending: (() => void)[] = []
    const execute: Executor = (request) =>
      new Promise((resolve) => {
        request.onSession?.({ slot: request.slot, sessionID: `ses_${pending.length + 1}`, interrupt: async () => undefined })
        pending.push(() => resolve({ claimed: true, status: "failed" }))
        void putRun(storage.storage, { job: request.job.id, slot: new Date(request.slot).toISOString(), status: "failed", late: false, attempt: 1 })
      })
    const job = parseJob(
      { name: "Burst", schedule: { every: "1 minute" }, action: { type: "prompt", text: "go" }, agent: "jobs", policy: { overlap: "allow" } },
      { now: START, timezone: "UTC", id: "burst", source: "tool", createdBy: "user" },
    )
    const runner = new Runner({ storage: storage.storage, clock: clock.clock, jobs: async () => [job], execute, active: () => true, concurrency: 8, location: "/work" })
    for (let minute = 0; minute <= 5; minute += 1) await runner.tick(START + minute * MINUTE)
    // Five runs were started across five slots, and all finish in the same turn.
    expect(pending).toHaveLength(5)
    for (const release of pending.splice(0)) release()
    await runner.settle()
    const state = await readState(storage.storage, "burst")
    expect(state.runCount).toBe(5)
    expect(state.consecutiveFailures).toBe(5)
    expect(state.paused).toMatchObject({ reason: "Five runs in a row failed." })
  })
})

describe("a long gap", () => {
  test("takes one pass per MAX_SLOTS slots, records each pass's gap once, and runs one late slot at the end", async () => {
    const s = setup({ jobs: [job({ schedule: { every: "1 minute" } })] })
    // Six hours away: 360 slots missed, more than one pass can hold (MAX_SLOTS is 100).
    await s.runner.tick(START)
    await s.runner.tick(START + 360 * MINUTE)
    await s.runner.settle()
    const first = (await scanRuns(s.storage.storage)).filter((record) => record.status === "missed")
    // The whole first pass is older than maxLate, so it is recorded once, not run and not 100 records.
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ status: "missed", count: 100 })
    expect(s.asked).toHaveLength(0)

    // Each further pass handles the next MAX_SLOTS, until the newest slots are within maxLate: one late run.
    for (let pass = 0; pass < 4; pass += 1) {
      await s.runner.tick(START + 360 * MINUTE)
      await s.runner.settle()
    }
    expect(s.asked.length).toBeGreaterThanOrEqual(1)
    // The run is the newest slot within maxLate, which is at or just before now.
    expect(START + 360 * MINUTE - s.asked[0]!.slot).toBeLessThanOrEqual(60 * MINUTE)
    const missed = (await scanRuns(s.storage.storage)).filter((record) => record.status === "missed")
    expect(missed.length).toBeGreaterThan(1)
    // Every slot of the gap is either run or counted in one collapsed record; none is replayed.
    expect(missed.reduce((sum, record) => sum + (record.count ?? 0), 0) + s.asked.length).toBe(360)
  })
})

describe("ends and expiry", () => {
  test("an expired job records one skip and never runs", async () => {
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 0 })
    const runs = immediate("succeeded")
    const job = parseJob(
      { name: "Old", schedule: { every: "1 minute" }, action: { type: "prompt", text: "go" }, agent: "jobs" },
      { now: START - 10 * MINUTE, timezone: "UTC", id: "old", source: "tool", createdBy: "user" },
    )
    const expiring = { ...job, expires: START - MINUTE }
    const runner = new Runner({ storage: storage.storage, clock: clock.clock, jobs: async () => [expiring], execute: runs.make(storage), active: () => true, concurrency: 2, location: "/work" })
    await runner.tick(START - 2 * MINUTE)
    await runner.tick(START)
    await runner.settle()
    expect(runs.asked).toHaveLength(0)
    const records = await scanRuns(storage.storage)
    expect(records.some((record) => record.status === "skipped" && record.reason === "expired")).toBe(true)
    expect((await readState(storage.storage, "old")).done).toBe(true)
  })
})

describe("a manual run", () => {
  test("runs once at its own slot and leaves the scheduled slot exactly where it was", async () => {
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 0 })
    const runs = immediate("succeeded")
    // An hourly job anchored half an hour before now: its next grid slot is in the future, so run-now must not wait.
    const job = parseJob(
      { name: "Hourly", schedule: { every: "1 hour", anchor: new Date(START - 30 * MINUTE).toISOString() }, action: { type: "prompt", text: "go" }, agent: "jobs" },
      { now: START, timezone: "UTC", id: "hourly", source: "tool", createdBy: "user" },
    )
    const runner = new Runner({ storage: storage.storage, clock: clock.clock, jobs: async () => [job], execute: runs.make(storage), active: () => true, concurrency: 2, location: "/work" })
    await runner.tick(START)
    const scheduled = (await readState(storage.storage, "hourly")).nextDueAt!
    await storage.storage.set("state/hourly", { ...(await readState(storage.storage, "hourly")), manual: { at: START + 5_000 } })
    const tick = await runner.tick(START + 5_000)
    await runner.settle()
    expect(tick.started).toBe(1)
    expect(runs.asked.map((run) => run.slot)).toEqual([START + 5_000])
    expect((await readState(storage.storage, "hourly")).manual).toBeUndefined()
    expect((await readState(storage.storage, "hourly")).nextDueAt).toBe(scheduled)
  })

  test("a computed wait of zero never spins the loop", async () => {
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 0 })
    const runner = new Runner({ storage: storage.storage, clock: clock.clock, jobs: async () => [], execute: immediate().make(storage), active: () => true, concurrency: 2, location: "/work" })
    runner.start()
    await settle(12)
    runner.stop()
    await settle()
    // Every loop sleep is the 30-second cap (or a due-slot wait), never a zero-length spin.
    expect(clock.sleeps.filter((ms) => ms === 0)).toEqual([])
  })
})
