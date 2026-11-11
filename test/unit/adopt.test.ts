import { describe, expect, test } from "bun:test"
import { adopt } from "../../src/jobs/adopt.js"
import { parseJob, type Job } from "../../src/jobs/model.js"
import { putRun, getRun, type RunRecord, type Storage } from "../../src/jobs/store.js"
import { isJobSession } from "../../src/jobs/safety.js"
import { memoryStorage, sessionFake, settle, testClock } from "./fake.js"

const START = Date.UTC(2026, 11, 6, 9, 0, 0)
const SLOT = new Date(START - 60_000).toISOString()

const job = (): Job =>
  parseJob(
    { name: "Five", schedule: { every: "5 minutes" }, action: { type: "prompt", text: "go" }, agent: "jobs", policy: { timeout: "30m" } },
    { now: START, timezone: "UTC", id: "five", source: "tool", createdBy: "user" },
  )

const running = (extra: Partial<RunRecord> = {}): RunRecord => ({ job: "five", slot: SLOT, status: "running", late: false, attempt: 1, token: "old", sessionID: "ses_1", startedAt: START - 60_000, ...extra })

const input = (overrides: { record?: RunRecord; session?: ReturnType<typeof sessionFake>; storage?: ReturnType<typeof memoryStorage> } = {}) => {
  const storage = overrides.storage ?? memoryStorage()
  const session = overrides.session ?? sessionFake({ answer: "finished later", outcome: "succeeded", startBusy: true })
  const clock = testClock(START, { instantBelow: 0 })
  const active = { current: true }
  return {
    storage,
    session,
    clock,
    active,
    run: () =>
      adopt({ storage: storage.storage, session: session.session, clock: clock.clock, active: () => active.current, jobs: [job()], owned: () => false }),
    record: overrides.record ?? running(),
  }
}

describe("adoption after a reload or a crash", () => {
  test("a busy session is re-attached, then finalised from its outcome, once", async () => {
    const setup = input()
    await putRun(setup.storage.storage, setup.record)
    const pending = setup.run()
    await settle()
    expect(setup.session.waiting).toContain("ses_1")
    // The adopted session is registered as a run session, so the evaluate hook covers it in this process too.
    expect(isJobSession("ses_1")).toBe(true)
    setup.session.release()
    const adopted = await pending
    expect(adopted.reattached).toBe(1)
    expect(adopted.finalised).toHaveLength(1)
    expect(await getRun(setup.storage.storage, "five", SLOT)).toMatchObject({ status: "succeeded", outcome: "succeeded", summary: "finished later" })
  })

  test("a session that is gone leaves the record interrupted", async () => {
    const setup = input({ session: sessionFake({ gone: true }) })
    await putRun(setup.storage.storage, setup.record)
    const adopted = await setup.run()
    expect(adopted.finalised[0]).toMatchObject({ status: "interrupted" })
    expect(adopted.finalised[0]?.error).toContain("no longer exists")
  })

  test("a queued record that never reached a session is interrupted", async () => {
    const setup = input()
    await putRun(setup.storage.storage, { ...setup.record, status: "queued", sessionID: undefined, startedAt: undefined })
    const adopted = await setup.run()
    expect(adopted.finalised[0]).toMatchObject({ status: "interrupted" })
  })

  test("a run this leader's runner is still executing is not an orphan", async () => {
    // The session is gone, so an adoption that did not skip the record would finalise it at once, not wait.
    const setup = input({ session: sessionFake({ gone: true }) })
    await putRun(setup.storage.storage, setup.record)
    const adopted = await adopt({
      storage: setup.storage.storage,
      session: setup.session.session,
      clock: setup.clock.clock,
      active: () => true,
      jobs: [job()],
      owned: (record) => record.job === "five",
    })
    expect(adopted).toEqual({ finalised: [], reattached: 0 })
    expect(await getRun(setup.storage.storage, "five", SLOT)).toMatchObject({ status: "running", sessionID: "ses_1" })
  })

  test("a finished record is left alone", async () => {
    const setup = input()
    await putRun(setup.storage.storage, { ...setup.record, status: "succeeded", outcome: "succeeded", endedAt: START })
    const adopted = await setup.run()
    expect(adopted.finalised).toHaveLength(0)
    expect(await getRun(setup.storage.storage, "five", SLOT)).toMatchObject({ status: "succeeded", endedAt: START })
  })

  test("a second pass never writes the record again", async () => {
    const base = memoryStorage()
    const writes: string[] = []
    const storage: Storage = {
      ...base.storage,
      set: async (key, value) => {
        if (key.startsWith("run/")) writes.push(key)
        await base.storage.set(key, value)
      },
    }
    const setup = input({ storage: base, session: sessionFake({ answer: "done", outcome: "succeeded" }) })
    const counted = { ...setup, run: () => adopt({ storage, session: setup.session.session, clock: setup.clock.clock, active: () => true, jobs: [job()], owned: () => false }) }
    await putRun(base.storage, setup.record)
    const first = await counted.run()
    const second = await counted.run()
    expect(first.finalised).toHaveLength(1)
    expect(second.finalised).toHaveLength(0)
    expect(writes).toEqual([`run/five/${SLOT}`])
  })

  test("a run whose remaining timeout is spent is interrupted at the one-second floor", async () => {
    const setup = input({ session: sessionFake({ outcome: "interrupted", startBusy: true }) })
    await putRun(setup.storage.storage, { ...setup.record, startedAt: START - 3_600_000 })
    const pending = setup.run()
    await settle()
    expect(setup.clock.sleeps).toContain(1_000)
    setup.clock.advance(1_000)
    const adopted = await pending
    expect(adopted.finalised[0]).toMatchObject({ status: "interrupted" })
    expect(setup.session.interrupted).toEqual(["ses_1"])
  })
})
