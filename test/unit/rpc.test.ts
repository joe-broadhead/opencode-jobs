import { describe, expect, test } from "bun:test"
import type { Report } from "../../src/jobs/report.js"
import { Jobs, registerStatusRpc } from "../../src/rpc.js"
import { buildStatus } from "../../src/status.js"
import { rpcContext, rpcRegistry } from "./fake.js"

const HOST = { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }
const facts = { host: HOST, enabled: true, keepAliveMinutes: 20 }

/** A report with one job and one run, so the RPC's three methods have something to answer. */
function report(overrides: Partial<Report> = {}): Report {
  const job = { id: "morning", name: "Morning", source: "file" as const, state: "active" as const, agent: "jobs", action: "prompt" as const }
  const run = { job: "morning", name: "Morning", slot: "2026-12-06T09:00:00.000Z", status: "succeeded" as const, late: false, attempt: 1, summary: "ok" }
  return {
    status: async () => buildStatus(facts),
    compact: async () => ({ state: "ready", jobs: { total: 1, paused: 0, expiring: 0, invalidFiles: 0 }, paused: false, unguardedAgents: 0, nextStep: "Nothing to do." }),
    list: async () => [job],
    history: async () => [run],
    source: async () => ({ files: { jobs: [], invalid: [], refused: [] }, jobs: [], agents: [] }),
    ...overrides,
  }
}

describe("the status RPC", () => {
  test("has the plugin's id and the three read-only methods, each of which can fail as unavailable", () => {
    expect(Jobs.id).toBe("jobs.scheduler")
    expect(Object.keys(Jobs.methods)).toEqual(["status", "list", "history"])
    for (const method of Object.values(Jobs.methods)) {
      expect((method.input as { type: string }).type).toBe("object")
      expect(Object.keys(method.errors)).toEqual(["unavailable"])
    }
    // Nothing here changes a job: pause, run and the writes are the tools' and the commands', not the RPC's.
    expect(Object.keys(Jobs.methods).filter((name) => !["status", "list", "history"].includes(name))).toEqual([])
  })

  test("registers one definition, whose methods answer the model, the jobs and the runs", async () => {
    const { rpc, registered } = rpcRegistry()
    const stop = await registerStatusRpc(rpc, report())
    expect(registered.map((entry) => entry.definition.id)).toEqual(["jobs.scheduler"])
    const handlers = registered[0]!.handlers
    expect(await handlers.status!({}, rpcContext())).toEqual(buildStatus(facts))
    expect(await handlers.list!({}, rpcContext())).toEqual({ jobs: [expect.objectContaining({ id: "morning", state: "active" })] })
    expect(await handlers.history!({ id: "morning", limit: 5 }, rpcContext())).toEqual({ runs: [expect.objectContaining({ name: "Morning", status: "succeeded" })] })
    expect(typeof stop).toBe("function")
    await stop()
  })

  test("answers unavailable, with a next step, when the status cannot be read", async () => {
    const { rpc, registered } = rpcRegistry()
    await registerStatusRpc(
      rpc,
      report({
        status: async () => {
          throw new Error("the store is unreadable")
        },
      }),
    )
    const failure = (await registered[0]!.handlers.status!({}, rpcContext())) as { type: string; message: string; data: { nextStep: string } }
    expect(failure.type).toBe("unavailable")
    expect(failure.message).toStartWith("STATUS_UNAVAILABLE: Could not read the job status")
    expect(failure.data.nextStep).toBe("Restart OpenCode, then run /jobs-status again.")
  })

  test("passes a history filter through to the report", async () => {
    const seen: unknown[] = []
    const { rpc, registered } = rpcRegistry()
    await registerStatusRpc(rpc, report({ history: async (filter) => (seen.push(filter), []) }))
    await registered[0]!.handlers.history!({ id: "morning", limit: 3, since: "2026-12-01T00:00:00Z" }, rpcContext())
    expect(seen).toEqual([{ id: "morning", limit: 3, since: "2026-12-01T00:00:00Z" }])
  })
})
