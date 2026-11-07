// A script job's approval at create and its run: the store, the run session's rules, the record and the ways it fails
// closed. The runtime and the bridge are exercised for real; only the host's session, tools and RPC are fakes.
import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { approveJob, changeJob, createJob, type ActionInput } from "../../src/jobs/actions.js"
import { execute } from "../../src/jobs/execute.js"
import { parseJob, type Job } from "../../src/jobs/model.js"
import { digestOf, manifestDigest, sourceHash, type ResolvedTool, type Script, type ScriptApproval } from "../../src/jobs/script.js"
import type { ScriptGate } from "../../src/jobs/script-gate.js"
import { SELF_DENIES } from "../../src/jobs/safety.js"
import { getRun, putState, readState } from "../../src/jobs/store.js"
import { memoryStorage, sessionFake, testClock } from "./fake.js"

const START = Date.UTC(2026, 11, 6, 9, 0, 0)
const RULES = [{ action: "*", resource: "*", effect: "allow" as const }]
const SCRIPT: Script = { code: 'const r = await tools.host.mem({ content: "x" }); return r', uses: ["host:mem"] }
const RESOLVED: readonly ResolvedTool[] = [{ method: "host:mem", action: "mem", class: "unclassified", kind: "host", effect: "allow" }]

const approvalOf = (script: Script, resolved: readonly ResolvedTool[] = RESOLVED): ScriptApproval => ({
  sourceHash: sourceHash(script.code),
  manifestDigest: manifestDigest(script.uses),
  digest: digestOf(script),
  at: START,
  resolved,
})

function gate(resolved: readonly ResolvedTool[] = RESOLVED, approval: ScriptApproval = approvalOf(SCRIPT)): ScriptGate & { approved: unknown[] } {
  const approved: unknown[] = []
  return {
    approved,
    resolve: async () => resolved,
    approve: async (input) => {
      approved.push(input)
      return { ...approval, resolved: input.resolved }
    },
  }
}

function actions(scripts: ScriptGate, storage = memoryStorage()) {
  const clock = testClock(START, { instantBelow: 0 })
  void storage
  const input: ActionInput = {
    storage: storage.storage,
    agent: { get: async () => ({ data: { id: "build", name: "build", permissions: RULES } }) } as never,
    clock: clock.clock,
    timezone: "UTC",
    location: "/work",
    source: async () => ({ jobs: [], files: { jobs: [], invalid: [], refused: [] }, agents: [], known: true }),
    wake: () => undefined,
    ready: true,
    scripts,
  }
  return { input, storage, clock }
}

const jobOf = (script: Script = SCRIPT, agent = "build"): Job =>
  parseJob({ name: "Memory", schedule: { every: "1h" }, action: { type: "script", script }, agent }, { now: START, timezone: "UTC", id: "memory", source: "tool", createdBy: "agent" })

const call = { sessionID: "ses_person", agent: "build", messageID: "msg_1", id: "call_1" }

describe("creating a script job", () => {
  test("asks once, bound to the source and the manifest, and stores the approval as state", async () => {
    const scripts = gate()
    const { input, storage } = actions(scripts)
    const job = await createJob(input, { name: "Memory", schedule: { every: "1h" }, action: { type: "script", script: SCRIPT } }, call)
    expect(job.agent).toBe("build")
    expect((await readState(storage.storage, job.id)).approval).toMatchObject({ digest: digestOf(SCRIPT) })
    expect(scripts.approved).toHaveLength(1)
    const asked = scripts.approved[0] as { source?: unknown; agent: string }
    expect(asked.agent).toBe("build")
    expect(asked.source).toEqual({ messageID: "msg_1", id: "call_1" })
  })

  test("refuses a tool the agent denies with JOBS_SCRIPT_DENIED, and stores nothing", async () => {
    const deniedTool: ResolvedTool = { ...RESOLVED[0]!, effect: "deny" }
    const { input, storage } = actions(gate([deniedTool]))
    await expect(createJob(input, { name: "Memory", schedule: { every: "1h" }, action: { type: "script", script: SCRIPT } }, call)).rejects.toThrow("JOBS_SCRIPT_DENIED")
    expect(await storage.storage.scan({ prefix: "job/" })).toMatchObject({ entries: [] })
  })

  test("keeps an existing approval when an update leaves the script and its tools unchanged, and asks when it changes", async () => {
    const scripts = gate()
    const { input } = actions(scripts)
    const job = await createJob(input, { name: "Memory", schedule: { every: "1h" }, action: { type: "script", script: SCRIPT } }, call)
    // The source's own read has to include the stored job for findJob.
    const source = async () => ({ jobs: [job], files: { jobs: [], invalid: [], refused: [] }, agents: [], known: true })
    const withSource = { ...input, source }
    await changeJob(withSource, job.id, { name: "Memory 2" }, call)
    expect(scripts.approved).toHaveLength(1)
    await changeJob(withSource, job.id, { action: { type: "script", script: { ...SCRIPT, code: "return 2" } } }, call)
    expect(scripts.approved).toHaveLength(2)
  })
})

