// The phase-5 surfaces inside an embedded OpenCode host: the twelve tools, the default rules every agent gets, a write
// that asks while a read does not, the commands, and the tools RPC's describe listing exactly the four reads.
import { afterAll, describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@opencode/client"
import type { Clock } from "../../src/jobs/clock.js"
import { MINUTE, parseJob } from "../../src/jobs/model.js"
import { getRun, readState } from "../../src/jobs/store.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { cleanup, HOST_VERSION, startHost, until, type Host } from "./harness.js"

const START = Date.UTC(2026, 11, 6, 9, 0, 0)

afterAll(cleanup)

const GUARDED = {
  jobs: {
    description: "Runs scheduled jobs with read-only access",
    mode: "primary",
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "list", resource: "*", effect: "allow" },
    ],
  },
}

const TOOLS = [
  "jobs_status",
  "jobs_list",
  "jobs_get",
  "jobs_history",
  "jobs_pause",
  "jobs_pause_all",
  "jobs_create",
  "jobs_update",
  "jobs_delete",
  "jobs_run_now",
  "jobs_resume",
  "jobs_extend",
]

function manualClock(start: number) {
  let now = start
  const clock: Clock = {
    now: () => now,
    sleep: (ms, signal) =>
      ms <= 100
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            if (signal?.aborted === true) resolve()
            else signal?.addEventListener("abort", () => resolve(), { once: true })
          }),
  }
  return { clock, set: (at: number) => void (now = at) }
}

/** A session that names an agent, for a model call the test inspects. */
async function session(host: Host, agent: string): Promise<string> {
  const created = await host.client.session.create({ location: { directory: host.location.directory }, agent })
  return created.id
}

/** The text of the synthetic notices a command posted: they wait in the session's inbox until it is read. */
const notices = async (host: Host, sessionID: string): Promise<string> => {
  const inbox = await host.client.session.inbox.list({ sessionID })
  return inbox.flatMap((item) => (item.type === "synthetic" ? [String((item.payload as { text?: unknown }).text ?? "")] : [])).join("\n")
}

/** A Code Mode program's answer, which is how this host offers a plugin's tools to a model. */
const code = (host: Host, sessionID: string, program: string) => host.client.session.prompt({ sessionID, text: `[[mock:tool:execute:${JSON.stringify({ code: program })}]]` })

