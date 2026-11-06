// The audit's architecture rule (G1): every tool that can change something asserts its own permission before it acts.
// The host does not assert a plugin tool's `options.permission` (proven on 2.2.3, 2.2.4 and 2.2.5), so a missing assert
// is a silent write. This test drives every registered tool and fails on any that changes something without one.
import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { createReport } from "../../src/jobs/report.js"
import { runJobTool, SCHEMAS, toolId, toolTransform, type ToolInput, type ToolName } from "../../src/jobs/tools.js"
import { DEFAULT_RULES, evaluate as evaluateRule, type Rule } from "../../src/host/permissions.js"
import { agentsFake, memoryStorage, testClock } from "./fake.js"

const NOW = Date.UTC(2026, 11, 6, 9, 0, 0)
const HOST = { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }

/** The actions the default rules leave open on purpose: pausing only stops work. */
const OPEN = ["jobs_pause", "jobs_pause_all"]

/** What the default rules do with one tool's action, from the block the plugin inserts. */
const defaultEffect = (action: string): Rule["effect"] => evaluateRule(DEFAULT_RULES, action)

/** The default rule of a tool: `ask` means it must assert, `allow` means it needs to prove it does not act. */
const askTools = (): ToolName[] => (Object.keys(SCHEMAS) as ToolName[]).filter((name) => !OPEN.includes(toolId(name)) && defaultEffect(toolId(name)) === "ask")

function harness() {
  const storage = memoryStorage()
  const clock = testClock(NOW, { instantBelow: 0 })
  const agent = agentsFake()
  const report = createReport({ storage: storage.storage, location: "/nowhere", timezone: "UTC", clock: clock.clock, agent, host: HOST, enabled: true, keepAliveMinutes: 20 })
  const asked: unknown[] = []
  const input: ToolInput = {
    storage: storage.storage,
    agent,
    clock: clock.clock,
    timezone: "UTC",
    location: "/work",
    source: () => report.source(),
    wake: () => undefined,
    ready: true,
    report,
    assert: async (check) => void asked.push(check),
  }
  return { input, asked, storage }
}

/** One value per schema, enough for the tool to reach its action, or to fail after it. */
const SAMPLE: Record<ToolName, unknown> = {
  status: {},
  list: {},
  get: { id: "job_missing" },
  history: {},
  pause: { id: "job_missing" },
  pause_all: {},
  create: { name: "Probe", schedule: { every: "1h" }, action: { type: "prompt", text: "x" }, agent: "jobs" },
  update: { id: "job_missing", name: "Probe" },
  delete: { id: "job_missing" },
  run_now: { id: "job_missing" },
  resume: { id: "job_missing" },
  extend: { id: "job_missing", expires: new Date(NOW + 86_400_000).toISOString() },
}

/** Runs every tool as a model call would, and returns the tools that never asked. */
async function unasserted(entries: readonly { name: ToolName; run: (input: ToolInput) => Promise<unknown> }[]): Promise<ToolName[]> {
  const missed: ToolName[] = []
  for (const entry of entries) {
    const { input, asked } = harness()
    await entry.run(input).catch(() => undefined)
    if (asked.length === 0) missed.push(entry.name)
  }
  return missed
}

const entries = () =>
  (Object.keys(SCHEMAS) as ToolName[]).map((name) => ({
    name,
    run: (input: ToolInput) => runJobTool(input, name, SAMPLE[name], { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }),
  }))

describe("every tool that changes something asserts before it acts", () => {
  test("the default rules ask for every change, and allow only the reads and the two pauses", () => {
    for (const name of Object.keys(SCHEMAS) as ToolName[]) {
      const action = toolId(name)
      const reads = ["jobs_status", "jobs_list", "jobs_get", "jobs_history"].includes(action)
      if (reads || OPEN.includes(action)) expect({ action, effect: defaultEffect(action) }).toEqual({ action, effect: "allow" })
      else expect({ action, effect: defaultEffect(action) }).toEqual({ action, effect: "ask" })
    }
    expect(askTools()).toEqual(["create", "update", "delete", "run_now", "resume", "extend"])
  })

  test("each one asserts its own action, as the call, before it reads or writes anything", async () => {
    expect(await unasserted(entries())).toEqual([])
    for (const name of askTools()) {
      const { input, asked } = harness()
      await runJobTool(input, name, SAMPLE[name], { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }).catch(() => undefined)
      expect(asked[0]).toMatchObject({ action: toolId(name), resources: ["*"], source: { type: "tool", messageID: "msg_1", id: "call_1" } })
    }
  })

  test("the check fails when an assert is removed, so a new unasserted write cannot slip in", async () => {
    const unguarded = entries().map((entry) => (entry.name === "delete" ? { ...entry, run: async (input: ToolInput) => runJobTool(input, "delete", SAMPLE.delete) } : entry))
    expect(await unasserted(unguarded)).toEqual(["delete"])
  })

  test("the two pause tools are the listed exception, and the reason is that they only stop work", async () => {
    for (const name of ["pause", "pause_all"] as const) {
      const { input, asked } = harness()
      await runJobTool(input, name, SAMPLE[name], { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }).catch(() => undefined)
      // They do assert (a user rule may ask about a pause); the exception is that the default rules do not.
      expect(asked[0]).toMatchObject({ action: toolId(name) })
      expect(defaultEffect(toolId(name))).toBe("allow")
    }
  })

  test("the transform registers every tool with the action the rule names", () => {
    const { input } = harness()
    const added: { name: string; options?: { permission?: string } }[] = []
    const editor = { namespace: () => undefined, add: (tool: never) => void added.push(tool) } as unknown as Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
    toolTransform(input)(editor)
    expect(added).toHaveLength(Object.keys(SCHEMAS).length)
    for (const tool of added) expect(tool.options?.permission).toBe(`jobs_${tool.name}`)
  })
})
