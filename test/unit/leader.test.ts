import { beforeEach, describe, expect, test } from "bun:test"
import { LEASE_HEARTBEAT, LEASE_KEY, LEASE_TTL, Leader } from "../../src/jobs/leader.js"
import { memoryStorage, settle, testClock } from "./fake.js"

const GLOBAL_KEY = Symbol.for("@joe-broadhead/opencode-jobs")
const START = Date.UTC(2026, 11, 6, 9, 0, 0)

/** A fresh process-wide registry, as a new server process would have. */
function freshProcess() {
  ;(globalThis as unknown as Record<symbol, unknown>)[GLOBAL_KEY] = { owner: null, followers: [] }
}

const slot = () => (globalThis as unknown as Record<symbol, { owner: Leader | null; followers: Leader[] }>)[GLOBAL_KEY]!

function candidate(input: { storage?: ReturnType<typeof memoryStorage>; token?: string; clock?: ReturnType<typeof testClock> } = {}) {
  const storage = input.storage ?? memoryStorage()
  const clock = input.clock ?? testClock(START, { instantBelow: 1_000 })
  const events: string[] = []
  const leader = new Leader({
    storage: storage.storage,
    clock: clock.clock,
    location: `/work/${input.token ?? "a"}`,
    token: input.token ?? "a",
    onLead: () => void events.push("lead"),
    onStepDown: () => void events.push("step-down"),
  })
  return { leader, storage, clock, events }
}

beforeEach(freshProcess)

describe("the in-process lock", () => {
  test("50 aligned rounds have exactly one winner and never none", () => {
    const a = candidate({ token: "a" })
    const b = candidate({ token: "b" })
    let roundsWithTwo = 0
    let roundsWithNone = 0
    for (let round = 0; round < 50; round += 1) {
      freshProcess()
      const winners = [a.leader.claim(), b.leader.claim()].filter(Boolean)
      if (winners.length > 1) roundsWithTwo += 1
      if (winners.length === 0) roundsWithNone += 1
    }
    expect({ roundsWithTwo, roundsWithNone }).toEqual({ roundsWithTwo: 0, roundsWithNone: 0 })
  })

  test("a second instance follows, and the first owner's release hands the lock to it", async () => {
    const a = candidate({ token: "a" })
    const b = candidate({ token: "b" })
    expect(a.leader.claim()).toBe(true)
    expect(b.leader.claim()).toBe(false)
    expect(slot().followers).toEqual([b.leader])
    await a.leader.release()
    expect(slot().owner).toBeNull()
    expect(b.leader.claim()).toBe(true)
  })

  test("an owner left by a reload and not released is not trusted", () => {
    const dead = { disposed: true } as Leader
    ;(globalThis as unknown as Record<symbol, unknown>)[GLOBAL_KEY] = { owner: dead, followers: [] }
    const b = candidate({ token: "b" })
    expect(b.leader.claim()).toBe(true)
    expect(slot().owner).toBe(b.leader)
  })
})

describe("the storage lease", () => {
  test("one process leads and a second, in its own registry, stands by", async () => {
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 1_000 })
    const a = candidate({ storage, token: "a", clock })
    a.leader.start()
    await settle()
    expect(a.leader.isLeader).toBe(true)
    expect(await storage.storage.get(LEASE_KEY)).toMatchObject({ token: "a", heartbeatAt: START })

    freshProcess()
    const b = candidate({ storage, token: "b", clock })
    b.leader.start()
    await settle()
    expect(b.leader.isLeader).toBe(false)
    await a.leader.release()
    await b.leader.release()
  })

  test("an expired lease is taken over, and the old leader steps down after its next heartbeat", async () => {
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 1_000 })
    const a = candidate({ storage, token: "a", clock })
    a.leader.start()
    await settle()
    expect(a.leader.isLeader).toBe(true)

    // Another process writes its own lease while A is idle between heartbeats.
    await storage.storage.set(LEASE_KEY, { token: "z", pid: 1, location: "/work/z", heartbeatAt: clock.now() } as never)
    clock.advance(LEASE_HEARTBEAT)
    await settle()
    expect(a.leader.isLeader).toBe(false)
    expect(a.events).toEqual(["lead", "step-down"])
    await a.leader.release()
  })

  test("the lease expires when its heartbeat stops", async () => {
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 1_000 })
    const a = candidate({ storage, token: "a", clock })
    a.leader.start()
    await settle()
    await a.leader.release()
    expect(await storage.storage.get(LEASE_KEY)).toBeUndefined()

    await storage.storage.set(LEASE_KEY, { token: "z", pid: 1, location: "/work/z", heartbeatAt: START } as never)
    clock.advance(LEASE_TTL)
    freshProcess()
    const b = candidate({ storage, token: "b", clock })
    b.leader.start()
    await settle()
    expect(b.leader.isLeader).toBe(true)
    await b.leader.release()
  })

  test("a heartbeat renews the lease it holds", async () => {
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 1_000 })
    const a = candidate({ storage, token: "a", clock })
    a.leader.start()
    await settle()
    clock.advance(LEASE_HEARTBEAT)
    await settle()
    expect(await storage.storage.get(LEASE_KEY)).toMatchObject({ token: "a", heartbeatAt: START + LEASE_HEARTBEAT })
    await a.leader.release()
  })

  test("release leaves another process's lease alone", async () => {
    const storage = memoryStorage()
    const clock = testClock(START, { instantBelow: 1_000 })
    const a = candidate({ storage, token: "a", clock })
    a.leader.start()
    await settle()
    await storage.storage.set(LEASE_KEY, { token: "z", pid: 1, location: "/work/z", heartbeatAt: clock.now() } as never)
    await a.leader.release()
    expect(await storage.storage.get(LEASE_KEY)).toMatchObject({ token: "z" })
    expect(LEASE_TTL).toBe(60_000)
  })
})
