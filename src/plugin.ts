import { Plugin } from "@opencode/plugin"
import { PLUGIN_ID } from "./constants.js"
import { checkHost } from "./host-version.js"
import { registerToolsRpc } from "./host/tools-rpc.js"
import { parseOptions } from "./options.js"
import { registerStatusRpc } from "./rpc.js"
import { buildStatus, registerStatusCommand } from "./status.js"

/**
 * Registers the status surfaces and both RPCs. The runner arrives with the store: until then every surface answers
 * truthfully, with no jobs and no runs.
 */
export function createJobsPlugin() {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = parseOptions(ctx.options)
      const host = checkHost(ctx.app.version, options.allowUntestedHost)
      const read = async () => buildStatus({ host, enabled: options.enabled })
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
