import { describe, expect, test } from "bun:test"
import { jobsError } from "../../src/constants.js"
import { KNOWN_READS, NEXT_STEPS, PLUGIN_ID, pluginError, registerToolsRpc, TOOLS_RPC_ID, type ToolsRpcContext } from "../../src/host/tools-rpc.js"
import { rpcRegistry } from "./fake.js"

describe("the jobs block of the tools RPC", () => {
  test("is the plugin's own id, with the tools RPC's id under it", () => {
    expect(PLUGIN_ID).toBe("jobs.scheduler")
    expect(TOOLS_RPC_ID).toBe("jobs.scheduler.tools")
  })

  test("has no MCP reads: jobs has no MCP server, and its read tools arrive as owned methods", () => {
    expect(KNOWN_READS).toEqual([])
  })

  test("gives every code one next step that reads as a sentence and ends with a full stop", () => {
    for (const [code, next] of Object.entries(NEXT_STEPS)) {
      expect({ code, sentence: /^[A-Z].*\.$/.test(next) }).toEqual({ code, sentence: true })
    }
  })

  test("registers describe alone, and disposes it", async () => {
    const { rpc, registered } = rpcRegistry()
    const context = {
      rpc,
      permission: { hook: async () => ({ dispose: async () => undefined }) },
      location: { directory: "/projects/a" },
    } as unknown as ToolsRpcContext
    const stop = await registerToolsRpc(context, { owned: [] })
    expect(registered.map((entry) => entry.definition.id)).toEqual(["jobs.scheduler.tools"])
    expect(Object.keys(registered[0]!.definition.methods)).toEqual(["describe"])
    await stop()
  })
})

describe("the plugin's own errors", () => {
  test("become the script's code, what happened and the next step, with the code and its prefix removed", () => {
    const error = jobsError("JOBS_INVALID_SCHEDULE", "The cron expression is empty.", 'Set "schedule": { "every": "15 minutes" }.')
    expect(pluginError(error)).toEqual({
      code: "JOBS_INVALID_SCHEDULE",
      what: "The cron expression is empty.",
      next: 'Set "schedule": { "every": "15 minutes" }.',
    })
  })

  test("leave anything that is not one of the plugin's own errors alone", () => {
    expect(pluginError(new Error("a host error"))).toBeUndefined()
    expect(pluginError("a string")).toBeUndefined()
    expect(pluginError(Object.assign(new Error("STATUS_UNAVAILABLE: x. Next step: y."), { code: "STATUS_UNAVAILABLE", nextStep: "y." }))).toBeUndefined()
    expect(pluginError(jobsError("JOBS_DISABLED", "Jobs are off.", "Turn them on."))).toMatchObject({ code: "JOBS_DISABLED" })
  })
})
