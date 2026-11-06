import { describe, expect, test } from "bun:test"
import { cronProblem, nextRun, slotsBetween } from "../../src/jobs/cron.js"
import { parseJob } from "../../src/jobs/model.js"
import { parseOptions } from "../../src/options.js"

// The UTC instants above are checked against the zone's own wall clock, so a case states both what it asks for and
// what a user would see on the clock.
const utc = (text: string) => Date.parse(text)
const wall = (ms: number, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .format(ms)
    .replace(",", "")
const cron = (pattern: string, tz: string) => ({ kind: "cron", cron: pattern, tz }) as const
const next = (pattern: string, tz: string, from: string) => {
  const slot = nextRun(cron(pattern, tz), utc(from))
  return slot === null ? null : new Date(slot).toISOString()
}

describe("cron across daylight saving", () => {
  test("New York, 2026-03-08: 02:30 is skipped, so the job runs when the clock jumps to 03:00", () => {
    expect(next("30 2 * * *", "America/New_York", "2026-03-08T00:00:00-05:00")).toBe("2026-03-08T07:00:00.000Z")
    expect(wall(utc("2026-03-08T07:00:00Z"), "America/New_York")).toBe("2026-03-08 03:00")
    // The next day the clock exists again, and the slot is 02:30.
    expect(next("30 2 * * *", "America/New_York", "2026-03-08T07:00:00Z")).toBe("2026-03-09T06:30:00.000Z")
  })

  test("New York, 2026-11-01: 01:30 happens twice and the job fires once", () => {
    const first = next("30 1 * * *", "America/New_York", "2026-11-01T00:00:00-04:00")
    expect(first).toBe("2026-11-01T05:30:00.000Z")
    expect(wall(utc("2026-11-01T05:30:00Z"), "America/New_York")).toBe("2026-11-01 01:30")
    // Not the repeated 01:30 EST (06:30Z), the next day's 01:30.
    expect(next("30 1 * * *", "America/New_York", "2026-11-01T05:30:00Z")).toBe("2026-11-02T06:30:00.000Z")
  })

  test("New York, hourly across the fall-back, still hits every real hour", () => {
    const slots = slotsBetween(cron("0 * * * *", "America/New_York"), utc("2026-11-01T04:30:00Z"), utc("2026-11-01T07:30:00Z"))
    expect(slots.map((slot) => new Date(slot).toISOString())).toEqual(["2026-11-01T05:00:00.000Z", "2026-11-01T06:00:00.000Z", "2026-11-01T07:00:00.000Z"])
    expect(slots.map((slot) => wall(slot, "America/New_York"))).toEqual(["2026-11-01 01:00", "2026-11-01 01:00", "2026-11-01 02:00"])
  })

  test("London, spring forward and fall back", () => {
    // 2026-03-29: 01:00 GMT becomes 02:00 BST, so 01:30 runs at the change.
    expect(next("30 1 * * *", "Europe/London", "2026-03-29T00:00:00Z")).toBe("2026-03-29T01:00:00.000Z")
    expect(wall(utc("2026-03-29T01:00:00Z"), "Europe/London")).toBe("2026-03-29 02:00")
    // 2026-10-25: 02:00 BST becomes 01:00 GMT, so 01:30 happens twice and fires once.
    expect(next("30 1 * * *", "Europe/London", "2026-10-25T00:00:00Z")).toBe("2026-10-25T00:30:00.000Z")
    expect(next("30 1 * * *", "Europe/London", "2026-10-25T00:30:00Z")).toBe("2026-10-26T01:30:00.000Z")
  })

  test("Lord Howe, 2026-10-04: the 30-minute jump skips 02:00 to 02:30", () => {
    // 02:15 does not exist, so the slot runs at the change, 02:30.
    expect(next("15 2 * * *", "Australia/Lord_Howe", "2026-10-03T12:00:00Z")).toBe("2026-10-03T15:30:00.000Z")
    expect(wall(utc("2026-10-03T15:30:00Z"), "Australia/Lord_Howe")).toBe("2026-10-04 02:30")
    // 02:00 does not exist either, so it also runs at the change.
    expect(next("0 2 * * *", "Australia/Lord_Howe", "2026-10-03T12:00:00Z")).toBe("2026-10-03T15:30:00.000Z")
    // 02:45 does exist, after the jump.
    expect(next("45 2 * * *", "Australia/Lord_Howe", "2026-10-03T12:00:00Z")).toBe("2026-10-03T15:45:00.000Z")
  })

  test("Lord Howe, 2026-04-05: the 30-minute fall-back repeats 01:45 once", () => {
    expect(next("45 1 * * *", "Australia/Lord_Howe", "2026-04-04T12:00:00Z")).toBe("2026-04-04T14:45:00.000Z")
    expect(next("45 1 * * *", "Australia/Lord_Howe", "2026-04-04T14:45:00Z")).toBe("2026-04-05T15:15:00.000Z")
  })
})

describe("the planner", () => {
  test("a day-of-month and a day-of-week field are alternatives, not both", () => {
    // 2026-01-02 is a Friday, and the 13th is the other alternative.
    expect(next("0 9 13 * 5", "UTC", "2026-01-01T00:00:00Z")).toBe("2026-01-02T09:00:00.000Z")
  })

  test("an interval is anchored, never early, and strictly after the instant asked about", () => {
    const schedule = { kind: "every", everyMs: 300_000, anchorMs: utc("2026-11-06T12:00:00Z") } as const
    expect(nextRun(schedule, utc("2026-11-06T12:00:00Z"))).toBe(utc("2026-11-06T12:05:00Z"))
    expect(nextRun(schedule, utc("2026-11-06T12:04:59Z"))).toBe(utc("2026-11-06T12:05:00Z"))
    expect(nextRun(schedule, utc("2026-11-06T11:00:00Z"))).toBe(utc("2026-11-06T12:00:00Z"))
    expect(slotsBetween(schedule, utc("2026-11-06T12:00:00Z"), utc("2026-11-06T12:20:00Z"))).toEqual([
      utc("2026-11-06T12:05:00Z"),
      utc("2026-11-06T12:10:00Z"),
      utc("2026-11-06T12:15:00Z"),
      utc("2026-11-06T12:20:00Z"),
    ])
    expect(slotsBetween(schedule, utc("2026-11-06T12:00:00Z"), utc("2026-12-06T12:00:00Z"), 3)).toHaveLength(3)
  })

  test("a one-off slot runs once and then has no next", () => {
    const schedule = { kind: "at", atMs: utc("2026-11-07T09:00:00Z"), tz: "UTC" } as const
    expect(nextRun(schedule, utc("2026-11-06T00:00:00Z"))).toBe(utc("2026-11-07T09:00:00Z"))
    expect(nextRun(schedule, utc("2026-11-07T09:00:00Z"))).toBeNull()
  })

  test("refuses a pattern with seconds, an alias, an impossible date, and a bad expression", () => {
    expect(cronProblem("*/5 * * * * *", "UTC", utc("2026-11-06T12:00:00Z"))).toContain("five fields")
    expect(cronProblem("@daily", "UTC", utc("2026-11-06T12:00:00Z"))).toContain("five fields")
    expect(cronProblem("0 0 30 2 *", "UTC", utc("2026-11-06T12:00:00Z"))).toBe("never fires")
    expect(cronProblem("not a cron", "UTC", utc("2026-11-06T12:00:00Z"))).toBeString()
    expect(cronProblem("0 7 * * 1-5", "UTC", utc("2026-11-06T12:00:00Z"))).toBeUndefined()
  })

  test("the zone is the job's, then the option's, then the server's", () => {
    const option = parseOptions({ timezone: "Europe/London" }).timezone ?? "UTC"
    const build = (schedule: Record<string, unknown>, timezone: string) =>
      parseJob({ name: "Daily", schedule, action: { type: "prompt", text: "x" }, agent: "jobs" }, { now: utc("2026-11-06T12:00:00Z"), timezone, id: "daily", source: "tool" })

    // Winter: London is UTC, New York is UTC-5.
    const london = build({ cron: "0 7 * * *" }, option)
    expect(london.schedule).toMatchObject({ tz: "Europe/London" })
    expect(nextRun(london.schedule, utc("2026-11-06T00:00:00Z"))).toBe(utc("2026-11-06T07:00:00Z"))

    const newYork = build({ cron: "0 7 * * *", tz: "America/New_York" }, option)
    expect(newYork.schedule).toMatchObject({ tz: "America/New_York" })
    expect(nextRun(newYork.schedule, utc("2026-11-06T00:00:00Z"))).toBe(utc("2026-11-06T12:00:00Z"))

    const server = build({ cron: "0 7 * * *" }, "UTC")
    expect(server.schedule).toMatchObject({ tz: "UTC" })
    expect(nextRun(server.schedule, utc("2026-11-06T00:00:00Z"))).toBe(utc("2026-11-06T07:00:00Z"))
  })
})
