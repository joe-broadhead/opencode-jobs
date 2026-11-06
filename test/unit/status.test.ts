import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { formatStatus, buildStatus, NOTHING_TO_DO, unavailable, type StatusFacts } from "../../src/status.js"

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
const TESTED = { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }
const facts = (overrides: Partial<StatusFacts> = {}): StatusFacts => ({ host: TESTED, enabled: true, ...overrides })

describe("the status model", () => {
  test("is ready, with the shared fields and no jobs, on a tested host", () => {
    expect(buildStatus(facts())).toEqual({
      version: pkg.version,
      state: "ready",
      host: TESTED,
      jobs: { total: 0, paused: 0, expiring: 0, invalidFiles: 0 },
      unguardedAgents: [],
      problems: [],
      nextStep: NOTHING_TO_DO,
    })
  })

  test("says the plugin is disabled when the option turns it off, and how to turn it back on", () => {
    const status = buildStatus(facts({ enabled: false }))
    expect(status.state).toBe("disabled")
    expect(status.nextStep).toBe('Set the plugin option "enabled" to true, or remove it, then restart OpenCode.')
  })

  test("names the agents that are not guarded and counts the jobs it is given", () => {
    const status = buildStatus(facts({ unguardedAgents: ["reviewer"], jobs: { total: 12, paused: 2, expiring: 1, invalidFiles: 3 } }))
    expect(status.unguardedAgents).toEqual(["reviewer"])
    expect(formatStatus(status)).toContain("- Jobs: 12 total, 2 paused, 1 expiring, 3 invalid files")
    expect(formatStatus(status)).toContain("- Agents without default rules: reviewer")
  })

  test("takes its next step from the first problem, which is a coded message", () => {
    const status = buildStatus(facts({ problems: ["SKILLS_INVALID: A skill file is broken. Next step: Reinstall the plugin."] }))
    expect(status.nextStep).toBe("Reinstall the plugin.")
  })
})

describe("the status text", () => {
  test("renders the rows, and says there are no jobs yet", () => {
    expect(formatStatus(buildStatus(facts()))).toBe(
      [
        "Jobs status",
        "- Jobs: none yet",
        "- Next runs: none",
        "- Recent runs: none",
        "- Agents without default rules: none",
        "- OpenCode: 2.2.5 (tested; supported range >=2.2.3 <2.3.0)",
        `- Next step: ${NOTHING_TO_DO}`,
      ].join("\n"),
    )
  })

  test("has exactly one Next step line, which is the model's", () => {
    const text = formatStatus(buildStatus(facts({ enabled: false, unguardedAgents: ["reviewer"] })))
    expect(text.split("\n").filter((line) => line.startsWith("- Next step: "))).toEqual([`- Next step: ${buildStatus(facts({ enabled: false })).nextStep}`])
  })

  test("calls an untested release untested, and explains the override outside the range", () => {
    expect(formatStatus(buildStatus(facts({ host: { version: "2.2.6", range: ">=2.2.3 <2.3.0", tested: false } })))).toContain(
      "- OpenCode: 2.2.6 (untested; supported range >=2.2.3 <2.3.0)",
    )
    expect(formatStatus(buildStatus(facts({ host: { version: "2.3.0", range: ">=2.2.3 <2.3.0", tested: false } })))).toContain(
      "It is outside the supported range; the plugin runs because allowUntestedHost is true. If a job misbehaves, use OpenCode 2.2.3, 2.2.4 or 2.2.5.",
    )
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
