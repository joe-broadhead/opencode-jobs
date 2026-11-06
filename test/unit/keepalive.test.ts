import { describe, expect, test } from "bun:test"
import { keepAlivePeriod, MAX_PERIOD, MIN_PERIOD, startKeepAlive } from "../../src/jobs/keepalive.js"
import { MINUTE } from "../../src/jobs/model.js"
import { sessionFake, settle, testClock } from "./fake.js"

const START = Date.UTC(2026, 11, 6, 9, 0, 0)

describe("the keep-alive period", () => {
  test.each([
    ["the documented 20 minutes", 20, 20 * MINUTE],
    ["the smallest option is a minute", 1, MINUTE],
    ["the largest option is an hour", 60, MAX_PERIOD],
    ["a value below the range is a minute", 0, MIN_PERIOD],
    ["a value above it is an hour", 600, MAX_PERIOD],
    ["a fraction of a minute keeps its value", 1.5, 90_000],
  ])("%s", (_name, minutes, period) => {
    expect(keepAlivePeriod(minutes)).toBe(period as number)
  })
})

describe("a beat", () => {
  test("creates an empty session and removes it, with no prompt and no model call", async () => {
    const session = sessionFake()
    const clock = testClock(START)
    const keep = startKeepAlive({ session: session.session, clock: clock.clock, location: "/work", periodMs: 20 * MINUTE, active: () => true })
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
    const keep = startKeepAlive({ session: session.session, clock: testClock(START).clock, location: "/work", periodMs: 20 * MINUTE, active: () => true })
    const beats: boolean[] = []
    const keep2 = startKeepAlive({ session: session.session, clock: testClock(START).clock, location: "/work", periodMs: 20 * MINUTE, active: () => true, onBeat: (_at, ok) => void beats.push(ok) })
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
    const keep = startKeepAlive({ session: session.session, clock: clock.clock, location: "/work", periodMs: MINUTE, active: () => active.current })
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
