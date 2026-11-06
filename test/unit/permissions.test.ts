// The guarded-agent rule: the documented read-only block, the effect of a list of rules, and the refusal a job gets
// when its agent does not deny by default.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { Plugin } from "@opencode/plugin"
import { AGENT_BLOCK, agentBlock, agentBlockJSON, DEFAULT_AGENT, evaluate, guardAgent, isGuarded, refusalFor, unguardedAgents, type AgentInfo, type Rule } from "../../src/host/permissions.js"

const allow: Rule = { action: "*", resource: "*", effect: "allow" }
const deny: Rule = { action: "*", resource: "*", effect: "deny" }
const envAsk: Rule = { action: "read", resource: "*.env", effect: "ask" }

/** An agent as the host reports it: the effective list starts with the base allow, as V3 measured. */
const agent = (id: string, permissions: readonly Rule[]): AgentInfo =>
  ({ id, name: id, mode: "primary", hidden: false, permissions: permissions as Rule[] }) as unknown as AgentInfo

/** The read-only block, parsed from the configuration guide's own fenced example. */
function documentedBlock(): Rule[] {
  const text = readFileSync(new URL("../../docs/configuration.md", import.meta.url), "utf8")
  for (const [, body] of text.matchAll(/```json\n(\{[\s\S]*?\n\})\n```/g)) {
    if (!body.includes('"agents"')) continue
    const config = JSON.parse(body) as { agents: Record<string, { permissions: Rule[] }> }
    return Object.values(config.agents)[0]!.permissions
  }
  throw new Error("docs/configuration.md has no agent block")
}

describe("the read-only block", () => {
  test("is the one in the configuration guide, blanket deny first", () => {
    expect(documentedBlock()).toEqual(AGENT_BLOCK.map((rule) => ({ ...rule })))
    expect(AGENT_BLOCK[0]).toEqual(deny)
    for (const action of ["read", "glob", "grep", "list", "jobs_status", "jobs_list", "jobs_get", "jobs_history", "jobs_pause"]) {
      expect(AGENT_BLOCK).toContainEqual({ action, resource: "*", effect: "allow" })
    }
  })

  test("does not allow a write action", () => {
    for (const action of ["edit", "write", "shell", "jobs_create", "jobs_update", "jobs_delete", "jobs_run_now"]) {
      expect(evaluate(AGENT_BLOCK, action)).toBe("deny")
    }
  })

  test("is paste-ready as the config a person writes, for the agent it names", () => {
    expect(JSON.parse(agentBlockJSON("reviewer"))).toEqual(agentBlock("reviewer"))
    expect(agentBlock(DEFAULT_AGENT).agents.jobs.permissions).toEqual(AGENT_BLOCK.map((rule) => ({ ...rule })))
  })
})

describe("the effect of a ruleset", () => {
  test("is the last matching rule's, and an ask when no rule names the action", () => {
    expect(evaluate([], "read")).toBe("ask")
    expect(evaluate([deny, { action: "read", resource: "*", effect: "allow" }], "read")).toBe("allow")
    expect(evaluate([{ action: "read", resource: "*", effect: "allow" }, deny], "read")).toBe("deny")
    expect(evaluate([envAsk, { action: "read", resource: "*", effect: "allow" }], "read")).toBe("allow")
  })
})

describe("the guarded-agent rule", () => {
  test("a blanket deny before the allows is guarded", () => {
    expect(isGuarded([allow, ...AGENT_BLOCK])).toBe(true)
  })

  test("an agent that only allows is not guarded, because the base allow still covers what it does not name", () => {
    expect(isGuarded([allow])).toBe(false)
    expect(isGuarded([allow, { action: "read", resource: "*", effect: "allow" }])).toBe(false)
    expect(isGuarded([])).toBe(false)
  })

  test("denying one or two tools by name is not a default deny", () => {
    expect(isGuarded([allow, { action: "shell", resource: "*", effect: "deny" }, { action: "edit", resource: "*", effect: "deny" }])).toBe(false)
  })
})

describe("the refusal a job gets", () => {
  test("names an agent that does not exist, and the block to paste", () => {
    const refusal = refusalFor([], "build")
    expect(refusal?.code).toBe("JOBS_AGENT_UNGUARDED")
    expect(refusal?.what).toBe('There is no agent named "build", so a job cannot run as it.')
    expect(refusal?.nextStep).toContain("/jobs-status")
  })

  test("names an agent that does not deny by default, and the blanket deny it needs", () => {
    const refusal = refusalFor([agent("build", [allow])], "build")
    expect(refusal?.what).toContain('The agent "build" does not deny by default')
    expect(refusal?.nextStep).toContain('{"action":"*","resource":"*","effect":"deny"}')
  })

  test("is read in the directory the run happens in, not the leader's", async () => {
    const seen: unknown[] = []
    const agent = {
      get: async (input: { agentID: string; location?: { directory: string } }) => {
        seen.push(input)
        return { location: { directory: "/work" }, data: { id: input.agentID, name: input.agentID, permissions: [allow, ...AGENT_BLOCK] } }
      },
    } as unknown as Pick<Plugin.Context["agent"], "get">
    await guardAgent(agent, "jobs", "/projects/b")
    expect(seen).toEqual([{ agentID: "jobs", location: { directory: "/projects/b" } }])
    await guardAgent(agent, "jobs")
    expect(seen[1]).toEqual({ agentID: "jobs" })
  })

  test("lets a guarded agent through", () => {
    expect(refusalFor([agent("jobs", [allow, ...AGENT_BLOCK])], "jobs")).toBeUndefined()
  })

  test("is its own refusal when the host cannot answer at all: nothing runs while the agents are unknown", async () => {
    const failing = { get: async () => Promise.reject(new Error("the host is between reloads")) } as unknown as Pick<Plugin.Context["agent"], "get">
    const refusal = await guardAgent(failing, "jobs")
    expect(refusal?.code).toBe("JOBS_AGENTS_UNKNOWN")
    expect(refusal?.nextStep).toStartWith("Restart OpenCode")
    expect(refusal?.what).not.toContain("does not deny by default")
    const missing = { get: async () => Promise.reject(Object.assign(new Error("Agent not found"), { _tag: "Agent.NotFoundError" })) } as unknown as Pick<Plugin.Context["agent"], "get">
    expect((await guardAgent(missing, "jobs"))?.code).toBe("JOBS_AGENT_UNGUARDED")
    const guarded = { get: async () => ({ location: { directory: "/work" }, data: agent("jobs", [allow, ...AGENT_BLOCK]) }) } as unknown as Pick<Plugin.Context["agent"], "get">
    expect(await guardAgent(guarded, "jobs")).toBeUndefined()
  })

  test("lists only the agents the jobs name that are not guarded, once each", () => {
    const agents = [agent("build", [allow]), agent("jobs", [allow, ...AGENT_BLOCK]), agent("reviewer", [allow, { action: "read", resource: "*", effect: "allow" }])]
    expect(unguardedAgents(agents, ["build", "jobs", "reviewer", "build", "gone"])).toEqual(["build", "reviewer", "gone"])
    expect(unguardedAgents(agents, ["jobs"])).toEqual([])
  })
})
