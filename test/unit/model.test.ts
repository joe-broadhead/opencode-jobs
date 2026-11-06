import { describe, expect, test } from "bun:test"
import {
  DEFAULTS,
  HOUR,
  MINUTE,
  DAY,
  jobTimezone,
  jitterFor,
  nextId,
  parseDuration,
  parseInstant,
  parseJob,
  serverTimezone,
  slug,
  ulid,
  wallClock,
  type JobContext,
} from "../../src/jobs/model.js"

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0)
const context = (overrides: Partial<JobContext> = {}): JobContext => ({ now: NOW, timezone: "UTC", id: "daily", source: "tool", ...overrides })
const job = (overrides: Record<string, unknown> = {}, contextOverrides: Partial<JobContext> = {}) =>
  parseJob({ name: "Daily", schedule: { cron: "0 7 * * *" }, action: { type: "prompt", text: "Say hi" }, agent: "jobs", ...overrides }, context(contextOverrides))

const codeOf = (run: () => unknown) => {
  try {
    run()
    return undefined
  } catch (error) {
    return (error as Error & { code?: string }).code
  }
}

describe("the job model", () => {
  test("fills every documented default", () => {
    const parsed = job()
    expect(parsed.policy).toEqual({ catchup: "latest", maxLateMs: HOUR, overlap: "skip", timeoutMs: 30 * MINUTE, retries: { max: 0, backoffMs: MINUTE } })
    expect(parsed.allow).toEqual([])
    expect(parsed.ends).toEqual({})
    expect(parsed.jitterMs).toBe(0)
    expect(parsed.target).toEqual({})
    expect(parsed.source).toBe("tool")
    expect(parsed.createdBy).toBe("agent")
    expect(DEFAULTS.maxLateMs).toBe(HOUR)
  })

  test("gives a recurring job the model created seven days, and a person's job, a file job or a one-off none", () => {
    expect(job().expires).toBe(NOW + 7 * DAY)
    expect(job({}, { createdBy: "user" }).expires).toBeUndefined()
    expect(job({}, { source: "file" }).expires).toBeUndefined()
    expect(job({ schedule: { at: "2026-11-07T09:00:00Z" } }).expires).toBeUndefined()
    expect(job({ expires: "2026-11-13T09:00:00Z" }).expires).toBe(Date.parse("2026-11-13T09:00:00Z"))
    expect(job({ policy: { timeout: "10m", maxLate: "24h" } }, { createdBy: "user" }).policy).toMatchObject({ timeoutMs: 10 * MINUTE, maxLateMs: 24 * HOUR })
  })

  test("gives a reminder five minutes and a run thirty", () => {
    const remind = job({ action: { type: "remind", sessionID: "ses_1", text: "Stand up" } })
    expect(remind.policy.timeoutMs).toBe(5 * MINUTE)
    expect(remind.action).toEqual({ type: "remind", sessionID: "ses_1", text: "Stand up", wake: false })
    expect(job().policy.timeoutMs).toBe(30 * MINUTE)
  })

  test("names the agent, the action and the job", () => {
    expect(job({}, { id: "morning" }).name).toBe("Daily")
    expect(job({ name: undefined }, { id: "morning" }).name).toBe("morning")
    expect(job({ action: { type: "command", name: "/jobs-status" } }).action).toEqual({ type: "command", name: "jobs-status" })
  })

  test("resolves a schedule's zone: the job's, then the option's, then the server's", () => {
    expect(job({}, { timezone: "Europe/London" }).schedule).toEqual({ kind: "cron", cron: "0 7 * * *", tz: "Europe/London" })
    expect(job({ schedule: { cron: "0 7 * * *", tz: "America/New_York" } }, { timezone: "Europe/London" }).schedule).toMatchObject({ tz: "America/New_York" })
    expect(jobTimezone(undefined, null)).toBe(serverTimezone())
    expect(jobTimezone(undefined, "Europe/London")).toBe("Europe/London")
    expect(jobTimezone("UTC", "Europe/London")).toBe("UTC")
  })

  test("reads a wall clock in the schedule's zone, and refuses one the clock skips", () => {
    const at = parseJob({ schedule: { at: "2026-11-07T09:00", tz: "America/New_York" }, action: { type: "prompt", text: "x" }, agent: "jobs" }, context())
    expect(at.schedule).toMatchObject({ kind: "at", atMs: Date.parse("2026-11-07T14:00:00Z") })
    expect(wallClock("2026-11-01T01:30", "America/New_York")).toBe(Date.parse("2026-11-01T05:30:00Z"))
    expect(wallClock("2026-03-08T02:30", "America/New_York")).toBeUndefined()
    expect(parseInstant("2026-03-08T02:30:00-05:00", "at", "UTC")).toBe(Date.parse("2026-03-08T07:30:00Z"))
    expect(codeOf(() => parseInstant("2026-03-08T02:30", "at", "America/New_York"))).toBe("JOBS_INVALID_JOB")
    expect(codeOf(() => parseInstant("tomorrow", "at", "UTC"))).toBe("JOBS_INVALID_JOB")
  })
})

