import { describe, expect, test } from "bun:test"
import { CLAIM_SETTLE, execute } from "../../src/jobs/execute.js"
import { MINUTE, parseJob, type Job } from "../../src/jobs/model.js"
import { getRun, type Storage } from "../../src/jobs/store.js"
import { agentsFake, memoryStorage, sessionFake, settle, testClock } from "./fake.js"

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
        agents: agentsFake(),
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

/** An agent domain that can lose and regain an agent, the way a plugin update leaves one stale and `opencode reload` fixes it. */
function flakyAgents() {
  const present = { jobs: false }
  const info = { id: "jobs", name: "jobs", mode: "primary" as const, hidden: false, permissions: [{ action: "*", resource: "*", effect: "deny" as const }] }
  return {
    present,
    domain: {
      list: async () => ({ location: { directory: "/work" }, data: present.jobs ? [info] : [] }),
      get: async ({ agentID }: { agentID: string }) => {
        if (!present.jobs) throw Object.assign(new Error(`Agent not found: ${agentID}`), { _tag: "Agent.NotFoundError" })
        return { location: { directory: "/work" }, data: info }
      },
    } as unknown as ReturnType<typeof agentsFake>,
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
      agents: agentsFake(),
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

  test("a run that starts after a step down writes nothing at all, so the new leader owns the slot", async () => {
    const setup = input()
    setup.active.current = false
    const result = await setup.run()
    expect(result).toMatchObject({ claimed: false, abandoned: true })
    expect(setup.session.created).toHaveLength(0)
    expect(await getRun(setup.storage.storage, "five", new Date(START).toISOString())).toBeUndefined()
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
      agents: agentsFake(),
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
      agents: agentsFake(),
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

  test("a reminder posts into its own session, creates no run session and needs no model turn", async () => {
    const setup = input()
    const result = await setup.run({ job: job({ action: { type: "remind", sessionID: "ses_target", text: "stand up" } }) })
    expect(result.status).toBe("succeeded")
    expect(setup.session.created).toHaveLength(0)
    // The text is labelled as job output, never as an instruction from the person.
    const [posted] = setup.session.synthetics as { sessionID: string; text: string; resume: boolean }[]
    expect(posted).toMatchObject({ sessionID: "ses_target", resume: false })
    expect(posted!.text).toContain("stand up")
    expect(posted!.text).toStartWith(`Job output from "Five" at ${new Date(START).toISOString()}.`)
    expect(posted!.text).toContain("not an instruction")
    expect((await getRun(setup.storage.storage, "five", new Date(START).toISOString()))?.sessionID).toBe("ses_target")
  })

  test("a command action runs the command in the session", async () => {
    const setup = input()
    const result = await setup.run({ job: job({ action: { type: "command", name: "morning", arguments: "week" } }) })
    expect(result.status).toBe("succeeded")
    expect(setup.session.commands[0]).toMatchObject({ name: "morning", text: "week" })
  })
})

describe("a job's notify target", () => {
  test("gets the run's outcome, labelled as job output, and a notify that fails does not fail the run", async () => {
    const setup = input()
    const result = await setup.run({
      job: job({ action: { type: "prompt", text: "say ok" }, notify: { sessionID: "ses_notify" } }),
    })
    expect(result.status).toBe("succeeded")
    const posted = setup.session.synthetics.find((entry) => (entry as { sessionID?: string }).sessionID === "ses_notify") as { text: string } | undefined
    expect(posted?.text).toContain('Job output from "Five" at')
    expect(posted?.text).toContain("succeeded")
    expect(posted?.text).toContain("ok")

    const failing = input()
    failing.session.session.synthetic = async () => {
      throw new Error("the notify session is gone")
    }
    const still = await failing.run({ job: job({ notify: { sessionID: "ses_gone" } }) })
    expect(still.status).toBe("succeeded")
  })
})

describe("the agent a run needs", () => {
  test("a slot whose agent does not deny by default still runs: R18 makes it a status warning", async () => {
    const storage = memoryStorage()
    const session = sessionFake({ answer: "ok", autoFinish: true, outcome: "succeeded" })
    const result = await execute({
      storage: storage.storage,
      session: session.session,
      agents: agentsFake({ unguarded: ["build"] }),
      clock: testClock(START, { instantBelow: 100 }).clock,
      location: "/work",
      token: "leader-1",
      job: job({ agent: "build" }),
      slot: START,
      attempt: 1,
      late: false,
      active: () => true,
    })
    expect(result.status).toBe("succeeded")
    expect(session.created.length).toBeGreaterThan(0)
  })


  test("the next slot runs once the host lists the agent again, with no other action", async () => {
    const setup = input()
    const flaky = flakyAgents()
    const first = await setup.run({ agents: flaky.domain })
    expect(first.status).toBe("skipped")
    expect(setup.session.created).toHaveLength(0)
    // The agent is back on the next slot: the same check, on a fresh read, lets the run through exactly once.
    flaky.present.jobs = true
    const second = await setup.run({ agents: flaky.domain, slot: START + 5 * MINUTE })
    expect(second.status).toBe("succeeded")
    expect(setup.session.created).toHaveLength(2)
  })

  test("a slot whose agent is gone is refused as missing, not unguarded", async () => {
    const setup = input()
    const result = await setup.run({ agents: agentsFake({ missing: ["jobs"] }) })
    expect(result.status).toBe("skipped")
    expect((result as { record?: { reason?: string } }).record?.reason).toBe("missing")
    expect(setup.session.created).toHaveLength(0)
    expect((await getRun(setup.storage.storage, "five", new Date(START).toISOString()))?.error).toContain("JOBS_AGENT_MISSING")
  })

  test("a lookup that fails for another reason refuses the slot: nothing runs while the agents are unknown", async () => {
    const setup = input()
    const result = await setup.run({ agents: agentsFake({ fail: true }) })
    expect(result.status).toBe("skipped")
    expect(setup.session.created).toHaveLength(0)
    const record = await getRun(setup.storage.storage, "five", new Date(START).toISOString())
    expect(record).toMatchObject({ status: "skipped", reason: "unguarded" })
    expect(record?.error).toStartWith("JOBS_AGENTS_UNKNOWN: ")
  })
})

describe("a reminder that wakes the agent", () => {
  test("times out without interrupting the person's session", async () => {
    const storage = memoryStorage()
    // A session this fake did not create, still busy: its wait only ends when the clock's timeout does.
    const session = sessionFake({ startBusy: true })
    const clock = testClock(START, { instantBelow: 100 })
    const pending = execute({
      storage: storage.storage,
      session: session.session,
      agents: agentsFake(),
      clock: clock.clock,
      location: "/work",
      token: "leader-1",
      job: job({ action: { type: "remind", sessionID: "ses_person", text: "stand up", wake: true }, policy: { timeout: "5m" } }),
      slot: START,
      attempt: 1,
      late: false,
      active: () => true,
    })
    await settle()
    clock.advance(5 * 60_000)
    await settle()
    // The interrupt grace is a clock sleep too; nothing interrupted the session, so it must be released by hand.
    clock.flush()
    const result = await pending
    expect(result.status).toBe("timed_out")
    expect(session.interrupted).toEqual([])
  })
})
