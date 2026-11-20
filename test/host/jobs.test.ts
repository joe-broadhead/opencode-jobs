// The empty plugin inside an embedded OpenCode host of one tested release: it loads, registers its command and both
// RPCs, and every surface reports truthfully that there are no jobs and no runs.
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { SUPPORTED_HOST } from "../../src/constants.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { Jobs } from "../../src/rpc.js"
import { formatStatus, NOTHING_TO_DO, type Status } from "../../src/status.js"
import { cleanup, HOST_VERSION, startHost, until } from "./harness.js"

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string }
const NO_JOBS = { total: 0, paused: 0, expiring: 0, invalidFiles: 0 }

afterAll(cleanup)

describe(`in OpenCode ${HOST_VERSION}`, () => {
  test("the plugin loads and answers its status, its command and both RPCs with no jobs yet", async () => {
    const host = await startHost()
    try {
      const status = (await host.client.rpc(Jobs).status({}, { location: host.location })) as Status
      expect(status).toMatchObject({
        version: pkg.version,
        state: "ready",
        host: { version: HOST_VERSION, range: SUPPORTED_HOST, tested: true },
        jobs: NO_JOBS,
        unguardedAgents: [],
        problems: [],
        nextStep: NOTHING_TO_DO,
      })
      const text = formatStatus(status)
      expect(text.split("\n")[0]).toBe("Jobs status")
      expect(text).toContain(`- Runner: leader in ${host.location.directory} (pid `)
      expect(text).toContain("- Jobs: none yet")
      expect(text).toContain(`- OpenCode: ${HOST_VERSION} (tested; supported range ${SUPPORTED_HOST})`)

      // `/jobs-status` is registered, and posts the same report into the session it is run in.
      const command = await until("the jobs-status command is registered", async () => {
        const { data } = await host.client.command.list({ location: host.location })
        return data.find((item) => item.name === "jobs-status")
      })
      expect(command.description).toBeString()

      expect(await host.client.rpc(Jobs).list({}, { location: host.location })).toEqual({ jobs: [] })
      expect(await host.client.rpc(Jobs).history({}, { location: host.location })).toEqual({ runs: [] })

      // The tools RPC is registered under the plugin's id, and lists every tool as a method.
      const described = (await host.client
        .rpc({ id: TOOLS_RPC_ID, methods: { describe: { input: { type: "object" }, output: { type: "object" } } }, events: {} })
        .describe({}, { location: host.location })) as { id: string; methods: { name: string }[] }
      expect(described.id).toBe(TOOLS_RPC_ID)
      expect(described.methods.map((method) => method.name)).toEqual([
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
        "jobs_approve",
        "jobs_run_script",
        "events_list",
        "probe",
      ])

      // The jobs.runs source, as a consumer reads it through the tools RPC: whose runs they are, and a page of none yet.
      const sessionID = (await host.client.session.create({ location: { directory: host.location.directory }, agent: "build" })).id
      const envelope = { input: { type: "object" }, output: { type: "object" } }
      const source = host.client.rpc({ id: TOOLS_RPC_ID, methods: { events_list: envelope, probe: envelope }, events: {} }) as unknown as Record<
        "events_list" | "probe",
        (input: unknown, options: unknown) => Promise<Record<string, unknown>>
      >
      const probed = await source.probe({ sessionID, input: { source: "runs" } }, { location: host.location })
      expect(probed).toMatchObject({ source: "runs", owner: { id: expect.stringMatching(/^os-user:/), label: expect.any(String) }, trust: "untrusted" })
      const page = await source.events_list({ sessionID, input: { source: "runs", account: probed["account"] } }, { location: host.location })
      expect(page).toMatchObject({ source: "runs", account: probed["account"], owner: probed["owner"], events: [], more: false, trust: "untrusted" })
      expect(page["cursor"]).toBeString()

      // jobs.runs.list rides the `jobs_history` method. The host validates a tools-RPC method's answer against the
      // method's declared output, so this is the read that proves a list answer is accepted on this release.
      const history = host.client.rpc({ id: TOOLS_RPC_ID, methods: { jobs_history: envelope }, events: {} }) as unknown as {
        jobs_history: (input: unknown, options: unknown) => Promise<Record<string, unknown>>
      }
      // Seed two finished runs in the plugin's own storage, so the list validates real items on every host.
      const storage = host.worker().storage
      for (const [slot, name, status] of [["2026-11-20T09:00:00Z", "Nightly", "succeeded"], ["2026-11-20T10:00:00Z", "Weekly", "failed"]] as const) {
        await storage.set(`run/job_${name}/${slot}`, { job: `job_${name}`, slot, status, late: false, attempt: 1, summary: "run output, never in the list" } as never)
      }
      const listed = (await history.jobs_history({ sessionID, input: { list: "runs", account: probed["account"] } }, { location: host.location })) as {
        account: string
        data: { items: { id: string; text: string }[]; editable: boolean }
        asOf: string
        trust: string
      }
      const items = listed.data.items
      // Seeded runs are listed (not an empty answer), and never a run's summary.
      expect(Array.isArray(items)).toBe(true)
      expect(items.length).toBeGreaterThan(0)
      expect(JSON.stringify(items)).not.toContain("run output")
      expect(listed.account).toBe(String(probed["account"]))
      expect(listed.data.editable).toBe(false)
      expect(listed.trust).toBe("untrusted")
      expect(Number.isNaN(Date.parse(String(listed["asOf"])))).toBe(false)
      // The run history the model's tool answers is unchanged: the seeded runs, with their summaries.
      const model = (await history.jobs_history({ sessionID, input: {} }, { location: host.location })) as { runs: unknown[] }
      expect(Object.keys(model)).toEqual(["runs"])
      expect(model.runs).toHaveLength(2)
    } finally {
      await host.close()
    }
  }, 120_000)

  test("says the plugin is disabled when its option is false, and the read surfaces still answer", async () => {
    const host = await startHost({ options: { enabled: false } })
    try {
      const status = (await host.client.rpc(Jobs).status({}, { location: host.location })) as Status
      expect(status.state).toBe("disabled")
      expect(status.nextStep).toBe('Set the plugin option "enabled" to true, or remove it, then restart OpenCode.')
      expect(formatStatus(status)).toContain("- Jobs: none yet")
    } finally {
      await host.close()
    }
  }, 120_000)
})
