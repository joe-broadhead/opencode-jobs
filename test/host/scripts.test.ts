// The no-model script action in the embedded host: a family-like tools RPC v2, a non-family tool with its own assert,
// the approval, the run session's rules, the record, and every way it fails closed. The mock provider's request count is
// asserted around every run: a script never asks a model.
import { describe, expect, test } from "bun:test"
import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { evaluate, type Rule } from "../../src/host/permissions.js"
import { scanRuns, setPauseAll } from "../../src/jobs/store.js"
import { startHost, until, type Host } from "./harness.js"

import { HOST_VERSION } from "./harness.js"

const familyCalls: { method: string; input: unknown; at: number }[] = []
const memWrites: unknown[] = []

/**
 * A family-like plugin with a tools RPC in the v2 shape: `describe` with classes, resolve-before-dispatch, and one method
 * per tool. It is written directly rather than with the shared module because that module's block is Jobs' own id; the
 * point here is Jobs' client and its run session.
 */
const family = Plugin.define({
  id: "scripts.family",
  async setup(ctx) {
    const methods = [
      { name: "family_read", action: "family_read", class: "read", description: "Read the newest items." },
      { name: "family_write", action: "family_write", class: "write", description: "Write one item." },
      { name: "family_slow", action: "family_slow", class: "read", description: "Read slowly, until the call is aborted." },
    ] as const
    const contract = Rpc.define({
      id: "scripts.family.tools",
      methods: {
        describe: { input: { type: "object" }, output: { type: "object" } },
        ...Object.fromEntries(methods.map((method) => [method.name, { input: { type: "object" }, output: { type: "object" }, errors: { failed: { type: "object" } } }])),
      },
      events: {},
    } as never)
    const session = async (sessionID: string) => {
      const info = await ctx.session.get({ sessionID: sessionID as never })
      const agent = await ctx.agent.get({ agentID: (info.agent ?? "build") as never })
      return { agent: info.agent, rules: [...((agent.data.permissions ?? []) as Rule[]), ...((info.permissions ?? []) as Rule[])] }
    }
    const invoke = async (name: string, raw: unknown, context: { signal: AbortSignal; error: (type: "failed", message: string, data: { code: string; next: string }) => unknown }) => {
      const envelope = (raw ?? {}) as { sessionID?: string; input?: unknown }
      const input = envelope.input as Record<string, unknown> | undefined
      const action = methods.find((method) => method.name === name)!.action
      if (context.signal.aborted) return context.error("failed", "CANCELLED: the call was cancelled.", { code: "CANCELLED", next: "Call again if still needed." })
      const resolved = await session(envelope.sessionID ?? "")
      if (evaluate(resolved.rules, action) !== "allow") {
        return context.error("failed", `PERMISSION_DENIED: ${action} would ask for this session's agent, and a script cannot answer.`, { code: "PERMISSION_DENIED", next: "Add an allow rule." })
      }
      if (name === "family_read") {
        familyCalls.push({ method: "read", input, at: Date.now() })
        return { output: { items: [{ id: "1", text: "first" }, { id: "2", text: "second" }], page: "next" } }
      }
      if (name === "family_write") {
        familyCalls.push({ method: "write", input, at: Date.now() })
        return { output: { wrote: input } }
      }
      familyCalls.push({ method: "slow", input, at: Date.now() })
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Number(input?.ms ?? 4000))
        context.signal.addEventListener("abort", () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
      return { output: { slow: true, aborted: context.signal.aborted } }
    }
    await ctx.rpc.register(contract, {
      describe: async () => ({ id: "scripts.family.tools", location: ctx.location.directory, methods }),
      ...Object.fromEntries(methods.map((method) => [method.name, (raw: unknown, context: never) => invoke(method.name, raw, context as never)])),
    } as never)
    return async () => undefined
  },
})

