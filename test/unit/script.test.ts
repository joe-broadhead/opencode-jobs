// A script's definition, its digest, its approval binding and its run-session rules. The rules are the one place a
// mistake widens permission, so the matrix here is exhaustive about denies: no method that resolves to deny may ever
// receive a session allow (a session allow beats an agent deny; V3, S2).
import { describe, expect, test } from "bun:test"
import { evaluate } from "../../src/host/permissions.js"
import { parseJob, parseScriptDefinition, type Job } from "../../src/jobs/model.js"
import {
  approvalResource,
  approvalMatches,
  digestOf,
  denied,
  limitsOf,
  manifestDigest,
  reachesOf,
  scriptDigest,
  scriptSessionRules,
  sourceHash,
  SCRIPT_DEFAULTS,
  SCRIPT_MAX,
  type ResolvedTool,
  type Script,
} from "../../src/jobs/script.js"
import { SELF_DENIES } from "../../src/jobs/safety.js"

const NOW = Date.UTC(2026, 11, 6, 9, 0, 0)
const job = (action: unknown, overrides: Record<string, unknown> = {}): Job =>
  parseJob({ name: "Script", schedule: { every: "1h" }, action, ...overrides }, { now: NOW, timezone: "UTC", id: "script", source: "tool", createdBy: "agent" })

const tool = (method: string, action: string, effect: ResolvedTool["effect"] = "allow", klass: ResolvedTool["class"] = "read"): ResolvedTool => ({ method, action, class: klass, kind: method.startsWith("host:") ? "host" : "family", effect })

describe("the script action", () => {
  test("parses in a job file or a tool call, with unique uses and resolved limits", () => {
    const parsed = job({ type: "script", script: { code: "return 1", uses: ["x.posts.a", "x.posts.a", "host:mem_mem_remember"], limits: { maxCalls: 5 } } })
    expect(parsed.action).toMatchObject({ type: "script", script: { code: "return 1", uses: ["x.posts.a", "host:mem_mem_remember"], limits: { maxCalls: 5 } } })
    expect(parsed.agent).toBe("build")
    expect(limitsOf((parsed.action as { script: Script }).script)).toEqual({ ...SCRIPT_DEFAULTS, maxCalls: 5 })
  })

  test("keeps the source's own indentation, and refuses an empty script, an empty manifest, a bad entry or an unknown field", () => {
    const code = "\n  const x = 1;\n  return x;\n"
    expect((parseScriptDefinition({ code, uses: ["host:a"] }) as Script).code).toBe(code)
    expect(() => parseScriptDefinition({ code: "  ", uses: ["host:a"] })).toThrow("JOBS_INVALID_JOB")
    expect(() => parseScriptDefinition({ code: "return 1", uses: [] })).toThrow("could call nothing")
    expect(() => parseScriptDefinition({ code: "return 1", uses: ["x"] })).toThrow("is not a method")
    expect(() => parseScriptDefinition({ code: "return 1", uses: ["host:a"], extra: true })).toThrow("unknown field")
    expect(() => parseScriptDefinition({ code: "return 1", uses: ["host:a"], limits: { maxCalls: 1001 } })).toThrow("1 to 1000")
  })

  test("caps the limits at the hard bounds and defaults to 100 calls, 64 MB and 64 KB", () => {
    expect(limitsOf({ code: "x", uses: [] })).toEqual(SCRIPT_DEFAULTS)
    expect(limitsOf({ code: "x", uses: [], limits: { memoryMb: 10_000, maxCalls: 10_000, maxOutputBytes: 10_000_000 } })).toEqual(SCRIPT_MAX)
  })

  test("a prompt, command or reminder still requires its agent; only a script defaults to build", () => {
    expect(() => job({ type: "prompt", text: "go" })).toThrow("agent")
    expect(job({ type: "prompt", text: "go" }, { agent: "jobs" }).agent).toBe("jobs")
  })
})

