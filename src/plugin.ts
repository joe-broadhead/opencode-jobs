import { Plugin } from "@opencode/plugin"
import { PLUGIN_ID, errorText } from "./constants.js"
import { checkHost } from "./host-version.js"
import { registerToolsRpc } from "./host/tools-rpc.js"
import { readJobFiles } from "./jobs/files.js"
import { serverTimezone } from "./jobs/model.js"
import { migrate } from "./jobs/store.js"
import { parseOptions } from "./options.js"
import { registerStatusRpc } from "./rpc.js"
import { buildStatus, registerStatusCommand, type JobsCount } from "./status.js"

interface Facts {
  readonly jobs: JobsCount
  readonly problems: readonly string[]
}

/**
 * Registers the status surfaces and both RPCs, and reads what there is to report: the store's schema, and the job files
 * of this location and the global folder. No session, timer or run starts here: the runner arrives with the leader.
 */
export function createJobsPlugin() {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = parseOptions(ctx.options)
      const host = checkHost(ctx.app.version, options.allowUntestedHost)
      const facts = await load(ctx, options.timezone ?? serverTimezone())
      const read = async () => buildStatus({ host, enabled: options.enabled, jobs: facts.jobs, problems: facts.problems })
      // Transforms replay on every rebuild, so each registration is disposed on cleanup in reverse order.
      const stops = [
        await registerStatusCommand(ctx, read),
        await registerStatusRpc(ctx.rpc, read),
        // Scripts call the known reads with no model, as a session and its agent.
        await registerToolsRpc(ctx, { owned: [] }),
      ]
      return async () => {
        for (const stop of stops.reverse()) await stop()
      }
    },
  })
}

/** The store's schema is brought up to date once per setup; a file that cannot be read is a status problem, not a throw. */
async function load(ctx: Pick<Plugin.Context, "storage" | "location">, timezone: string): Promise<Facts> {
  const problems: string[] = []
  try {
    await migrate(ctx.storage)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }
  const files = await readJobFiles({ now: Date.now(), timezone, projects: [ctx.location.directory] }).catch((error: unknown) => ({
    jobs: [],
    invalid: [{ path: ctx.location.directory, message: errorText("JOBS_INVALID_FILE", `The job files could not be read (${reasonOf(error)}).`, `Check that the job folders are readable, then restart OpenCode.`) }],
  }))
  return {
    // Nothing can pause or create a job until the tools and the runner land, so only the file counts are known now.
    jobs: { total: files.jobs.length, paused: 0, expiring: 0, invalidFiles: files.invalid.length },
    problems: [...problems, ...files.invalid.map((file) => file.message)],
  }
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