describe(`the surfaces in OpenCode ${HOST_VERSION}`, () => {
  test("registers the twelve tools, and gives every agent the default rules after its base allow", async () => {
    const host = await startHost({ loop: false, config: { agents: GUARDED } })
    try {
      const tools = await host.probe().tool.list()
      const ids = tools.map((tool) => tool.id).filter((id) => id.startsWith("jobs_"))
      expect(ids.sort()).toEqual([...TOOLS].sort())

      const build = await host.probe().agent.get({ agentID: "build" })
      const rules = build.data.permissions as { action: string; resource: string; effect: string }[]
      const base = rules.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")
      expect(base).toBe(0)
      expect(rules.slice(base + 1, base + 8)).toEqual([
        { action: "jobs_*", resource: "*", effect: "ask" },
        { action: "jobs_status", resource: "*", effect: "allow" },
        { action: "jobs_list", resource: "*", effect: "allow" },
        { action: "jobs_get", resource: "*", effect: "allow" },
        { action: "jobs_history", resource: "*", effect: "allow" },
        { action: "jobs_pause", resource: "*", effect: "allow" },
        { action: "jobs_pause_all", resource: "*", effect: "allow" },
      ])
      // The rules are inserted once: a reload does not stack a second block.
      await host.client.location.reload()
      await until("the plugin reloads", async () => host.setups() > 1)
      const again = (await host.probe().agent.get({ agentID: "build" })).data.permissions as { action: string }[]
      expect(again.filter((rule) => rule.action === "jobs_*")).toHaveLength(1)

      // The tools RPC's describe lists the four reads and nothing that changes anything.
      const described = (await host.client
        .rpc({ id: TOOLS_RPC_ID, methods: { describe: { input: { type: "object" }, output: { type: "object" } } }, events: {} })
        .describe({}, { location: host.location })) as { methods: { name: string; kind: string; action: string; input: object }[] }
      expect(described.methods.map((method) => method.name)).toEqual(["jobs_status", "jobs_list", "jobs_get", "jobs_history"])
      expect(described.methods.every((method) => method.kind === "plugin")).toBe(true)
      expect(described.methods.map((method) => method.action)).toEqual(["jobs_status", "jobs_list", "jobs_get", "jobs_history"])
    } finally {
      await host.close()
    }
  }, 120_000)

  test("a read runs without asking, and a write asks for approval", async () => {
    const host = await startHost({ loop: false, config: { agents: GUARDED } })
    try {
      const read = await session(host, "build")
      await code(host, read, "const r = await tools.jobs.status({}); return JSON.stringify(r)")
      const answered = await until("the read tool answers", async () => {
        const context = (await host.probe().session.context({ sessionID: read })) as { content?: { text?: string }[] }[]
        const text = context.flatMap((message) => message.content ?? []).map((part) => part.text ?? "").join("\n")
        return text.includes("after-tool:") ? text : undefined
      }, 30_000)
      // The compact status, as JSON: state, counts, the pause, the count of agents to fix, and the next step.
      expect(answered).toContain('"state":"ready"')
      expect(answered).toContain('"nextStep":"Nothing to do."')
      expect(await host.probe().permission.list({ sessionID: read })).toEqual([])

      const write = await session(host, "build")
      await code(host, write, 'const r = await tools.jobs.create({ name: "Nightly", schedule: { every: "1h" }, action: { type: "prompt", text: "x" }, agent: "jobs" }); return JSON.stringify(r)')
      const request = await until("the write asks", async () => {
        const list = (await host.probe().permission.list({ sessionID: write })) as PermissionRequest[]
        return list.find((entry) => entry.action === "jobs_create")
      }, 30_000)
      expect(request.action).toBe("jobs_create")
      // Declined: nothing was created.
      await host.probe().permission.reply({ sessionID: write, requestID: request.id, decision: "reject", message: "not now" })
      await until("the turn ends", async () => (await host.probe().session.get({ sessionID: write })).outcome !== undefined, 30_000)
      expect((await sessionList(host)).filter((name) => name === "Nightly")).toEqual([])
    } finally {
      await host.close()
    }
  }, 120_000)

  test("/jobs-status and /jobs-run act in the session the person typed them in", async () => {
    const manual = manualClock(START)
    const host = await startHost({ clock: manual.clock, loop: false, config: { agents: GUARDED } })
    try {
      const worker = host.worker()
      const id = await session(host, "build")
      await host.client.session.command({ sessionID: id, name: "jobs-status", text: "" })
      const status = await until("the status is posted", async () => {
        const text = await notices(host, id)
        return text.includes("Jobs status") ? text : undefined
      }, 30_000)
      expect(status).toContain("- Runner:")
      expect(status).toContain("- Next step: Nothing to do.")

      const job = parseJob(
        { name: "On demand", schedule: { every: "1h" }, action: { type: "prompt", text: "Say ok." }, agent: "jobs", policy: { timeout: "1m" } },
        { now: START, timezone: "UTC", id: "job_on_demand", source: "tool", createdBy: "user" },
      )
      await worker.storage.set(`job/${job.id}`, job as never)
      await worker.storage.set(`state/${job.id}`, { job: job.id, nextDueAt: START + 60 * MINUTE, runCount: 0, consecutiveFailures: 0 })
      await host.client.session.command({ sessionID: id, name: "jobs-run", text: job.id })
      await until("the run is queued", async () => (await readState(worker.storage, job.id)).nextDueAt === manual.clock.now(), 30_000)
      await worker.runner.tick(manual.clock.now())
      await worker.runner.settle()
      expect(await getRun(worker.storage, job.id, new Date(manual.clock.now()).toISOString())).toMatchObject({ status: "succeeded" })
    } finally {
      await host.close()
    }
  }, 120_000)
})

/** The names of the jobs the store holds, for a negative assertion. */
async function sessionList(host: Host): Promise<string[]> {
  const jobs = (await host.worker().storage.scan({ prefix: "job/" })).entries
  return jobs.map((entry) => (entry.value as { name?: string }).name ?? "")
}
