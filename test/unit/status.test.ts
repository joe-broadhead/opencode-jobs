import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  buildStatus,
  compactStatus,
  duration,
  formatCompact,
  formatStatus,
  NOTHING_TO_DO,
  unavailable,
  type StatusFacts,
} from "../../src/status.js"

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
const TESTED = { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }
const facts = (overrides: Partial<StatusFacts> = {}): StatusFacts => ({ host: TESTED, enabled: true, keepAliveMinutes: 20, ...overrides })
const runner = { location: "/work", pid: 41, since: Date.UTC(2026, 11, 6, 8, 0, 0) }
const job = (id: string, name: string, at: number) => ({ id, name, at })
const run = (name: string, status: "succeeded" | "failed" | "missed", extra: Record<string, unknown> = {}) => ({ job: "x", name, slot: "2026-12-06T09:00:00.000Z", status, late: false, attempt: 1, ...extra })

describe("the status model", () => {
  test("is ready, with the shared fields and no jobs, on a tested host", () => {
    expect(buildStatus(facts())).toEqual({
      version: pkg.version,
      state: "ready",
      host: TESTED,
      jobs: { total: 0, paused: 0, expiring: 0, invalidFiles: 0 },
      runner: null,
      liveness: { everyMinutes: 20 },
      nextRuns: [],
      recentRuns: [],
      failures: [],
      unguardedAgents: [],
      missingAgents: [],
      problems: [],
      nextStep: NOTHING_TO_DO,
    })
  })

  test("says the plugin is disabled when the option turns it off, and how to turn it back on", () => {
    const status = buildStatus(facts({ enabled: false }))
    expect(status.state).toBe("disabled")
    expect(status.nextStep).toBe('Set the plugin option "enabled" to true, or remove it, then restart OpenCode.')
  })

  test("names the agents that are not guarded, counts the jobs it is given and carries the block", () => {
    const status = buildStatus(facts({ unguardedAgents: ["reviewer"], jobs: { total: 12, paused: 2, expiring: 1, invalidFiles: 3 } }))
    expect(status.unguardedAgents).toEqual(["reviewer"])
    expect(status.permissionsBlock?.[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    const text = formatStatus(status)
    expect(text).toContain("- Jobs: 12 total, 2 paused, 1 expiring, 3 invalid files")
    expect(text).toContain("- Agents without default rules: reviewer")
    expect(text).toContain('Paste this for "reviewer" into opencode.json:')
    expect(text).toContain('"effect": "deny"')
    expect(status.nextStep).toBe('Give the agent "reviewer" the read-only block, starting with the blanket deny, or point its job at an agent that has it.')
  })

  test("says when the host no longer lists an agent, and how to bring it back", () => {
    const status = buildStatus(facts({ missingAgents: ["jobs"], jobs: { total: 3, paused: 0, expiring: 0, invalidFiles: 1 } }))
    expect(status.missingAgents).toEqual(["jobs"])
    const text = formatStatus(status)
    expect(text).toContain("- Agents OpenCode no longer lists: jobs — jobs that name one do not run, which can happen after a plugin update; run \"opencode reload\" in a terminal, or restart OpenCode.")
    expect(status.nextStep).toBe('Run "opencode reload" in a terminal (or restart OpenCode); jobs resume on their own once the agent is back.')
    expect(compactStatus(status).missingAgents).toBe(1)
    expect(formatCompact(compactStatus(status), 3)).toContain("1 agent are no longer listed")
  })

  test("takes its next step from the first problem, which is a coded message", () => {
    const status = buildStatus(facts({ problems: ["SKILLS_INVALID: A skill file is broken. Next step: Reinstall the plugin."] }))
    expect(status.nextStep).toBe("Reinstall the plugin.")
  })

  test("says every job is paused, since a time, and how to resume them", () => {
    const paused = { at: Date.UTC(2026, 11, 6, 9, 0, 0) }
    const status = buildStatus(facts({ paused, runner }))
    expect(status.paused).toEqual(paused)
    expect(status.nextStep).toBe("Run /jobs-pause again to resume every job.")
    expect(formatStatus(status)).toContain("- Runner: paused since 2026-12-06T09:00:00.000Z; leader in /work (pid 41) since 2026-12-06T08:00:00.000Z")
  })

  test("says what failed, and points at the run that did", () => {
    const status = buildStatus(facts({ failures: [{ name: "Nightly", code: "JOBS_TIMEOUT", count: 2 }] }))
    expect(status.nextStep).toContain("fix JOBS_TIMEOUT")
    expect(formatStatus(status)).toContain("- Failures needing attention: Nightly — JOBS_TIMEOUT (×2)")
  })
})

describe("the status text", () => {
  test("renders the nine rows of DESIGN §9, and says there is nothing yet", () => {
    expect(formatStatus(buildStatus(facts()))).toBe(
      [
        "Jobs status",
        "- Runner: no leader yet",
        "- Liveness: keep-alive every 20 minutes; no beat yet",
        "- Jobs: none yet",
        "- Next runs: none",
        "- Recent runs: none",
        "- Failures needing attention: none",
        "- Agents without default rules: none",
        "- OpenCode: 2.2.5 (tested; supported range >=2.2.3 <2.3.0)",
        `- Next step: ${NOTHING_TO_DO}`,
      ].join("\n"),
    )
  })

  test("renders the healthy state: a leader, a beat, the next runs and recent runs", () => {
    const status = buildStatus(
      facts({
        jobs: { total: 2, paused: 0, expiring: 0, invalidFiles: 0 },
        runner,
        liveness: { everyMinutes: 20, lastBeatAt: Date.UTC(2026, 11, 6, 8, 20, 0), lastBeatOk: true },
        nextRuns: [job("morning", "Morning brief", Date.UTC(2026, 11, 7, 7, 0, 0)), job("nightly", "Nightly", Date.UTC(2026, 11, 6, 18, 0, 0))].sort((a, b) => a.at - b.at),
        recentRuns: [run("Morning brief", "succeeded", { durationMs: 4_200 }), run("Nightly", "missed", { count: 3, late: true })],
      }),
    )
    const text = formatStatus(status)
    expect(text).toContain("- Runner: leader in /work (pid 41) since 2026-12-06T08:00:00.000Z")
    expect(text).toContain("- Liveness: keep-alive every 20 minutes; last beat 2026-12-06T08:20:00.000Z ok")
    expect(text).toContain("- Next runs: Nightly at 2026-12-06T18:00:00.000Z; Morning brief at 2026-12-07T07:00:00.000Z")
    expect(text).toContain("- Recent runs: Morning brief succeeded 4 s; Nightly missed late ×3")
    expect(text).toContain(`- Next step: ${NOTHING_TO_DO}`)
  })

  test("renders the stopped state: the leader stopped, and a failed beat says so", () => {
    const status = buildStatus(
      facts({
        runner: { ...runner, stoppedAt: Date.UTC(2026, 11, 6, 9, 30, 0) },
        liveness: { everyMinutes: 5, lastBeatAt: Date.UTC(2026, 11, 6, 9, 25, 0), lastBeatOk: false },
      }),
    )
    const text = formatStatus(status)
    expect(text).toContain("- Runner: stopped from 2026-12-06T09:30:00.000Z to now; leader in /work (pid 41) since 2026-12-06T08:00:00.000Z")
    expect(text).toContain("- Liveness: keep-alive every 5 minutes; last beat 2026-12-06T09:25:00.000Z failed")
  })

  test("has exactly one Next step line, which is the model's", () => {
    const text = formatStatus(buildStatus(facts({ enabled: false, unguardedAgents: ["reviewer"] })))
    expect(text.split("\n").filter((line) => line.startsWith("- Next step: "))).toEqual([`- Next step: ${buildStatus(facts({ enabled: false })).nextStep}`])
    expect(text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(9)
  })

  test("calls an untested release untested, and explains the override outside the range", () => {
    expect(formatStatus(buildStatus(facts({ host: { version: "2.2.6", range: ">=2.2.3 <2.3.0", tested: false } })))).toContain(
      "- OpenCode: 2.2.6 (untested; supported range >=2.2.3 <2.3.0)",
    )
    expect(formatStatus(buildStatus(facts({ host: { version: "2.3.0", range: ">=2.2.3 <2.3.0", tested: false } })))).toContain(
      "It is outside the supported range; the plugin runs because allowUntestedHost is true. If a job misbehaves, use OpenCode 2.2.3, 2.2.4 or 2.2.5.",
    )
  })

  test("writes a duration in the shortest unit that reads well", () => {
    expect(duration(420)).toBe("420 ms")
    expect(duration(4_200)).toBe("4 s")
    expect(duration(65_000)).toBe("1 min 5 s")
    expect(duration(120_000)).toBe("2 min")
  })
})

describe("the compact status the model reads", () => {
  test("is state, counts, the pause, the number of agents to fix and one next step", () => {
    const status = buildStatus(facts({ jobs: { total: 12, paused: 2, expiring: 1, invalidFiles: 0 }, paused: { at: 0 }, unguardedAgents: ["build", "reviewer"] }))
    const compact = compactStatus(status)
    expect(compact).toEqual({
      state: "ready",
      jobs: { total: 12, paused: 2, expiring: 1, invalidFiles: 0 },
      paused: true,
      unguardedAgents: 2,
      missingAgents: 0,
      nextStep: "Run /jobs-pause again to resume every job.",
    })
    const text = formatCompact(compact, status.jobs.total)
    expect(text).toContain("12 jobs, 2 paused, 1 expiring")
    expect(text).toContain("Every job is paused.")
    expect(text).toContain("2 agents need the read-only block.")
    expect(text).toContain("Run /jobs-status for the full report.")
    expect(text).not.toContain('"action"')
  })

  test("says there are no jobs yet", () => {
    expect(formatCompact(compactStatus(buildStatus(facts())), 0)).toStartWith("Jobs: no jobs yet.")
  })
})

describe("status that cannot be read", () => {
  test("is a coded message with one next step, and a reason with no URL query", () => {
    expect(unavailable(new Error("request to https://example.test/x?token=abc failed"))).toEqual({
      message: "STATUS_UNAVAILABLE: Could not read the job status (request to https://example.test/x failed). Next step: Restart OpenCode, then run /jobs-status again.",
      nextStep: "Restart OpenCode, then run /jobs-status again.",
    })
  })

  test("says nothing about the failure when there is no message", () => {
    expect(unavailable(new Error("")).message).toBe("STATUS_UNAVAILABLE: Could not read the job status. Next step: Restart OpenCode, then run /jobs-status again.")
  })
})