describe("running a script job", () => {
  function setup(options: { resolved?: readonly ResolvedTool[]; approval?: ScriptApproval | null; script?: Script; agentRules?: readonly { action: string; resource: string; effect: "allow" | "deny" | "ask" }[] } = {}) {
    const storage = memoryStorage()
    const session = sessionFake()
    const script = options.script ?? SCRIPT
    const job = jobOf(script)
    const executed: unknown[] = []
    const tool = {
      id: "mem",
      name: "mem",
      description: "Store one fact.",
      options: { permission: "mem" },
      execute: async (value: unknown) => {
        executed.push(value)
        return { output: { remembered: value } }
      },
    }
    const agents = { get: async () => ({ data: { id: "build", name: "build", permissions: options.agentRules ?? RULES } }) } as never
    const resolved = options.resolved ?? RESOLVED
    const scripts = gate(resolved, options.approval ?? approvalOf(script, resolved))
    const rpc = (() => ({})) as unknown as Plugin.Context["rpc"]
    return {
      storage,
      session,
      job,
      executed,
      run: async (slot = START) => {
        const approval = options.approval === undefined ? approvalOf(script, resolved) : options.approval
        await putState(storage.storage, { job: job.id, runCount: 0, consecutiveFailures: 0, nextDueAt: slot, ...(approval === null ? {} : { approval: approval as ScriptApproval }) } as never)
        return execute({
          storage: storage.storage,
          session: session.session,
          agents,
          clock: testClock(slot, { instantBelow: 100 }).clock,
          location: "/work",
          token: "leader-1",
          job,
          slot,
          attempt: 1,
          late: false,
          active: () => true,
          scripts,
          tool: { list: async () => [tool] } as never,
          rpc,
        } as never)
      },
    }
  }

  test("runs with no model turn, grants only the manifest, and records the result with no payloads in the calls", async () => {
    const setup1 = setup()
    const result = await setup1.run()
    expect(result.status).toBe("succeeded")
    // No model turn: the run session is never prompted (the mock provider is not even present here).
    expect(setup1.session.prompts).toEqual([])
    expect(setup1.session.commands).toEqual([])
    expect(setup1.executed).toEqual([{ content: "x" }])
    // The run session: a blanket deny, one allow for the granted action, then the job-state denies.
    const created = setup1.session.created.at(-1) as { agent: string; permissions: readonly { action: string; resource: string; effect: string }[] }
    expect(created.agent).toBe("build")
    expect(created.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    expect(created.permissions).toContainEqual({ action: "mem", resource: "*", effect: "allow" })
    for (const deny of SELF_DENIES) expect(created.permissions).toContainEqual(deny)
    // The record: the hashes, the result and one call with method/outcome/duration/bytes only.
    const record = (await getRun(setup1.storage.storage, "memory", new Date(START).toISOString()))!
    expect(record).toMatchObject({ status: "succeeded", sessionOwned: true, script: { sourceHash: sourceHash(SCRIPT.code), manifestDigest: manifestDigest(SCRIPT.uses), uses: ["host:mem"] } })
    expect(record.result).toEqual({ ok: true, value: { remembered: { content: "x" } } })
    expect(record.calls).toHaveLength(1)
    expect(Object.keys(record.calls![0]!).sort()).toEqual(["at", "bytes", "method", "ms", "outcome"])
    expect(record.calls![0]).toMatchObject({ method: "host:mem", outcome: "ok" })
  })

  test("skips a slot when the approval is missing, stale or a tool is now denied", async () => {
    const missing = setup({ approval: null })
    expect((await missing.run()).status).toBe("skipped")
    expect((await getRun(missing.storage.storage, "memory", new Date(START).toISOString()))?.reason).toBe("unapproved")
    expect(missing.session.created).toHaveLength(0)

    const stale = setup({ approval: { ...approvalOf(SCRIPT), sourceHash: "0".repeat(64) } })
    expect((await stale.run()).status).toBe("skipped")
    expect(stale.session.created).toHaveLength(0)

    // The approval was given when the tool was allowed; the agent now denies it. The hashes still match, so the run
    // reaches the denied() check and reports revoked (D1).
    const revoked = setup({ resolved: [{ ...RESOLVED[0]!, effect: "deny" }] })
    const record = (await revoked.run()).record!
    expect(record.reason).toBe("revoked")
    expect(record.error).toContain("JOBS_SCRIPT_REVOKED")
    expect(revoked.session.created).toHaveLength(0)

    // Restoring the rule resumes with the original approval: no re-approval.
    const restored = setup()
    const again = await restored.run(START + 60_000)
    expect(again.status).toBe("succeeded")
    expect(restored.executed).toHaveLength(1)
  })

  test("a changed classification needs re-approval even when the hashes still match", async () => {
    const changed = setup({ resolved: [{ ...RESOLVED[0]!, class: "write" }], approval: approvalOf(SCRIPT) })
    const result = await changed.run()
    expect(result.status).toBe("skipped")
    expect((result.record as { reason?: string }).reason).toBe("unapproved")
    expect(changed.session.created).toHaveLength(0)
  })
})

describe("approving a script job again", () => {
  test("stores the new approval in the job's state", async () => {
    const scripts = gate()
    const storage = memoryStorage()
    const { input } = actions(scripts, storage)
    const job = jobOf()
    const withSource = { ...input, source: async () => ({ jobs: [job], files: { jobs: [], invalid: [], refused: [] }, agents: [], known: true }) }
    const { approval } = await approveJob(withSource, job.id, call)
    expect(approval.digest).toBe(digestOf(SCRIPT))
    expect((await readState(storage.storage, job.id)).approval).toMatchObject({ digest: approval.digest })
  })
})