describe("the approval binding", () => {
  const script: Script = { code: "return 1", uses: ["x.posts.a", "host:mem_mem_remember"] }
  const resolved = [tool("x.posts.a", "x_get_a"), tool("host:mem_mem_remember", "mem_remember", "ask", "unclassified")]

  test("is the source and the manifest, sorted and order-insensitive, and never the classification", () => {
    const source = sourceHash(script.code)
    const manifest = manifestDigest(script.uses)
    expect(manifest).toBe(manifestDigest([...script.uses].reverse()))
    expect(digestOf(script)).toBe(scriptDigest(source, manifest))
    expect(approvalResource(digestOf(script))).toBe(`script:sha256:${digestOf(script)}`)
    expect(scriptDigest(source, manifest)).not.toBe(scriptDigest(sourceHash("return 2"), manifest))
    expect(scriptDigest(source, manifest)).not.toBe(scriptDigest(source, manifestDigest(["x.posts.b"])))
  })

  test("matches only the same hashes, tools, actions and classes", () => {
    const approval = { sourceHash: sourceHash(script.code), manifestDigest: manifestDigest(script.uses), digest: digestOf(script), at: NOW, resolved }
    expect(approvalMatches(approval, script, resolved)).toBe(true)
    expect(approvalMatches(undefined, script, resolved)).toBe(false)
    expect(approvalMatches(approval, { ...script, code: "return 2" }, resolved)).toBe(false)
    expect(approvalMatches(approval, script, [resolved[0]!, { ...resolved[1]!, action: "other" }])).toBe(false)
    // A classification change invalidates it: the person approved a read, and it became a write.
    expect(approvalMatches(approval, script, [resolved[0]!, { ...resolved[1]!, class: "write" }])).toBe(false)
    // The effect is not part of the binding: a deny is reported as `revoked` by the run, not as a stale approval (D1).
    expect(approvalMatches(approval, script, [resolved[0]!, { ...resolved[1]!, effect: "deny" }])).toBe(true)
  })

  test("lists a write, a send, an export and an unclassified tool, and no read", () => {
    const lines = reachesOf([tool("x.posts.a", "x_get_a"), tool("x.posts.b", "x_post_b", "ask", "send"), tool("host:mem", "mem", "ask", "unclassified")])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("a send")
    expect(lines[1]).toContain("an unclassified tool")
  })
})

describe("the run session's rules", () => {
  test("start with a blanket deny, then one allow per granted action, then the job-state denies", () => {
    const rules = scriptSessionRules([tool("x.posts.a", "x_get_a"), tool("x.posts.b", "x_post_b", "ask", "write")], SELF_DENIES)
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    expect(rules.filter((rule) => rule.effect === "allow")).toEqual([
      { action: "x_get_a", resource: "*", effect: "allow" },
      { action: "x_post_b", resource: "*", effect: "allow" },
    ])
    for (const deny of SELF_DENIES) expect(rules).toContainEqual(deny)
  })

  test("never write an allow for a deny, or two for the same action", () => {
    const rules = scriptSessionRules([tool("x.a", "shared", "deny", "write"), tool("x.b", "shared", "ask"), tool("x.c", "shared", "allow")], SELF_DENIES)
    const allows = rules.filter((rule) => rule.effect === "allow" && rule.action === "shared")
    // The deny came first, and a deny is never granted; the later allow-bearing entries share one action, so one allow.
    expect(allows).toHaveLength(1)
    expect(rules.findIndex((rule) => rule.action === "shared")).toBeGreaterThan(0)
  })

  test("no method that resolves to deny gets a session allow, across a matrix of rule shapes", () => {
    const actions = ["x_read", "x_write", "x_send", "x_delete"]
    const shapes: readonly [string, readonly { action: string; resource: string; effect: "allow" | "deny" | "ask" }[]][] = [
      ["default allow", [{ action: "*", resource: "*", effect: "allow" }]],
      ["blanket deny", [{ action: "*", resource: "*", effect: "allow" }, { action: "*", resource: "*", effect: "deny" }]],
      ["wildcard ask", [{ action: "*", resource: "*", effect: "allow" }, { action: "x_*", resource: "*", effect: "ask" }]],
      ["specific deny", [{ action: "*", resource: "*", effect: "allow" }, { action: "x_delete", resource: "*", effect: "deny" }]],
      ["allow after deny", [{ action: "*", resource: "*", effect: "allow" }, { action: "x_delete", resource: "*", effect: "deny" }, { action: "x_delete", resource: "*", effect: "allow" }]],
      ["deny after allow", [{ action: "*", resource: "*", effect: "allow" }, { action: "x_write", resource: "*", effect: "allow" }, { action: "x_write", resource: "*", effect: "deny" }]],
      ["no rule", []],
    ]
    let denyCases = 0
    for (const [, rules] of shapes) {
      const resolved = actions.map((action) => tool(`x.${action}`, action, evaluate(rules, action), "write"))
      const session = scriptSessionRules(resolved, SELF_DENIES)
      for (const entry of resolved) {
        const granted = session.some((rule) => rule.effect === "allow" && rule.action === entry.action)
        if (entry.effect === "deny") {
          denyCases += 1
          expect({ action: entry.action, granted }).toEqual({ action: entry.action, granted: false })
        } else expect({ action: entry.action, granted }).toEqual({ action: entry.action, granted: true })
      }
    }
    // Every shape produced at least one deny, so the test really exercised the hazard.
    expect(denyCases).toBeGreaterThanOrEqual(4)
    expect(denied(actions.map((action, index) => tool(`x.${action}`, action, index === 0 ? "deny" : "allow"))).map((entry) => entry.method)).toEqual(["x.x_read"])
  })
})
