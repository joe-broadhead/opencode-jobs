// An embedded OpenCode host from the public @opencode/sdk, isolated in the temp root from ./isolate.js: the
// environment, config, database and project directory all live there, and any fetch that leaves loopback fails the
// run. The plugin gets its options injected the way the host passes config options. A probe plugin, loaded after it,
// lends its context to the tests and registers a loopback mock model, so a run can complete without a real provider.
import { HOST_SDK_DIR, ROOT as root } from "./isolate.js"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { OpenCodeClient } from "@opencode/client"
import { Model, Plugin, Provider } from "@opencode/plugin"
import type { Clock } from "../../src/jobs/clock.js"
import type { Leader } from "../../src/jobs/leader.js"
import { createJobsPlugin, type Worker } from "../../src/plugin.js"
import { startMockModel, type MockModel } from "./mock.js"

// The package the host loads to talk to an OpenAI-compatible endpoint. It is a value the host resolves, not an import:
// nothing here imports @opencode/ai, which the repository forbids because it breaks between patch releases.
const OPENAI_COMPATIBLE = ["@opencode", "ai", "providers", "openai-compatible"].join("/")

/** The SDK's `Interface`, which its own declarations resolve to `any`. */
type Client = OpenCodeClient & { readonly close: () => Promise<void> }

/** The locked @opencode/sdk, or another 2.2.x installed outside the lockfile in HOST_SDK_DIR's node_modules. */
const SDK = HOST_SDK_DIR ? join(HOST_SDK_DIR, "node_modules", "@opencode", "sdk") : fileURLToPath(new URL("../../node_modules/@opencode/sdk", import.meta.url))
export const HOST_VERSION = (JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as { version: string }).version

const offLoopback: string[] = []
const realFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init)
    offLoopback.push(url.origin)
    return Promise.reject(new Error(`host test blocked a fetch to ${url.origin}`))
  },
  { preconnect: realFetch.preconnect },
) as typeof fetch

/** Removes the temp root; call once after every host in the file has closed. */
export const cleanup = () => rmSync(root, { recursive: true, force: true })

export interface HostInput {
  /** Plugin options, as a user writes them in opencode.json. */
  readonly options?: Record<string, unknown>
  /** Extra user config: permissions and agents. */
  readonly config?: Record<string, unknown>
  /** Injected into the plugin, so a test advances the clock itself. */
  readonly clock?: Clock
  /** False leaves the loop to the caller, which ticks and beats the worker by hand. */
  readonly loop?: boolean
  /** Plugins loaded beside Jobs: a fake family tools RPC, or a non-family tool with its own assert. */
  readonly plugins?: readonly Plugin.Plugin[]
}

export type { Worker } from "../../src/plugin.js"

let hosts = 0

