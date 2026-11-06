import { describe, expect, test } from "bun:test"
import { CLAIM_SETTLE, execute } from "../../src/jobs/execute.js"
import { parseJob, type Job } from "../../src/jobs/model.js"
import { getRun, type Storage } from "../../src/jobs/store.js"
import { memoryStorage, sessionFake, settle, testClock } from "./fake.js"

const START = Date.UTC(2026, 11, 6, 9, 0, 0)

const job = (overrides: Record<string, unknown> = {}): Job =>
  parseJob(
    { name: "Five", schedule: { every: "5 minutes" }, action: { type: "prompt", text: "say ok" }, agent: "jobs", ...overrides },
    { now: START, timezone: "UTC", id: "five", source: "tool", createdBy: "user" },
  )

const input = () => {
  const storage = memoryStorage()
  const session = sessionFake({ answer: "ok", autoFinish: true, outcome: "succeeded" })
  const clock = testClock(START, { instantBelow: 100 })
  const active = { current: true }
  return {
    storage,
    session,
    clock,
    active,
    run: (more: Record<string, unknown> = {}) =>
      execute({
        storage: storage.storage,
        session: session.session,
        clock: clock.clock,
        location: "/work",
        token: "leader-1",
        job: job(),
        slot: START,
        attempt: 1,
        late: false,
        active: () => active.current,
        ...more,
      } as never),
  }
}

describe("the dedup point", () => {
  test("writes queued, waits for the write to be visible and reads it back before anything starts", async () => {
    const setup = input()
    const result = await setup.run()
    expect(result.status).toBe("succeeded")
    expect(setup.clock.sleeps).toContain(CLAIM_SETTLE)
    // The parent, then the run session: the run session carries the job, the slot and the agent.
    expect(setup.session.created).toHaveLength(2)
    expect(setup.session.created[1]).toMatchObject({ agent: "jobs", location: { directory: "/work" } })
    expect((setup.session.created[1]!.metadata as { jobs: { job: string } }).jobs.job).toBe("five")
  })

  test("a write that reads back another leader's token runs nothing", async () => {
    const base = memoryStorage()
    const storage: Storage = {
      ...base.storage,
      set: async (key, value) => {
        await base.storage.set(key, value)
        const record = value as { status?: string; token?: string }
        if (key.startsWith("run/") && record.status === "queued") await base.storage.set(key, { ...record, token: "other" } as never)
      },
    }
    const session = sessionFake()
    const result = await execute({
      storage,
      session: session.session,
      clock: testClock(START, { instantBelow: 100 }).clock,
      location: "/work",
      token: "leader-1",
      job: job(),
      slot: START,
      attempt: 1,
      late: false,
      active: () => true,
    })
    expect(result.claimed).toBe(false)
    expect(session.created).toHaveLength(0)
  })

  test("a slot with a record already is never started again", async () => {
    const setup = input()
    await setup.storage.storage.set(`run/five/${new Date(START).toISOString()}`, { job: "five", slot: new Date(START).toISOString(), status: "succeeded", late: false, attempt: 1 })
    const result = await setup.run()
    expect(result).toMatchObject({ claimed: false, status: "succeeded" })
    expect(setup.session.created).toHaveLength(0)
  })

  test("a running record held by another token is left to its owner", async () => {
    const setup = input()
    await setup.storage.storage.set(`run/five/${new Date(START).toISOString()}`, { job: "five", slot: new Date(START).toISOString(), status: "running", late: false, attempt: 1, token: "other" })
    const result = await setup.run()
    expect(result.claimed).toBe(false)
    expect(setup.session.created).toHaveLength(0)
  })
})

describe("one run", () => {
  test("records the outcome and the last assistant text as the summary", async () => {
    const setup = input()
    const result = await setup.run()
    expect(result).toMatchObject({ status: "succeeded", outcome: "succeeded", summary: "ok" })
    const record = await getRun(setup.storage.storage, "five", new Date(START).toISOString())
    expect(record).toMatchObject({ status: "succeeded", outcome: "succeeded", summary: "ok", sessionID: result.sessionID, token: "leader-1" })
    expect(record?.endedAt).toBeNumber()
  })

  test("a run session is a child of one parked Jobs parent, reused by the next run", async () => {
    const setup = input()
    await setup.run()
    await setup.run({ slot: START + 300_000 })
    expect(setup.session.created[0]).toMatchObject({ title: "Jobs" })
    const [, first, second] = setup.session.created
    expect(first!.parentID).toBe("ses_1")
    expect(second!.parentID).toBe("ses_1")
    expect(setup.session.created).toHaveLength(3)
  })

  test("times out at the configured bound, interrupts, and records timed_out", async () => {
    const storage = memoryStorage()
    const session = sessionFake({ outcome: "interrupted" })
    const clock = testClock(START, { instantBelow: 100 })
    const pending = execute({
      storage: storage.storage,
      session: session.session,
      clock: clock.clock,
      location: "/work",
      token: "leader-1",
      job: job({ policy: { timeout: "1s" } }),
      slot: START,
      attempt: 1,
      late: false,
      active: () => true,
    })
    await settle()
    expect(session.created).toHaveLength(2)
    clock.advance(1_000)
    const result = await pending
    expect(result.status).toBe("timed_out")
    expect(session.interrupted).toEqual([result.sessionID!])
    expect((await getRun(storage.storage, "five", new Date(START).toISOString()))?.status).toBe("timed_out")
  })

  test("a run that outlives its instance writes nothing, so the next leader adopts it", async () => {
    const setup = input()
    const session = sessionFake({ answer: "late", outcome: "succeeded" })
    const pending = execute({
      storage: setup.storage.storage,
      session: session.session,
      clock: setup.clock.clock,
      location: "/work",
      token: "leader-1",
      job: job(),
      slot: START,
      attempt: 1,
      late: false,
      active: () => setup.active.current,
    })
    await settle()
    setup.active.current = false
    session.release()
    const result = await pending
    expect(result.abandoned).toBe(true)
    expect((await getRun(setup.storage.storage, "five", new Date(START).toISOString()))?.status).toBe("running")
  })

  test("a run that cannot start is a failed record with the reason", async () => {
    const setup = input()
    setup.session.session.create = async () => {
      throw new Error("no such agent")
    }
    const result = await setup.run()
    expect(result).toMatchObject({ status: "failed", error: "no such agent" })
    expect((await getRun(setup.storage.storage, "five", new Date(START).toISOString()))?.status).toBe("failed")
  })

  test("a command action runs the command in the session", async () => {
    const setup = input()
    const result = await setup.run({ job: job({ action: { type: "command", name: "morning", arguments: "week" } }) })
    expect(result.status).toBe("succeeded")
    expect(setup.session.commands[0]).toMatchObject({ name: "morning", text: "week" })
  })
})
