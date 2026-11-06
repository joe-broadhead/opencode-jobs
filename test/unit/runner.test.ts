import { describe, expect, test } from "bun:test"
import type { Executor, RunResult } from "../../src/jobs/execute.js"
import { MINUTE, parseJob, type Job } from "../../src/jobs/model.js"
import { Runner, SLEEP_CAP } from "../../src/jobs/runner.js"
import { getRun, putRun, readState, scanRuns, type RunStatus } from "../../src/jobs/store.js"
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
  const releases: (() => void)[] = []
  const execute: Executor = (request) =>
    new Promise((resolve) => {
      asked.push({ job: request.job.id, slot: request.slot })
      request.onSession?.({ slot: request.slot, sessionID: `ses_${asked.length}`, interrupt: async () => undefined })
      releases.push(() => resolve({ claimed: true, status: "succeeded" }))
    })
  return { execute, asked, release: () => releases.shift()?.() }
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
