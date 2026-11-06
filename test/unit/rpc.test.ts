import { describe, expect, test } from "bun:test"
import { Jobs, registerStatusRpc } from "../../src/rpc.js"
import { buildStatus } from "../../src/status.js"
import { rpcContext, rpcRegistry } from "./fake.js"

const HOST = { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }
const read = async () => buildStatus({ host: HOST, enabled: true })

describe("the status RPC", () => {
  test("has the plugin's id and the three read-only methods, each of which can fail as unavailable", () => {
    expect(Jobs.id).toBe("jobs.scheduler")
    expect(Object.keys(Jobs.methods)).toEqual(["status", "list", "history"])
    for (const method of Object.values(Jobs.methods)) {
      expect((method.input as { type: string }).type).toBe("object")
      expect(Object.keys(method.errors)).toEqual(["unavailable"])
    }
  })

  test("registers one definition, whose methods answer the status model and the empty lists", async () => {
    const { rpc, registered } = rpcRegistry()
    const stop = await registerStatusRpc(rpc, read)
    expect(registered.map((entry) => entry.definition.id)).toEqual(["jobs.scheduler"])
    const handlers = registered[0]!.handlers
    expect(await handlers.status!({}, rpcContext())).toEqual(buildStatus({ host: HOST, enabled: true }))
    expect(await handlers.list!({}, rpcContext())).toEqual({ jobs: [] })
    expect(await handlers.history!({}, rpcContext())).toEqual({ runs: [] })
    // The cleanup disposes the registration, so a reload never leaves two behind.
    expect(typeof stop).toBe("function")
    await stop()
  })

  test("answers unavailable, with a next step, when the status cannot be read", async () => {
    const { rpc, registered } = rpcRegistry()
    await registerStatusRpc(rpc, async () => {
      throw new Error("the store is unreadable")
    })
    const failure = (await registered[0]!.handlers.status!({}, rpcContext())) as { type: string; message: string; data: { nextStep: string } }
    expect(failure.type).toBe("unavailable")
    expect(failure.message).toStartWith("STATUS_UNAVAILABLE: Could not read the job status")
    expect(failure.data.nextStep).toBe("Restart OpenCode, then run /jobs-status again.")
  })
})
