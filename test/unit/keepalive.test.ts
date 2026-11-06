import { describe, expect, test } from "bun:test"
import { KEEPALIVE_CAP, keepAlivePeriod, startKeepAlive } from "../../src/jobs/keepalive.js"
import { HOUR, MINUTE } from "../../src/jobs/model.js"
import { sessionFake, settle, testClock } from "./fake.js"

const START = Date.UTC(2026, 11, 6, 9, 0, 0)

describe("the keep-alive period", () => {
  test.each([
    ["the default 60-minute location gets 20 minutes", 60 * MINUTE, 20 * MINUTE],
    ["a 2-minute location would be 40 s, but a beat is never closer than a minute", 2 * MINUTE, MINUTE],
    ["never less than a minute", 90_000, MINUTE],
    ["never more than 20 minutes", 6 * HOUR, KEEPALIVE_CAP],
    ["an unknown timeout is the cap", undefined, KEEPALIVE_CAP],
    ["zero is the cap", 0, KEEPALIVE_CAP],
  ])("%s", (_name, idle, period) => {
    expect(keepAlivePeriod(idle)).toBe(period as number)
  })
})

describe("a beat", () => {
  test("creates an empty session and removes it, with no prompt and no model call", async () => {
    const session = sessionFake()
    const clock = testClock(START)
    const keep = startKeepAlive({ session: session.session, clock: clock.clock, location: "/work", active: () => true })
    expect(await keep.beat()).toBe(true)
    expect(session.created).toEqual([{ location: { directory: "/work" }, metadata: { jobs: { keepalive: true } } }])
    expect(session.removed).toEqual(["ses_1"])
    expect(session.prompts).toEqual([])
    expect(session.commands).toEqual([])
    expect(session.synthetics).toEqual([])
    expect(keep.beats).toBe(1)
    expect(keep.lastBeatAt).toBe(START)
  })

  test("a create that fails is counted as a failed beat, not a throw", async () => {
    const session = sessionFake({ fail: "create" })
    const keep = startKeepAlive({ session: session.session, clock: testClock(START).clock, location: "/work", active: () => true })
    const beats: boolean[] = []
    const keep2 = startKeepAlive({ session: session.session, clock: testClock(START).clock, location: "/work", active: () => true, onBeat: (_at, ok) => void beats.push(ok) })
    expect(await keep.beat()).toBe(false)
    expect(await keep2.beat()).toBe(false)
    expect(beats).toEqual([false])
    expect(keep.beats).toBe(0)
  })
})

describe("the loop", () => {
  test("beats once per period while the instance leads, and stops on stop", async () => {
    const session = sessionFake()
    const clock = testClock(START, { instantBelow: 0 })
    const active = { current: true }
    const keep = startKeepAlive({ session: session.session, clock: clock.clock, location: "/work", idleTimeoutMs: 2 * MINUTE, active: () => active.current })
    expect(keep.periodMs).toBe(MINUTE)
    keep.start()
    await settle()
    expect(clock.sleeps).toEqual([MINUTE])
    clock.advance(MINUTE)
    await settle()
    expect(keep.beats).toBe(1)
    clock.advance(MINUTE)
    await settle()
    expect(keep.beats).toBe(2)
    keep.stop()
    active.current = false
    clock.advance(MINUTE)
    await settle()
    expect(keep.beats).toBe(2)
    expect(session.prompts).toEqual([])
  })
})
