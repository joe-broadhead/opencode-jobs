/**
 * The tools RPC, version 2.3: every `jobs_*` tool, and the source contract's `events_list` and `probe`, as RPC methods,
 * so a script can call them with no model.
 *
 *   POST /api/rpc/jobs.scheduler.tools/<method>
 *   { "input": { "sessionID": "<session>", "input": <the tool's input> } }
 *
 * The transport is source-contract's `tools-rpc` module (pinned in package.json and bundled into dist/index.js): the
 * version 2 rules (resolve before dispatch, only `allow` runs, the one `evaluate` hook that turns an inner ask of this
 * RPC's own calls into a deny), `describe`, the envelope and the per-method resource resolver, which no Jobs method
 * uses. This module is Jobs' part of it, one `ToolsRpcPlugin` value: the plugin's id, its next steps and its own error
 * mapping. It was the PLUGIN-SPECIFIC block of the shared copy every plugin carried.
 */
import { SourceError } from "@we-the-rebel-alliance/source-contract/events"
import {
  registerToolsRpc as register,
  toolsRpcId,
  type Failure,
  type MethodSpec,
  type NextSteps,
  type ToolsRpcContext,
  type ToolsRpcPlugin,
} from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { PLUGIN_ID as JOBS_PLUGIN_ID } from "../constants.js"

export { CLASSES, LOCATION_HEADER, LOCATION_HINT, evaluate, hidden, upstreamText } from "@we-the-rebel-alliance/source-contract/tools-rpc"
export type {
  Failure,
  JsonSchema,
  McpResult,
  MethodClass,
  MethodSpec,
  NextSteps,
  PluginMethod,
  ShapeCall,
  ToolCall,
  ToolsRpcContext,
  ToolsRpcPlugin,
} from "@we-the-rebel-alliance/source-contract/tools-rpc"

/** The plugin's id. The RPC id is `<PLUGIN_ID>.tools`: `jobs.scheduler.tools`. */
export const PLUGIN_ID = JOBS_PLUGIN_ID

export const TOOLS_RPC_ID = toolsRpcId(PLUGIN_ID)

/**
 * The next step for each code. Jobs has no MCP server, so no method comes from one and the MCP-only steps are left to
 * the module, which needs them only for a table with an MCP method.
 */
export const NEXT_STEPS: NextSteps = {
  SESSION_UNKNOWN: `Create a session in the location you mean, such as POST /api/session with {"agent":"build"} sent with the header "x-opencode-directory: <dir>" or the location[directory] query, and pass its id.`,
  SESSION_AGENT_REQUIRED: `Create a session that names an agent this project has, with its project as the location, such as POST /api/session with {"agent":"build","location":{"directory":"/path/to/project"}}, and pass its id.`,
  PERMISSION_DENIED: "Add an allow rule for the tool to the session's agent or to the session, or use a session whose agent allows it.",
  CANCELLED: "Call the method again if you still need the result.",
}

/**
 * A Jobs failure from one of the plugin's own methods: a jobs error (`JOBS_*`, with its next step), or the source
 * contract's refusal from `events_list` and `probe` (`SourceError`: its code, what happened and the next step).
 */
export function pluginError(error: unknown): Failure | undefined {
  if (error instanceof SourceError) return { code: error.code, what: error.what.replace(/[.\s]+$/, ""), next: error.next }
  if (!(error instanceof Error)) return undefined
  const { code, nextStep } = error as { readonly code?: unknown; readonly nextStep?: unknown }
  if (typeof code !== "string" || !code.startsWith("JOBS_") || typeof nextStep !== "string") return undefined
  const own = error as { readonly what?: unknown }
  const what = typeof own.what === "string"
    ? own.what
    : error.message.startsWith(`${code}: `)
      ? error.message.slice(code.length + 2).replace(/ Next step: [\s\S]*$/, "")
      : error.message
  return { code, what, next: nextStep }
}

/** Jobs' part of the transport: no MCP server, so no shapers, and its own error mapping. */
export const JOBS_RPC: ToolsRpcPlugin = { id: PLUGIN_ID, nextSteps: NEXT_STEPS, pluginError }

/**
 * Registers the tools RPC with the plugin's method table: every method is plugin-owned and built where it has the
 * plugin's context (its own `permission.assert`). The host's context types are branded, so it is passed as the
 * module's structural context.
 */
export function registerToolsRpc(ctx: unknown, options: { readonly methods: readonly MethodSpec[] }): Promise<() => Promise<void>> {
  return register(ctx as ToolsRpcContext, { plugin: JOBS_RPC, methods: options.methods })
}