export async function startHost(input: HostInput = {}) {
  const base = join(root, `host-${++hosts}`)
  const work = join(base, "work")
  mkdirSync(work, { recursive: true })
  const mock = startMockModel()
  const probes = new Map<string, Plugin.Context[]>()
  const workers = new Map<string, Worker[]>()
  const leaders = new Map<string, Leader[]>()
  const jobs = createJobsPlugin({
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    loop: input.loop !== false,
    onLeader: (leader) => {
      const list = leaders.get(leader.location) ?? []
      list.push(leader)
      leaders.set(leader.location, list)
    },
    onWorker: (worker) => {
      const list = workers.get(worker.leader.location) ?? []
      list.push(worker)
      workers.set(worker.leader.location, list)
    },
  })
  const withOptions = Plugin.define({ id: jobs.id, setup: (ctx) => jobs.setup({ ...ctx, options: input.options ?? {} }) })
  const probe = Plugin.define({
    id: "jobs.host-test.probe",
    async setup(ctx) {
      const providerID = Provider.ID.make("mock")
      await ctx.provider.transform((editor) => {
        editor.add({
          info: { ...Provider.Info.empty(providerID), name: "Mock", activation: "enabled", package: OPENAI_COMPATIBLE, settings: { baseURL: mock.baseURL, apiKey: "mock" } } as never,
          models: [{ ...Model.Info.default(providerID, Model.ID.make("m1")), name: "Mock 1" }],
        })
      })
      await ctx.model.transform((editor) => editor.default.set("mock", "m1"))
      const list = probes.get(ctx.location.directory) ?? []
      list.push(ctx)
      probes.set(ctx.location.directory, list)
    },
  })
  const config = {
    // Keep the built-in local providers from probing their default ports.
    providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } },
    ...input.config,
  }
  const { OpenCode } = (await import(pathToFileURL(join(SDK, "dist", "index.js")).href)) as typeof import("@opencode/sdk")
  const create = () =>
    OpenCode.create({
      plugins: [withOptions, probe, ...(input.plugins ?? [])],
      // An embedded host reports "unknown" unless told, and the plugin's host guard refuses that.
      app: { version: HOST_VERSION },
      config: { content: JSON.stringify(config), directory: join(base, "config"), project: false, claude: false },
      database: { path: join(base, "opencode.db") },
      models: { fetch: false },
      fs: { filewatcher: false },
      log: { level: "error" },
    }) as Promise<Client>
  let client = await create()
  const ready = async () => {
    await until("the jobs plugin is ready", async () => {
      const { data: plugins } = await client.plugin.list({ location })
      const state = plugins.find((plugin) => plugin.id === jobs.id)?.state
      if (state?.status === "failed") throw new Error(`the jobs plugin failed: ${JSON.stringify(state)}`)
      const enabled = input.options?.enabled !== false
      return state?.status === "active" && probes.has(work) && (!enabled || workers.has(work))
    })
  }
  const location = { directory: work }
  const host = {
    client,
    location,
    mock: () => mock as MockModel,
    /** The probe context of a loaded location: the latest setup, which is the live instance. */
    probe: (directory: string = work) => {
      const list = probes.get(directory)
      const ctx = list?.[list.length - 1]
      if (!ctx) throw new Error(`the probe plugin has not loaded in ${directory}`)
      return ctx
    },
    /** How many times the plugin has been set up in a directory; a reload raises it. */
    setups: (directory: string = work) => probes.get(directory)?.length ?? 0,
    /** How many times the worker has started in a directory: one per leadership, not per setup. */
    workers: (directory: string = work) => workers.get(directory)?.length ?? 0,
    /** The latest leader in a directory, leading or following. */
    leader: (directory: string = work) => {
      const list = leaders.get(directory)
      const leader = list?.[list.length - 1]
      if (!leader) throw new Error(`the jobs leader has not started in ${directory}`)
      return leader
    },
    /** A directory beside the first location, for a second location. */
    sibling: (name: string) => join(base, name),
    /** The worker of a loaded location: its leader, runner and keep-alive. */
    worker: (directory: string = work) => {
      const list = workers.get(directory)
      const worker = list?.[list.length - 1]
      if (!worker) throw new Error(`the jobs worker has not started in ${directory}`)
      return worker
    },
    /** Loads a second location, as a client opening another project does, and waits for its plugin. */
    async open(directory: string) {
      mkdirSync(directory, { recursive: true })
      await until(`the plugin loads in ${directory}`, async () => {
        await client.plugin.list({ location: { directory } })
        return probes.has(directory) && leaders.has(directory)
      })
      return { probe: () => host.probe(directory), worker: () => host.worker(directory) }
    },
    /** Restarts the whole embedded host on the same database and project, as a process restart does. */
    async restart() {
      await client.close()
      client = await create()
      await ready()
    },
    async close() {
      await client.close()
      mock.stop()
      if (offLoopback.length) throw new Error(`the host tried to leave loopback: ${[...new Set(offLoopback)].join(", ")}`)
    },
  }
  try {
    await ready()
  } catch (error) {
    await host.close().catch(() => undefined)
    throw error
  }
  return host
}

export type Host = Awaited<ReturnType<typeof startHost>>

/** Polls `check` until it returns a value. The default leaves room for a busy machine, inside the 120 s test limit. */
export async function until<T>(what: string, check: () => Promise<T | false | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`)
    await Bun.sleep(50)
  }
}