describe("the job rules", () => {
  test.each([
    [{ schedule: { cron: "*/5 * * * * *" } }, "JOBS_INVALID_SCHEDULE"],
    [{ schedule: { cron: "@daily" } }, "JOBS_INVALID_SCHEDULE"],
    [{ schedule: { cron: "0 0 30 2 *" } }, "JOBS_INVALID_SCHEDULE"],
    [{ schedule: { cron: "not a cron" } }, "JOBS_INVALID_SCHEDULE"],
    [{ schedule: { cron: "0 7 * * *", every: "1h" } }, "JOBS_INVALID_SCHEDULE"],
    [{ schedule: {} }, "JOBS_INVALID_SCHEDULE"],
    [{ schedule: undefined }, "JOBS_INVALID_SCHEDULE"],
    [{ schedule: { cron: "0 7 * * *", tz: "Mars/Olympus" } }, "JOBS_INVALID_SCHEDULE"],
    [{ schedule: { every: "30s" } }, "JOBS_INVALID_SCHEDULE"],
    [{ schedule: { every: "soon" } }, "JOBS_INVALID_SCHEDULE"],
    [{ schedule: { at: "2026-03-08T02:30", tz: "America/New_York" } }, "JOBS_INVALID_SCHEDULE"],
    [{ agent: undefined }, "JOBS_INVALID_JOB"],
    [{ action: { type: "shell", text: "rm -rf /" } }, "JOBS_INVALID_JOB"],
    [{ action: { type: "prompt" } }, "JOBS_INVALID_JOB"],
    [{ action: { type: "command", name: "  " } }, "JOBS_INVALID_JOB"],
    [{ action: { type: "remind", text: "x" } }, "JOBS_TARGET_MISSING"],
    [{ allow: [{ action: "shell", resource: "*", effect: "allow" }] }, "JOBS_ALLOW_WIDENS"],
    [{ allow: "shell" }, "JOBS_INVALID_JOB"],
    [{ policy: { overlap: "sometimes" } }, "JOBS_INVALID_JOB"],
    [{ policy: { catchup: "all" } }, "JOBS_INVALID_JOB"],
    [{ policy: { timeout: "0s" } }, "JOBS_INVALID_JOB"],
    [{ policy: { retries: { max: 11 } } }, "JOBS_INVALID_JOB"],
    [{ policy: { retries: { max: 2, backoff: "later" } } }, "JOBS_INVALID_JOB"],
    [{ ends: {} }, "JOBS_INVALID_JOB"],
    [{ ends: { times: 0 } }, "JOBS_INVALID_JOB"],
    [{ name: "" }, "JOBS_INVALID_JOB"],
    [{ name: "x".repeat(121) }, "JOBS_INVALID_JOB"],
    [{ jitter: "soon" }, "JOBS_INVALID_JOB"],
    [{ unknownKey: true }, "JOBS_INVALID_JOB"],
  ])("refuses %j with %s", (overrides, code) => {
    expect(codeOf(() => job(overrides))).toBe(code)
  })

  test("accepts a deny-only narrowing list, and resolves retries and ends", () => {
    const parsed = job({ allow: [{ action: "shell", resource: "*", effect: "deny" }], policy: { retries: { max: 2, backoff: "2m" } }, ends: { at: "2026-12-01T00:00:00Z", times: 4 } })
    expect(parsed.allow).toEqual([{ action: "shell", resource: "*", effect: "deny" }])
    expect(parsed.policy.retries).toEqual({ max: 2, backoffMs: 2 * MINUTE })
    expect(parsed.ends).toEqual({ at: Date.parse("2026-12-01T00:00:00Z"), times: 4 })
    expect(job({ policy: { retries: 3 } }).policy.retries.max).toBe(3)
  })

  test("a refusal reads CODE: what Next step: what, with the field at fault", () => {
    try {
      job({ policy: { overlap: "sometimes" } })
      throw new Error("expected a refusal")
    } catch (error) {
      const failure = error as Error & { code: string; field: string; nextStep: string }
      expect(failure.code).toBe("JOBS_INVALID_JOB")
      expect(failure.field).toBe("policy.overlap")
      expect(failure.message.startsWith(`JOBS_INVALID_JOB: "policy.overlap" is "sometimes"`)).toBe(true)
      expect(failure.message.endsWith(`. Next step: ${failure.nextStep}`)).toBe(true)
      expect(failure.nextStep.endsWith(".")).toBe(true)
    }
  })
})

describe("ids, durations and jitter", () => {
  test("a slug is lower case, ASCII and stable", () => {
    expect(slug("Morning Brief")).toBe("morning-brief")
    expect(slug("  Café  au lait! ")).toBe("cafe-au-lait")
    expect(slug("***")).toBe("job")
    expect(slug("x".repeat(80))).toHaveLength(48)
  })

  test("a ULID has 26 characters, sorts by time, and takes injected randomness", () => {
    const bytes = new Uint8Array(10).fill(0)
    const first = ulid(NOW, bytes)
    const later = ulid(NOW + 1, bytes)
    expect(first).toHaveLength(26)
    expect(first < later).toBe(true)
    expect(ulid(NOW, bytes)).toBe(first)
    expect(first.startsWith("01")).toBe(true)
    expect(nextId(NOW)).toStartWith("job_")
    expect(nextId(NOW)).toHaveLength(30)
  })

  test.each([
    ["30s", 30_000],
    ["30m", MINUTE * 30],
    ["5 minutes", MINUTE * 5],
    ["24h", DAY],
    ["7d", DAY * 7],
    ["1.5h", MINUTE * 90],
    ["soon", undefined],
    ["-5m", undefined],
    ["5", undefined],
  ])("reads %s as %s", (text, ms) => {
    expect(parseDuration(text)).toBe(ms)
  })

  test("jitter is zero by default, within its bound, and the same for the same id", () => {
    expect(jitterFor("job_1", 0)).toBe(0)
    const first = jitterFor("job_1", 30_000)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThanOrEqual(30_000)
    expect(jitterFor("job_1", 30_000)).toBe(first)
    expect(jitterFor("job_2", 30_000)).not.toBe(first)
  })
})