/** A non-family plugin in opencode-mem's shape: a plugin-owned tool with its own assert and no tools RPC. */
const memlike = Plugin.define({
  id: "scripts.mem",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "mem_remember",
        description: "Store one durable fact.",
        input: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false },
        output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        options: { namespace: "mem", permission: "mem_remember" },
        execute: async (input, context) => {
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            action: "mem_remember",
            resources: ["*"],
            source: { type: "tool", messageID: context.messageID, id: context.id },
          })
          memWrites.push(input)
          return { output: { ok: true } }
        },
      })
    })
    return async () => undefined
  },
})

const AGENT = "script-runner"
const GUARDED_CONFIG = {
  agents: {
    [AGENT]: {
      description: "Runs script jobs",
      mode: "primary",
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "family_read", resource: "*", effect: "allow" },
        { action: "family_slow", resource: "*", effect: "allow" },
        { action: "family_write", resource: "*", effect: "ask" },
        { action: "mem_remember", resource: "*", effect: "ask" },
        { action: "jobs_*", resource: "*", effect: "ask" },
      ],
    },
    "script-locked": {
      description: "Runs script jobs, with one tool denied",
      mode: "primary",
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "family_read", resource: "*", effect: "allow" },
        { action: "family_write", resource: "*", effect: "deny" },
        { action: "jobs_*", resource: "*", effect: "ask" },
      ],
    },
  },
}

const CODE = `
  const page = await tools.scripts.family.family_read({ max_results: 100 });
  let saved = 0;
  for (const item of page.items) {
    await tools.host.mem_mem_remember({ content: item.text });
    saved += 1;
  }
  return { saved, page: page.page };
`

const USES = ["scripts.family.family_read", "host:mem_mem_remember"]

type Tool = { id: string; execute: (input: unknown, call: unknown) => Promise<{ output?: unknown }> }

/** A synthetic tool call, as the model path makes one, for a session in the agent's own voice. */
const toolCall = (sessionID: string, id: string) => ({
  sessionID,
  agent: AGENT,
  messageID: `msg_${id}`,
  id,
  signal: new AbortController().signal,
  progress: async () => undefined,
  source: { type: "tool", messageID: `msg_${id}`, id },
})

async function tool(host: Host, id: string): Promise<Tool> {
  return (await host.probe().tool.list()).find((entry) => entry.id === id) as unknown as Tool
}

/** Answers the next permission prompt a tool call raised, as the person does. */
async function reply(host: Host, sessionID: string, action: string, decision: "once" | "always" | "reject" = "always"): Promise<void> {
  const request = await until(`the ${action} prompt`, async () => {
    const pending = await host.client.permission.list({ sessionID })
    return pending.find((entry) => entry.action === action)
  })
  await host.client.permission.reply({ sessionID, requestID: request.id, decision })
}

async function newHost(options: { loop?: boolean } = {}) {
  return startHost({ ...(options.loop === false ? { loop: false } : {}), config: GUARDED_CONFIG, plugins: [family, memlike] })
}

const jobSpec = (script: { code: string; uses: string[] }, at: number) => ({
  name: "Bookmarks",
  schedule: { at: new Date(at).toISOString() },
  agent: AGENT,
  action: { type: "script", script },
})

/** Creates the job through the tool, answering its two prompts, and returns it. */
async function create(host: Host, sessionID: string, spec: Record<string, unknown>) {
  const create = await tool(host, "jobs_create")
  const pending = create.execute(spec, toolCall(sessionID, "call_create"))
  // One prompt per script act: the digest-bound jobs_script assert (SR-4).
  await reply(host, sessionID, "jobs_script")
  const result = (await pending) as { output?: { job?: { id?: string } } }
  const id = result.output?.job?.id
  if (id === undefined) throw new Error(`jobs_create returned no job: ${JSON.stringify(result)}`)
  return id
}

