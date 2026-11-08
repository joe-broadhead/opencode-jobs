/**
 * The script gate: it resolves a manifest against the host and the named agent's own rules, and it asks the one
 * approval a script gets.
 *
 * A family method is looked up through that plugin's tools RPC `describe` (the exact-name table); a `host:` entry is a
 * tool the host lists, by exact id. The effect is resolved from the agent's own `permissions` with the host's rule
 * order, and nothing else: the run session's rules *are* the grant, so resolving against them would make every grant
 * its own permission. A method the table does not know is refused with the nearest names, never guessed.
 */
import type { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { evaluate, type Rule } from "../host/permissions.js"
import { JobInputError } from "./model.js"
import {
  approvalResource,
  filesDigest,
  manifestDigest,
  reachesOf,
  scriptDigest,
  sourceHash,
  type MethodClass,
  type ResolvedFile,
  type ResolvedTool,
  type Script,
  type ScriptApproval,
} from "./script.js"

/** What a tool does, before the agent's rules are applied. */
export interface MethodInfo {
  readonly method: string
  readonly action: string
  readonly class: MethodClass
  readonly kind: "family" | "host"
  readonly description?: string
}

/** The one permission assert a script approval makes. */
type Assert = Plugin.Context["permission"]["assert"]

export interface ScriptHost {
  readonly rpc: Plugin.Context["rpc"]
  readonly tool: Pick<Plugin.Context["tool"], "list">
  readonly agent: Pick<Plugin.Context["agent"], "get">
  readonly plugin: Pick<Plugin.Context["plugin"], "list">
  readonly mcp: Pick<Plugin.Context["mcp"], "list">
  /** The leader's directory: the agent and the loaded plugins are that location's. */
  readonly location: string
  readonly permission: { readonly assert: Assert }
  readonly now: () => number
}

export interface ScriptGate {
  /** Resolves every entry for the agent; an unknown method throws `JOBS_SCRIPT_UNKNOWN_TOOL`. */
  resolve(entries: readonly string[], agentID: string, directory?: string): Promise<readonly ResolvedTool[]>
  /** Resolves, records the approval through the host's one prompt, and returns it. */
  approve(input: {
    sessionID: string
    agent: string
    script: Script
    resolved: readonly ResolvedTool[]
    files?: readonly ResolvedFile[]
    source?: { readonly messageID: string; readonly id: string }
    /** The job whose script this is, for the "where to read it" line; absent for a one-off tool call. */
    job?: string
  }): Promise<ScriptApproval>
}

/** How much source the approval prompt carries; the rest is named by `where`. */
const SOURCE_HEAD = 8192

const CLASSES: readonly MethodClass[] = ["read", "write", "send", "export", "destructive", "unclassified"]

/**
 * OpenCode's own capability tools, by id and by name. They are the host's shell, file, network, task and prompt
 * surfaces; a script must never reach them, because the guest's confinement claim (no filesystem, shell or network)
 * would be false. The structural rule below refuses them too; this list is the second layer SR-2 asks for.
 */
const CORE_TOOLS: ReadonlySet<string> = new Set([
  "bash", "shell", "edit", "write", "patch", "multiedit", "read", "list", "glob", "grep",
  "webfetch", "websearch", "fetch", "task", "subagent", "skill", "question", "todo", "todowrite", "todoread",
  "bash_output", "kill_bash",
])

/** True for a tool whose registration is OpenCode's own rather than a plugin's or an MCP server's. */
function isCoreTool(tool: { readonly id: string; readonly name: string; readonly options?: { readonly namespace?: string } }, servers: ReadonlySet<string>): boolean {
  if (CORE_TOOLS.has(tool.id) || CORE_TOOLS.has(tool.name)) return true
  const namespace = tool.options?.namespace
  // A plugin names its namespace; OpenCode's own tools use `opencode`, or no namespace at all.
  if (namespace === "opencode") return true
  const mcp = [...servers].some((server) => tool.id === server || tool.id.startsWith(`${server}_`))
  return !mcp && namespace === undefined
}
const classOf = (value: unknown): MethodClass => (typeof value === "string" && (CLASSES as readonly string[]).includes(value) ? (value as MethodClass) : "unclassified")

/** A plugin id and a method from a manifest entry, split at the last dot. */
function split(entry: string): { plugin: string; method: string } {
  const at = entry.lastIndexOf(".")
  return { plugin: entry.slice(0, at), method: entry.slice(at + 1) }
}

/** One contract for a plugin's tools RPC, with only the methods this lookup asks about defined. */
function contract(id: string, methods: readonly string[]) {
  return Rpc.define({
    id: `${id}.tools`,
    methods: {
      describe: { input: { type: "object" }, output: { type: "object" } },
      ...Object.fromEntries(methods.map((name) => [name, { input: { type: "object" }, output: { type: "object" }, errors: { failed: { type: "object" } } }])),
    },
    events: {},
  } as never)
}

/** The `describe` output, as the lookup reads it. */
interface Described {
  readonly methods?: readonly { readonly name?: unknown; readonly tool?: unknown; readonly action?: unknown; readonly class?: unknown; readonly description?: unknown }[]
}

export function createScriptGate(host: ScriptHost): ScriptGate {
  const described = async (plugin: string, method: string): Promise<MethodInfo | undefined> => {
    try {
      const client = host.rpc(contract(plugin, [method]) as never) as unknown as Record<string, (body: unknown, options?: unknown) => Promise<unknown>>
      const answer = (await client.describe!({})) as Described
      const found = answer.methods?.find((entry) => entry.name === method)
      if (found === undefined || typeof found.action !== "string") return undefined
      return {
        method: `${plugin}.${method}`,
        action: found.action,
        class: classOf(found.class),
        kind: "family",
        ...(typeof found.description === "string" ? { description: found.description } : {}),
      }
    } catch {
      return undefined
    }
  }

  /** A bare service label resolves to the one loaded plugin whose id starts with it and that exposes the method. */
  const family = async (plugin: string, method: string, directory: string): Promise<MethodInfo | undefined> => {
    const direct = await described(plugin, method)
    if (direct !== undefined) return direct
    if (plugin.includes(".")) return undefined
    const listed = (await host.plugin.list({ location: { directory } } as never).catch(() => ({ data: [] }))) as { data?: readonly { id?: string }[] }
    const candidates = (listed.data ?? []).flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : [])).filter((id) => id === plugin || id.split(".")[0] === plugin).slice(0, 12)
    const found = (await Promise.all(candidates.map((id) => described(id, method)))).filter((entry): entry is MethodInfo => entry !== undefined)
    return found.length === 1 ? found[0] : undefined
  }

  const servers = async (): Promise<ReadonlySet<string>> => {
    const listed = (await host.mcp.list().catch(() => ({ data: [] as { name?: string; status?: { status?: string } }[] }))) as { data?: readonly { name?: string; status?: { status?: string } }[] }
    return new Set((listed.data ?? []).flatMap((entry) => (typeof entry.name === "string" ? [entry.name] : [])))
  }

  /** The family method a tool id serves, if a loaded plugin's describe lists it: `host:` must not bypass shaping. */
  const familyFor = async (id: string, directory: string): Promise<string | undefined> => {
    const listed = (await host.plugin.list({ location: { directory } } as never).catch(() => ({ data: [] }))) as { data?: readonly { id?: string }[] }
    const candidates = (listed.data ?? []).flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : [])).slice(0, 24)
    for (const plugin of candidates) {
      try {
        const client = host.rpc(contract(plugin, []) as never) as unknown as Record<string, (body: unknown, options?: unknown) => Promise<unknown>>
        const answer = (await client.describe?.({})) as Described & { readonly methods?: readonly { readonly name?: unknown; readonly tool?: unknown; readonly action?: unknown }[] }
        const found = answer.methods?.find((method) => method.tool === id || method.action === id)
        if (found !== undefined && typeof found.name === "string") return `${plugin}.${found.name}`
      } catch {
        // A plugin without a tools RPC is not a family server for this tool.
      }
    }
    return undefined
  }

  const hostTool = async (id: string, directory: string): Promise<MethodInfo | undefined> => {
    const tool = (await host.tool.list()).find((entry) => entry.id === id || entry.name === id)
    if (tool === undefined) return undefined
    const status = tool as { readonly id: string; readonly name: string; readonly description?: string; readonly options?: { readonly namespace?: string; readonly permission?: string } }
    if (isCoreTool(status, await servers())) {
      throw new JobInputError(
        "JOBS_SCRIPT_HOST_TOOL",
        "action.script.uses",
        `The manifest names OpenCode's own tool ${JSON.stringify(id)}; a script may not use the host's shell, file, network or task tools.`,
        `Remove it. A script reaches MCP servers and plugin tools only, by exact id; a family's tool is called as "<plugin id>.<method>", where its shaping and budget apply.`,
      )
    }
    const family = await familyFor(id, directory)
    if (family !== undefined) {
      throw new JobInputError(
        "JOBS_SCRIPT_FAMILY_TOOL",
        "action.script.uses",
        `The manifest names ${JSON.stringify(id)} as a host tool, but a loaded plugin serves it as the family method ${JSON.stringify(family)}.`,
        `Use ${JSON.stringify(family)} instead, so that plugin's shaping and budgets apply.`,
      )
    }
    return {
      method: `host:${tool.id}`,
      action: status.options?.permission ?? tool.id,
      class: "unclassified",
      kind: "host",
      ...(typeof status.description === "string" ? { description: status.description } : {}),
    }
  }

  const lookup = async (entry: string, directory: string): Promise<MethodInfo | undefined> =>
    entry.startsWith("host:") ? hostTool(entry.slice("host:".length), directory) : family(split(entry).plugin, split(entry).method, directory)

  /** Every name the lookup can see, for the nearest-names hint on an unknown entry: host tools and family methods. */
  const known = async (directory: string): Promise<string[]> => {
    const tools = await host.tool.list().then(
      (listed) => listed.map((entry) => `host:${entry.id}`),
      () => [],
    )
    const listed = (await host.plugin.list({ location: { directory } } as never).catch(() => ({ data: [] }))) as { data?: readonly { id?: string }[] }
    const candidates = (listed.data ?? []).flatMap((entry) => (typeof entry.id === "string" ? [entry.id] : [])).slice(0, 24)
    const family = await Promise.all(
      candidates.map(async (plugin) => {
        try {
          const client = host.rpc(contract(plugin, []) as never) as unknown as Record<string, (body: unknown, options?: unknown) => Promise<unknown>>
          const answer = (await client.describe?.({})) as Described
          return (answer.methods ?? []).flatMap((method) => (typeof method.name === "string" ? [`${plugin}.${method.name}`] : []))
        } catch {
          return []
        }
      }),
    )
    return [...tools, ...family.flat()]
  }

  const resolve = async (entries: readonly string[], agentID: string, directory = host.location): Promise<readonly ResolvedTool[]> => {
    // The host's agent view is this location's; passing a location back (especially a Location.Ref carrying a workspace)
    // fails for a project-level plugin on 2.2.4, so only a job that targets another directory names one explicitly.
    const info = await host.agent.get({ agentID, ...(directory === host.location ? {} : { location: { directory } }) }).then(
      (found) => found.data,
      () => undefined,
    )
    if (info === undefined) throw new JobInputError("JOBS_SCRIPT_UNKNOWN_TOOL", "agent", `The agent ${JSON.stringify(agentID)} could not be read, so its rules cannot resolve the script's tools.`, `Name an agent OpenCode lists, then give it its own "permissions".`)
    const rules = (info.permissions ?? []) as readonly Rule[]
    const resolved: ResolvedTool[] = []
    const unknown: string[] = []
    for (const entry of entries) {
      const found = await lookup(entry, directory)
      if (found === undefined) {
        unknown.push(entry)
        continue
      }
      resolved.push({ ...found, effect: evaluate(rules, found.action) })
    }
    if (unknown.length > 0) {
      const names = await known(directory)
      const hint = unknown
        .map((entry) => {
          const tail = entry.startsWith("host:") ? entry.slice(5) : split(entry).method
          const near = names.filter((name) => name.includes(tail) || name.endsWith(tail)).slice(0, 5)
          return `${JSON.stringify(entry)}${near.length === 0 ? "" : ` (did you mean ${near.join(", ")}?)`}`
        })
        .join("; ")
      throw new JobInputError(
        "JOBS_SCRIPT_UNKNOWN_TOOL",
        "action.script.uses",
        `The manifest names ${unknown.length === 1 ? "a tool" : "tools"} the host does not list: ${hint}.`,
        `Use a method the plugin's tools RPC describe lists, as "<plugin id>.<method>", or a tool the host lists, as "host:<tool id>".`,
      )
    }
    return resolved
  }

  const approve: ScriptGate["approve"] = async (input) => {
    const source = sourceHash(input.script.code)
    const manifest = manifestDigest(input.script.uses)
    const declaredFiles = filesDigest(input.script.files)
    const digest = scriptDigest(source, manifest, declaredFiles)
    const files = input.files ?? []
    const bytes = Buffer.byteLength(input.script.code, "utf8")
    const head = input.script.code.slice(0, SOURCE_HEAD)
    await host.permission.assert({
      sessionID: input.sessionID,
      agent: input.agent,
      action: "jobs_script",
      resources: [approvalResource(digest)],
      save: [approvalResource(digest)],
      metadata: {
        digest,
        sourceHash: source,
        manifestDigest: manifest,
        bytes,
        // What the person approves: the source itself, a clear head when it is long, and where the rest is (SR-5).
        script: head,
        truncated: head.length < input.script.code.length,
        where: input.job === undefined ? "the tool call's input" : `the jobs_get tool, job ${JSON.stringify(input.job)}`,
        tools: input.resolved.map((tool) => ({ method: tool.method, class: tool.class, effect: tool.effect, ...(tool.description === undefined ? {} : { description: tool.description }) })),
        writes: reachesOf(input.resolved),
        files: files.map((file) => ({ name: file.name, path: file.path, mode: file.mode, format: file.format, maxBytes: file.maxBytes })),
      },
      ...(input.source === undefined ? {} : { source: { type: "tool", messageID: input.source.messageID, id: input.source.id } }),
    })
    return {
      sourceHash: source,
      manifestDigest: manifest,
      filesDigest: declaredFiles,
      digest,
      at: host.now(),
      resolved: input.resolved,
      files,
    }
  }

  return { resolve, approve }
}
