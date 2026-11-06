import { describe, expect, test } from "bun:test"
import { DAY, parseJob } from "../../src/jobs/model.js"
import {
  MAX_RUNS,
  RETENTION_MS,
  SCHEMA_VERSION,
  SUMMARY_LIMIT,
  getRun,
  migrate,
  prune,
  pruneRuns,
  pruneWithSessions,
  putJob,
  putRun,
  putState,
  readJobs,
  readState,
  removeJob,
  removeRun,
  scanRuns,
  slotISO,
  type RunRecord,
} from "../../src/jobs/store.js"
import { memoryStorage } from "./fake.js"

const NOW = Date.UTC(2026, 11, 6, 12, 0, 0)
const MINUTE = 60_000
const job = (id: string, source: "tool" | "file" = "tool") =>
  parseJob({ name: id, schedule: { cron: "0 7 * * *" }, action: { type: "prompt", text: "x" }, agent: "jobs" }, { now: NOW, timezone: "UTC", id, source })

const run = (id: string, minutesAgo: number, overrides: Partial<RunRecord> = {}): RunRecord => ({
  job: id,
  slot: slotISO(NOW - minutesAgo * MINUTE),
  status: "succeeded",
  late: false,
  attempt: 1,
  startedAt: NOW - minutesAgo * MINUTE,
  endedAt: NOW - minutesAgo * MINUTE + 5_000,
  outcome: "succeeded",
  ...overrides,
})

describe("the store schema", () => {
  test("a new store is schema 1, and the migration writes nothing a second time", async () => {
    const { storage, calls, keys } = memoryStorage()
    expect(SCHEMA_VERSION).toBe(1)
    expect(await migrate(storage)).toEqual({ version: 1, previous: null })
    expect(keys()).toEqual(["meta/schema"])
    expect((await storage.get("meta/schema"))).toBe(1)
    const writes = calls.set
    expect(await migrate(storage)).toEqual({ version: 1, previous: 1 })
    expect(calls.set).toBe(writes)
  })

  test("a migration keeps what the store already holds", async () => {
    const { storage } = memoryStorage()
    await putState(storage, { job: "daily", runCount: 4, consecutiveFailures: 1, nextDueAt: NOW })
    await migrate(storage)
    expect(await readState(storage, "daily")).toMatchObject({ runCount: 4, consecutiveFailures: 1, nextDueAt: NOW })
  })

  test("a store from a newer plugin is refused, not overwritten", async () => {
    const { storage } = memoryStorage()
    await storage.set("meta/schema", SCHEMA_VERSION + 1)
    try {
      await migrate(storage)
      throw new Error("expected a refusal")
    } catch (error) {
      const failure = error as Error & { code: string; nextStep: string }
      expect(failure.code).toBe("JOBS_STORAGE_VERSION")
      expect(failure.message.startsWith("JOBS_STORAGE_VERSION: ")).toBe(true)
      expect(failure.message.endsWith(`. Next step: ${failure.nextStep}`)).toBe(true)
      expect(failure.nextStep.endsWith(".")).toBe(true)
    }
    expect(await storage.get("meta/schema")).toBe(SCHEMA_VERSION + 1)
  })
})

