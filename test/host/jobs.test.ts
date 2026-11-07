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
      ])
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
