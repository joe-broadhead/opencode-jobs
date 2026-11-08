// The bridge re-reads the agent's rules on every call, so a deny added during a run stops the next call (SR-14), and the
// host route resolves the run session's grant before dispatching.
import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { createBridge } from "../../src/jobs/script-bridge.js"
import type { ResolvedTool } from "../../src/jobs/script.js"

const hostTool: ResolvedTool = { method: "host:mem", action: "mem", class: "unclassified", kind: "host", effect: "allow" }
const familyTool: ResolvedTool = { method: "x.posts.read", action: "x_read", class: "read", kind: "family", effect: "allow" }

function setup(method: ResolvedTool) {
  const executed: unknown[] = []
  const rpcCalls: unknown[] = []
  let agentRules: { action: string; resource: string; effect: "allow" | "deny" }[] = [{ action: "*", resource: "*", effect: "allow" }]
  const agent = {
    get: async () => ({ data: { id: "build", name: "build", permissions: agentRules } }),
  } as never
  const session = {
    get: async () => ({ id: "ses_run", agent: "build", permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: method.action, resource: "*", effect: "allow" }] }),
  } as never
  const tool = {
    list: async () => [{ id: "mem", name: "mem", options: { permission: "mem" }, execute: async (input: unknown) => (executed.push(input), { output: { ok: true } }) }],
  } as never
  const rpc = ((definition: { id?: string }) => ({
    read: async () => (rpcCalls.push(definition.id), { output: { ok: true } }),
  })) as unknown as Plugin.Context["rpc"]
  const bridge = createBridge({ rpc, tool, session, agent, sessionID: "ses_run", agentID: "build", manifest: [method] })
  return { bridge, executed, rpcCalls, deny: () => (agentRules = [{ action: "*", resource: "*", effect: "allow" }, { action: method.action, resource: "*", effect: "deny" }]) }
}

describe("the script bridge", () => {
  test("a deny added mid-run refuses the next host call, with nothing dispatched", async () => {
    const setup1 = setup(hostTool)
    await setup1.bridge("host:mem", { content: "first" }, new AbortController().signal)
    expect(setup1.executed).toEqual([{ content: "first" }])
    setup1.deny()
    await expect(setup1.bridge("host:mem", { content: "second" }, new AbortController().signal)).rejects.toThrow("JOBS_SCRIPT_REVOKED")
    expect(setup1.executed).toEqual([{ content: "first" }])
  })

  test("a deny added mid-run refuses the next family call before the RPC", async () => {
    const setup1 = setup(familyTool)
    await setup1.bridge("x.posts.read", {}, new AbortController().signal)
    expect(setup1.rpcCalls).toEqual(["x.posts.tools"])
    setup1.deny()
    await expect(setup1.bridge("x.posts.read", {}, new AbortController().signal)).rejects.toThrow("JOBS_SCRIPT_REVOKED")
    expect(setup1.rpcCalls).toHaveLength(1)
  })

  test("a dotted attempt at a hyphenated plugin id names the bracket accessor (GAP-18)", async () => {
    const hyphenated: ResolvedTool = { method: "google-workspace.gws.read", action: "gws_read", class: "read", kind: "family", effect: "allow" }
    const setup1 = setup(hyphenated)
    await expect(setup1.bridge("google.workspace.gws.read", {}, new AbortController().signal)).rejects.toThrow(
      'tools["google-workspace"].gws.read',
    )
    await expect(setup1.bridge("google.workspace.gws.read", {}, new AbortController().signal)).rejects.toThrow("JOBS_SCRIPT_UNKNOWN_TOOL")
  })
})