describe("jobs and their state", () => {
  test("stores tool jobs, reads them across pages, and never stores a file job", async () => {
    const { storage } = memoryStorage(2)
    for (const id of ["alpha", "bravo", "charlie", "delta", "echo"]) await putJob(storage, job(id))
    expect((await readJobs(storage)).map((entry) => entry.id)).toEqual(["alpha", "bravo", "charlie", "delta", "echo"])
    await expect(putJob(storage, job("from-file", "file"))).rejects.toThrow("only a tool job is stored")
  })

  test("a job that never ran has zeroed state, and state round-trips", async () => {
    const { storage } = memoryStorage()
    expect(await readState(storage, "daily")).toEqual({ job: "daily", runCount: 0, consecutiveFailures: 0 })
    await putState(storage, { job: "daily", runCount: 3, consecutiveFailures: 2, nextDueAt: NOW, lastRun: slotISO(NOW - MINUTE), queuedSlot: NOW, paused: { at: NOW, reason: "five failures" } })
    expect(await readState(storage, "daily")).toEqual({ job: "daily", runCount: 3, consecutiveFailures: 2, nextDueAt: NOW, lastRun: slotISO(NOW - MINUTE), queuedSlot: NOW, paused: { at: NOW, reason: "five failures" } })
  })

  test("removing a job removes its definition and state, and leaves its history", async () => {
    const { storage } = memoryStorage()
    await putJob(storage, job("daily"))
    await putState(storage, { job: "daily", runCount: 1, consecutiveFailures: 0 })
    await putRun(storage, run("daily", 1))
    await removeJob(storage, "daily")
    expect(await readJobs(storage)).toEqual([])
    expect(await readState(storage, "daily")).toEqual({ job: "daily", runCount: 0, consecutiveFailures: 0 })
    expect(await scanRuns(storage)).toHaveLength(1)
  })
})

describe("run records", () => {
  test("canonicalise the slot, read back, and delete", async () => {
    const { storage } = memoryStorage()
    const stored = await putRun(storage, { ...run("daily", 1), slot: "2026-11-06T11:59:00.5Z" })
    expect(stored.slot).toBe("2026-11-06T11:59:00.500Z")
    expect(await getRun(storage, "daily", stored.slot)).toMatchObject({ job: "daily", status: "succeeded" })
    await removeRun(storage, stored)
    expect(await getRun(storage, "daily", stored.slot)).toBeUndefined()
  })

  test("caps the summary and the error, because both are job output", async () => {
    const { storage } = memoryStorage()
    const stored = await putRun(storage, run("daily", 1, { summary: "s".repeat(SUMMARY_LIMIT + 100), error: "e".repeat(900) }))
    expect(stored.summary).toHaveLength(SUMMARY_LIMIT)
    expect(stored.summary?.endsWith("…")).toBe(true)
    expect(stored.error!.length).toBeLessThanOrEqual(500)
    expect(SUMMARY_LIMIT).toBe(2048)
  })

  test("refuses a slot that is not a time", async () => {
    const { storage } = memoryStorage()
    await expect(putRun(storage, { ...run("daily", 1), slot: "yesterday" })).rejects.toThrow("is not a time")
  })

  test("scans newest first, one job's or all of them, across pages", async () => {
    const { storage } = memoryStorage(2)
    for (const minutes of [30, 10, 20, 40, 50]) await putRun(storage, run("daily", minutes))
    await putRun(storage, run("hourly", 5))
    const all = await scanRuns(storage)
    expect(all).toHaveLength(6)
    expect(all.map((record) => record.job)).toEqual(["hourly", "daily", "daily", "daily", "daily", "daily"])
    expect(all.filter((record) => record.job === "daily").map((record) => record.slot)).toEqual([10, 20, 30, 40, 50].map((minutes) => slotISO(NOW - minutes * MINUTE)))
  })
})

