import { describe, expect, test } from "bun:test"
import { HOUR, MINUTE, jitterFor, type JobPolicy } from "../../src/jobs/model.js"
import { catchUp, isLate, overlapOf, retryAfter, shouldPause, startAt, stopReason, FAILURES_BEFORE_PAUSE, LATE_MS, type OverlapAction, type StopReason } from "../../src/jobs/policy.js"

const NOW = Date.UTC(2026, 11, 6, 12, 0, 0)
const at = (minutes: number) => NOW + minutes * MINUTE

const policy = (overrides: Partial<JobPolicy> = {}): JobPolicy => ({
  catchup: "latest",
  maxLateMs: HOUR,
  overlap: "skip",
  timeoutMs: 30 * MINUTE,
  retries: { max: 0, backoffMs: MINUTE },
  ...overrides,
})

/** The offset rows a catch-up case expects: a slot in minutes from now, or null. */
const offset = (slot: number | null) => (slot === null ? null : at(slot))
const gap = (from: number, to: number, count: number) => ({ from: at(from), to: at(to), count })

describe("the catch-up table", () => {
  test.each([
    ["latest within an hour keeps the newest and collapses the rest", "latest", HOUR, [-120, -60, -10], offset(-10), gap(-120, -60, 2)],
    ["latest outside an hour runs nothing and collapses all", "latest", HOUR, [-180, -120], null, gap(-180, -120, 2)],
    ["latest with one slot inside the hour runs it", "latest", HOUR, [-30], offset(-30), null],
    ["latest exactly at maxLate still runs", "latest", HOUR, [-60], offset(-60), null],
    ["latest with maxLate zero runs nothing", "latest", 0, [-1], null, gap(-1, -1, 1)],
    ["a file job may widen maxLate to a day", "latest", 24 * HOUR, [-20 * 60], offset(-20 * 60), null],
    ["none runs nothing and collapses every slot", "none", HOUR, [-30, -10], null, gap(-30, -10, 2)],
    ["nothing missed means nothing to do", "latest", HOUR, [], null, null],
    ["a slot in the future is not missed", "latest", HOUR, [5], null, null],
    ["one stale slot is a one-slot gap", "latest", HOUR, [-180], null, gap(-180, -180, 1)],
  ])("%s", (_name, catchup, maxLateMs, slots, run, collapsed) => {
    expect(catchUp({ policy: policy({ catchup: catchup as JobPolicy["catchup"], maxLateMs }) }, slots.map(at), NOW)).toEqual({ run, gap: collapsed })
  })
})

describe("the overlap table", () => {
  test.each([
    ["skip while busy", "skip", true, "skip"],
    ["queue-one while busy", "queue-one", true, "queue"],
    ["replace while busy", "replace", true, "replace"],
    ["allow while busy", "allow", true, "run"],
    ["skip when idle", "skip", false, "run"],
    ["queue-one when idle", "queue-one", false, "run"],
    ["replace when idle", "replace", false, "run"],
    ["allow when idle", "allow", false, "run"],
  ])("%s", (_name, overlap, busy, action) => {
    expect(overlapOf({ policy: policy({ overlap: overlap as JobPolicy["overlap"] }) }, busy ? { slot: at(-10) } : null)).toBe(action as OverlapAction)
  })
})

describe("the retry table", () => {
  test.each([
    ["no retries configured, a failure is final", 0, 1, "failed", null],
    ["first failure retries after one backoff", 2, 1, "failed", { attempt: 2, delayMs: MINUTE }],
    ["second failure doubles the backoff", 2, 2, "failed", { attempt: 3, delayMs: 2 * MINUTE }],
    ["a third attempt is past two retries", 2, 3, "failed", null],
    ["a success is final", 2, 1, "succeeded", null],
    ["a timeout is not retried", 2, 1, "timed_out", null],
    ["an interruption is not retried", 2, 1, "interrupted", null],
    ["a custom backoff scales", 1, 1, "failed", { attempt: 2, delayMs: 5 * MINUTE }],
  ])("%s", (_name, max, attempt, outcome, expected) => {
    expect(retryAfter({ policy: policy({ retries: { max, backoffMs: _name === "a custom backoff scales" ? 5 * MINUTE : MINUTE } }) }, { attempt, outcome: outcome as never })).toEqual(expected)
  })
})

describe("the ends and expiry table", () => {
  const state = (overrides: { runCount?: number; paused?: boolean } = {}) => ({
    job: "job_1",
    runCount: overrides.runCount ?? 0,
    consecutiveFailures: 0,
    ...(overrides.paused === true ? { paused: { at: NOW - MINUTE } } : {}),
  })

  test.each([
    ["a paused job does not run", { ends: {}, expires: undefined }, { paused: true }, "paused"],
    ["an expired job does not run", { ends: {}, expires: NOW - 1 }, {}, "expired"],
    ["a live job runs", { ends: {}, expires: NOW + 1 }, {}, null],
    ["ends.at at this instant has ended", { ends: { at: NOW }, expires: undefined }, {}, "ended"],
    ["ends.at in the future has not", { ends: { at: NOW + 1 }, expires: undefined }, {}, null],
    ["ends.times reached has ended", { ends: { times: 3 }, expires: undefined }, { runCount: 3 }, "ended"],
    ["one run short of ends.times has not", { ends: { times: 3 }, expires: undefined }, { runCount: 2 }, null],
  ])("%s", (_name, job, overrides, reason) => {
    expect(stopReason(job, state(overrides), NOW)).toBe(reason as StopReason | null)
  })

  test("an expires of exactly now is expired", () => {
    expect(stopReason({ ends: {}, expires: NOW }, state(), NOW)).toBe("expired")
  })
})

describe("late runs, the pause after failures, and jitter", () => {
  test("a run is late more than a minute after its slot", () => {
    expect(LATE_MS).toBe(MINUTE)
    expect(isLate(at(0), at(0))).toBe(false)
    expect(isLate(at(-1), at(0))).toBe(false)
    expect(isLate(at(-1), at(0) + 1)).toBe(true)
  })

  test("five failed slots in a row pause the job", () => {
    expect(FAILURES_BEFORE_PAUSE).toBe(5)
    expect(shouldPause(4)).toBe(false)
    expect(shouldPause(5)).toBe(true)
  })

  test("a run starts at its slot plus the job's own jitter, never before", () => {
    expect(startAt({ id: "job_1", jitterMs: 0 }, at(0))).toBe(at(0))
    const jittered = startAt({ id: "job_1", jitterMs: 30_000 }, at(0))
    expect(jittered).toBe(at(0) + jitterFor("job_1", 30_000))
    expect(jittered).toBeGreaterThanOrEqual(at(0))
    expect(jittered).toBeLessThanOrEqual(at(0) + 30_000)
  })
})