describe(`the script action in OpenCode ${HOST_VERSION}`, () => {
  test("the walkthrough runs with no model request, grants only the manifest, and records the result without payloads", async () => {
    const host = await newHost({ loop: false })
    try {
      const session = await host.client.session.create({ location: host.location, agent: AGENT })
      // The harness's clock is the system clock unless a manual one is injected; the one-off is due in four seconds.
      const due = Date.now() + 4_000
      const id = await create(host, session.id, jobSpec({ code: CODE, uses: USES }, due))
      // The job is stored with the approval as state, and the approval names the exact digest.
      const state = (await host.worker().storage.get(`state/${id}`)) as { approval?: { digest?: string; resolved?: unknown[] } }
      expect(state.approval?.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(state.approval?.resolved).toHaveLength(2)

      const before = host.mock().calls()
      const worker = host.worker()
      await until("the slot is due", async () => Date.now() >= due)
      await worker.runner.tick(Date.now())
      await worker.runner.settle()
      const record = (await scanRuns(worker.storage, id))[0]!
      expect(record.status).toBe("succeeded")
      expect(host.mock().calls()).toBe(before)
      expect(memWrites).toEqual([{ content: "first" }, { content: "second" }])
      expect(record.result).toEqual({ ok: true, value: { saved: 2, page: "next" } })
      expect(record.calls?.map((call) => [call.method, call.outcome])).toEqual([
        ["scripts.family.family_read", "ok"],
        ["host:mem_mem_remember", "ok"],
        ["host:mem_mem_remember", "ok"],
      ])
      expect(Object.keys(record.calls?.[0] ?? {}).sort()).toEqual(["at", "bytes", "method", "ms", "outcome"])

      // The run session: the agent, a blanket deny, one allow per granted action, then the job-state denies.
      const run = await host.client.session.get({ sessionID: record.sessionID! })
      const rules = (run.permissions ?? []) as { action: string; resource: string; effect: string }[]
      expect(run.agent).toBe(AGENT)
      expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
      for (const action of ["family_read", "mem_remember"]) expect(rules).toContainEqual({ action, resource: "*", effect: "allow" })
      for (const action of ["jobs_create", "jobs_update", "jobs_run_script"]) expect(rules).toContainEqual({ action, resource: "*", effect: "deny" })
    } finally {
      await host.close()
    }
  }, 120_000)

  test("a tool the agent denies refuses the script at create with JOBS_SCRIPT_DENIED, and nothing is stored", async () => {
    const host = await newHost()
    try {
      const session = await host.client.session.create({ location: host.location, agent: "build" })
      const create = await tool(host, "jobs_create")
      const spec = { ...jobSpec({ code: "return 1", uses: ["scripts.family.family_write"] }, Date.now() + 60_000), agent: "script-locked" }
      const pending = create.execute(spec, toolCall(session.id, "call_denied"))
      await expect(pending).rejects.toThrow("JOBS_SCRIPT_DENIED")
      const jobs = (await host.worker().storage.scan({ prefix: "job/" })).entries
      expect(jobs).toEqual([])
    } finally {
      await host.close()
    }
  }, 120_000)

  test("a call outside the manifest is refused before anything runs", async () => {
    const host = await newHost({ loop: false })
    try {
      const session = await host.client.session.create({ location: host.location, agent: AGENT })
      const due = Date.now() + 3_000
      const code = "const r = await tools.scripts.family.family_write({ text: 'not in the manifest' }); return r;"
      const id = await create(host, session.id, jobSpec({ code, uses: ["scripts.family.family_read"] }, due))
      const before = familyCalls.filter((call) => call.method === "write").length
      const worker = host.worker()
      await until("the slot is due", async () => Date.now() >= due)
      await worker.runner.tick(Date.now())
      await worker.runner.settle()
      const record = (await scanRuns(worker.storage, id))[0]!
      expect(record.status).toBe("failed")
      expect(record.result?.ok).toBe(false)
      expect(record.result?.error).toContain("JOBS_SCRIPT_UNKNOWN_TOOL")
      expect(record.calls?.[0]).toMatchObject({ method: "scripts.family.family_write", outcome: "refused" })
      expect(familyCalls.filter((call) => call.method === "write")).toHaveLength(before)
    } finally {
      await host.close()
    }
  }, 120_000)

  test("a changed source is skipped as unapproved until it is approved again", async () => {
    const host = await newHost({ loop: false })
    try {
      const session = await host.client.session.create({ location: host.location, agent: AGENT })
      // A recurring job whose next grid slot is about a second away.
      const anchor = Date.now() - 3_599_000
      const spec = { name: "Bookmarks", schedule: { every: "1 hour", anchor: new Date(anchor).toISOString() }, agent: AGENT, action: { type: "script", script: { code: CODE, uses: USES } } }
      const id = await create(host, session.id, spec)
      // Change the stored definition without approving it: the digest no longer matches.
      const job = (await host.worker().storage.get(`job/${id}`)) as { action: { script: { code: string } } }
      job.action.script.code = "return 'changed'"
      await host.worker().storage.set(`job/${id}`, job as never)
      const worker = host.worker()
      const firstSlot = anchor + 3_600_000
      await until("the slot is due", async () => Date.now() >= firstSlot)
      await worker.runner.tick(Date.now())
      await worker.runner.settle()
      const record = (await scanRuns(worker.storage, id))[0]!
      expect(record.status).toBe("skipped")
      expect(record.reason).toBe("unapproved")
      expect(record.error).toContain("JOBS_SCRIPT_UNAPPROVED")

      // The approve tool asks once and stores the new approval; the next slot runs.
      const approve = await tool(host, "jobs_approve")
      const pending = approve.execute({ id }, toolCall(session.id, "call_approve"))
      await reply(host, session.id, "jobs_script")
      await pending
      // Move the grid to a slot about a second away, so the test does not wait an hour.
      const changed = (await worker.storage.get(`job/${id}`)) as { schedule: { anchorMs: number } }
      changed.schedule.anchorMs = Date.now() - 3_599_000
      await worker.storage.set(`job/${id}`, changed as never)
      const nextSlot = changed.schedule.anchorMs + 3_600_000
      const state = (await worker.storage.get(`state/${id}`)) as Record<string, unknown>
      await worker.storage.set(`state/${id}`, { ...state, nextDueAt: nextSlot } as never)
      await until("the next slot is due", async () => Date.now() >= nextSlot)
      await worker.runner.tick(Date.now())
      await worker.runner.settle()
      const after = (await scanRuns(worker.storage, id)).find((entry) => entry.status === "succeeded")
      expect(after?.result).toEqual({ ok: true, value: "changed" })
    } finally {
      await host.close()
    }
  }, 120_000)

  test("the kill switch interrupts a script mid-call, and the record says so", async () => {
    const host = await newHost({ loop: false })
    try {
      const session = await host.client.session.create({ location: host.location, agent: AGENT })
      const due = Date.now() + 3_000
      const code = "const r = await tools.scripts.family.family_slow({ ms: 60_000 }); return r;"
      const id = await create(host, session.id, jobSpec({ code, uses: ["scripts.family.family_slow"] }, due))
      const worker = host.worker()
      await until("the slot is due", async () => Date.now() >= due)
      const tick = worker.runner.tick(Date.now())
      await tick
      await until("the run is in flight", async () => (await scanRuns(worker.storage, id)).some((entry) => entry.status === "running"))
      const started = Date.now()
      await setPauseAll(worker.storage, true, Date.now())
      // The next pass sees the kill switch and interrupts what is in flight.
      await worker.runner.tick(Date.now())
      await worker.runner.settle()
      await until("the record is interrupted", async () => (await scanRuns(worker.storage, id)).some((entry) => entry.status === "interrupted"), 10_000)
      expect(Date.now() - started).toBeLessThan(5_000)
      // The guarantee is the record plus no further calls: whether an in-process RPC notices the abort is a host
      // detail (SR-7), but the run is over and the guest is disposed, so nothing may be dispatched after the pause.
      const callsAtPause = familyCalls.length
      await Bun.sleep(2_000)
      expect(familyCalls.length).toBe(callsAtPause)
    } finally {
      await host.close()
    }
  }, 120_000)

  test("a script that runs past its call limit is stopped with JOBS_SCRIPT_LIMIT", async () => {
    const host = await newHost({ loop: false })
    try {
      const session = await host.client.session.create({ location: host.location, agent: AGENT })
      const due = Date.now() + 3_000
      const code = "for (let i = 0; i < 5; i += 1) { await tools.scripts.family.family_read({ max_results: 1 }); } return 'done';"
      const spec = jobSpec({ code, uses: ["scripts.family.family_read"] }, due)
      spec.action.script = { ...spec.action.script, limits: { maxCalls: 2 } } as never
      const id = await create(host, session.id, spec)
      const worker = host.worker()
      await until("the slot is due", async () => Date.now() >= due)
      await worker.runner.tick(Date.now())
      await worker.runner.settle()
      const record = (await scanRuns(worker.storage, id))[0]!
      expect(record.status).toBe("failed")
      expect(record.limits?.callLimit).toBe(true)
      expect(record.calls?.filter((call) => call.outcome === "ok")).toHaveLength(2)
    } finally {
      await host.close()
    }
  }, 120_000)

  test("one script act asks exactly once, and never leaves a second prompt waiting", async () => {
    const host = await newHost()
    try {
      const session = await host.client.session.create({ location: host.location, agent: AGENT })
      const create = await tool(host, "jobs_create")
      const pending = create.execute(jobSpec({ code: CODE, uses: USES }, Date.now() + 60_000), toolCall(session.id, "call_once"))
      await reply(host, session.id, "jobs_script")
      await pending
      // No prompt is still waiting: a second assert would be listed here.
      expect(await host.client.permission.list({ sessionID: session.id })).toEqual([])

      const run = await tool(host, "jobs_run_script")
      const oneoff = run.execute({ code: "return 1", uses: ["scripts.family.family_read"], agent: AGENT }, toolCall(session.id, "call_once_2"))
      await reply(host, session.id, "jobs_script")
      await oneoff
      expect(await host.client.permission.list({ sessionID: session.id })).toEqual([])
    } finally {
      await host.close()
    }
  }, 120_000)

  test("host: never admits the host's shell, file or network tools, and asks nothing", async () => {
    const host = await newHost()
    try {
      const session = await host.client.session.create({ location: host.location, agent: AGENT })
      const create = await tool(host, "jobs_create")
      // This host calls its shell tool `shell`; `bash` is the older id, and both are in the core list.
      for (const id of ["shell", "edit", "webfetch"]) {
        const pending = create.execute(jobSpec({ code: "return 1", uses: [`host:${id}`] }, Date.now() + 60_000), toolCall(session.id, `call_${id}`))
        await expect(pending).rejects.toThrow("JOBS_SCRIPT_HOST_TOOL")
        expect(await host.client.permission.list({ sessionID: session.id })).toEqual([])
      }
    } finally {
      await host.close()
    }
  }, 120_000)

  test("jobs_run_script runs once, returns its output, and keeps no job", async () => {
    const host = await newHost()
    try {
      const session = await host.client.session.create({ location: host.location, agent: AGENT })
      const jobsBefore = (await host.worker().storage.scan({ prefix: "job/" })).entries.length
      const run = await tool(host, "jobs_run_script")
      const pending = run.execute({ code: "return { ok: true }", uses: ["scripts.family.family_read"], agent: AGENT }, toolCall(session.id, "call_oneoff"))
      await reply(host, session.id, "jobs_script")
      const result = (await pending) as { output?: { ok?: boolean; value?: unknown; digest?: string } }
      expect(result.output).toMatchObject({ ok: true, value: { ok: true } })
      expect(result.output?.digest).toMatch(/^[0-9a-f]{64}$/)
      expect((await host.worker().storage.scan({ prefix: "job/" })).entries).toHaveLength(jobsBefore)
    } finally {
      await host.close()
    }
  }, 120_000)
})