describe("retention", () => {
  test("keeps the last 50 runs and 30 days, whichever keeps less", () => {
    const many = Array.from({ length: 60 }, (_, index) => run("daily", index + 1))
    const pruned = pruneRuns(many, NOW)
    expect(pruned.keep).toHaveLength(MAX_RUNS)
    expect(pruned.remove).toHaveLength(10)
    // The ten oldest go, and the newest stays.
    expect(pruned.remove.map((record) => record.slot)).not.toContain(many[0]!.slot)
    expect(pruned.keep.map((record) => record.slot)).toContain(many[0]!.slot)
  })

  test("keeps a month of runs, and never the newest", () => {
    const old = Array.from({ length: 5 }, (_, index) => run("daily", 60 * 24 * (41 + index)))
    const pruned = pruneRuns(old, NOW)
    expect(pruned.keep).toHaveLength(1)
    expect(pruned.keep[0]!.slot).toBe(old[0]!.slot)
    expect(RETENTION_MS).toBe(30 * 24 * 60 * MINUTE)
  })

  test("never prunes a running record, even an old one past the fifty", () => {
    const old = Array.from({ length: 55 }, (_, index) => run("daily", 60 * 24 * (40 + index)))
    const running = run("daily", 60 * 24 * 90, { status: "running", outcome: undefined, endedAt: undefined, startedAt: NOW - 60 * 24 * 90 * MINUTE })
    const pruned = pruneRuns([...old, running], NOW)
    expect(pruned.keep).toContain(running)
    expect(pruned.keep).toHaveLength(2)
  })

  test("prunes each job on its own", () => {
    const daily = Array.from({ length: 4 }, (_, index) => run("daily", index + 1))
    const hourly = Array.from({ length: 3 }, (_, index) => run("hourly", 60 * 24 * (45 + index)))
    const pruned = pruneRuns([...daily, ...hourly], NOW)
    expect(pruned.keep.filter((record) => record.job === "daily")).toHaveLength(4)
    expect(pruned.keep.filter((record) => record.job === "hourly")).toHaveLength(1)
  })

  test("pruning the store removes the records it returns", async () => {
    const { storage, keys } = memoryStorage(3)
    await putRun(storage, run("daily", 1))
    for (let index = 0; index < 55; index += 1) await putRun(storage, run("daily", 60 * 24 * (40 + index)))
    const pruned = await prune(storage, NOW)
    expect(pruned.remove).toHaveLength(55)
    expect(await scanRuns(storage)).toHaveLength(1)
    expect(keys().filter((key) => key.startsWith("run/"))).toHaveLength(1)
  })
})

describe("retention and its sessions", () => {
  const at = (daysAgo: number) => NOW - daysAgo * DAY
  const record = (slot: string, status: RunRecord["status"], sessionID?: string) => ({ job: "five", slot, status, late: false, attempt: 1, ...(sessionID === undefined ? {} : { sessionID }) })

  test("a pruned record's session goes with it, and a busy one stays", async () => {
    const storage = memoryStorage()
    const old = new Date(at(31)).toISOString()
    const newest = new Date(at(0)).toISOString()
    const running = new Date(at(40)).toISOString()
    await putRun(storage.storage, record(old, "succeeded", "ses_old"))
    await putRun(storage.storage, record(newest, "succeeded", "ses_new"))
    await putRun(storage.storage, record(running, "running", "ses_running"))
    const removed: string[] = []
    const session = {
      get: async ({ sessionID }: { sessionID: string }) => (sessionID === "ses_running" ? { outcome: undefined } : { outcome: "succeeded" }),
      remove: async ({ sessionID }: { sessionID: string }) => void removed.push(sessionID),
    }
    const report = await pruneWithSessions(storage.storage, session, NOW)
    expect(report.removed.map((entry) => entry.slot)).toEqual([old])
    expect(report.sessions).toEqual(["ses_old"])
    expect(report.keptBusy).toEqual([])
    expect(removed).toEqual(["ses_old"])
    // The running record and the newest one are kept, as D9 says.
    expect((await scanRuns(storage.storage)).map((entry) => entry.slot).sort()).toEqual([running, newest].sort())
  })

  test("a busy session named by a pruned record is left alone", async () => {
    const storage = memoryStorage()
    const old = new Date(at(31)).toISOString()
    await putRun(storage.storage, record(old, "succeeded", "ses_busy"))
    // A newer record, so the old one is not the job's newest, which retention always keeps.
    await putRun(storage.storage, record(new Date(at(0)).toISOString(), "succeeded"))
    const removed: string[] = []
    const report = await pruneWithSessions(storage.storage, { get: async () => ({ outcome: undefined }), remove: async ({ sessionID }) => void removed.push(sessionID) }, NOW)
    expect(report.removed).toHaveLength(1)
    expect(report.keptBusy).toEqual(["ses_busy"])
    expect(removed).toEqual([])
  })
})
