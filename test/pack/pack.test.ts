// Pack, install and load the published shape. The tarball holds exactly the files whitelist and installs with
// lifecycle scripts disabled. Installed alone, it loads in each stock OpenCode release it is tested on, which provides
// @opencode/plugin, OpenTUI and Solid itself; next to those packages, both entry points also import under Bun.
// OPENCODE_BIN_2_2_3, OPENCODE_BIN_2_2_4 and OPENCODE_BIN_2_2_5 name stock binaries; otherwise each release is
// installed with npm, once per run. Every temp folder is a git repository under the system's /tmp, never under TMPDIR
// or HOME, so OpenCode's upward search for `.opencode` folders never reaches the agents of whoever runs the test.
// PACK_TARBALL names a tarball that was already packed, such as the one the release publishes, to test it instead.
import { afterAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { arch, platform } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { PLUGIN_ID, SUPPORTED_HOST, TESTED_HOSTS, TUI_ID } from "../../src/constants.js"

const root = fileURLToPath(new URL("../..", import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string
  version: string
  files: string[]
  exports: Record<string, string>
  devDependencies: Record<string, string>
  jelly: { skills: string[] }
}
// Outside the repository, so nothing resolves from the repository's own node_modules.
const work = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "jobs-pack-")))
// A repository root, where OpenCode's search for `.opencode` folders and project config stops.
run("git", ["init", "--quiet", work], root)
// Removing the installed packages and binaries can take longer than the default hook timeout.
afterAll(() => rmSync(work, { recursive: true, force: true }), { timeout: 120_000 })

const MAX_FILES = 30
// The server bundle deliberately carries the scheduler and the file parser (croner, yaml; D3, NOTICE), which is most of
// the tarball. The cap is wide enough for those two and the plugin, and narrow enough to catch a third library arriving
// unnoticed.
const MAX_PACKED_BYTES = 128 * 1024
// The two self-contained entry bundles, and nothing else, in dist/.
const DIST = ["dist/index.js", "dist/tui.js"]
// Modules the host serves to plugins at runtime. Everything else must be inlined in the bundle.
const SERVER_HOST_MODULES = [/^node:/, /^@opencode\/plugin(?:\/|$)/]
const TUI_HOST_MODULES = [/^node:/, /^@opencode\/plugin(?:\/|$)/, /^@opentui\//, /^solid-js(?:\/|$)/]
// The host packages OpenCode 2.2.3 ships; the versions come from devDependencies.
const HOST_PACKAGES = ["@opencode/plugin", "@opentui/core", "@opentui/solid", "solid-js"]
// The stock OpenCode releases the package is tested on: the one list in src/constants.ts.
const HOST_VERSIONS = TESTED_HOSTS
// Anything a stock host tries on the network goes to a closed port, except loopback.
const OFFLINE = {
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  http_proxy: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_DISABLE_FREE_MODELS: "true",
}

type Packed = { filename: string; size: number; entryCount: number; files: { path: string }[] }

let packed: Packed | undefined
function pack(): Packed {
  if (packed) return packed
  const given = process.env.PACK_TARBALL
  if (given) {
    const tarball = resolve(given)
    copyFileSync(tarball, join(work, basename(tarball)))
    const files = run("tar", ["-tzf", tarball], root).trim().split("\n").filter((path) => !path.endsWith("/")).map((path) => ({ path: path.replace(/^package\//, "") }))
    packed = { filename: basename(tarball), size: statSync(tarball).size, entryCount: files.length, files }
    return packed
  }
  // Build first, explicitly: the package has no prepare or prepack hook, and a stale dist/ must never be packed.
  run("node", [join(root, "scripts", "check.mjs"), "build"], root)
  const result = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], root)
  packed = (JSON.parse(result) as Packed[])[0]!
  return packed
}

/** An empty project with its own package.json, so npm never walks up to another one. */
function project(name: string): string {
  const dir = join(work, name)
  mkdirSync(dir)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `jobs-pack-${name}`, private: true, type: "module" }))
  return dir
}

const installs = new Map<string, string>()
/** The tarball installed with scripts disabled, alone or next to the host packages. */
function install(withHostPackages: boolean): string {
  const name = withHostPackages ? "with-host-packages" : "alone"
  const existing = installs.get(name)
  if (existing) return existing
  const dir = project(name)
  const hosts = withHostPackages ? HOST_PACKAGES.map((item) => `${item}@${pkg.devDependencies[item]}`) : []
  run("npm", ["install", join(work, pack().filename), ...hosts, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], dir)
  installs.set(name, dir)
  return dir
}

const installedPackage = (withHostPackages: boolean) => join(install(withHostPackages), "node_modules", ...pkg.name.split("/"))

/** A home, OpenCode's test home, XDG folders and a temp folder, all inside `base`. */
function isolated(base: string) {
  const home = join(base, "home")
  const env = {
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    TMPDIR: join(base, "tmp"),
  }
  for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true })
  return env
}

describe("package tarball", () => {
  test("lists exactly the files whitelist, under the size and file limits", () => {
    const { files, entryCount, size } = pack()
    const paths = files.map((file) => file.path).sort()
    const expected = ["package.json", ...pkg.files.flatMap((entry) => whitelisted(entry))].sort()
    expect(paths).toEqual(expected)
    expect(entryCount).toBeLessThan(MAX_FILES)
    expect(size).toBeLessThanOrEqual(MAX_PACKED_BYTES)
    expect(paths.filter((path) => path.includes("node_modules/") || /\.(?:tsx|jsx)$/.test(path))).toEqual([])
    for (const target of Object.values(pkg.exports)) expect(paths).toContain(target.replace(/^\.\//, ""))
    // Every skill the jelly declaration names ships, and no other skill does.
    const declared = (pkg as unknown as { jelly: { skills: string[] } }).jelly.skills
    expect(paths.filter((path) => path.startsWith("skills/")).sort()).toEqual(declared.map((name) => `skills/${name}/SKILL.md`).sort())
    expect(paths.filter((path) => path.endsWith(".d.ts"))).toEqual([])
  }, 120_000)

  test("installs with scripts disabled and loads both entry points under Bun, next to the host packages", () => {
    const consumer = install(true)
    const probe = join(consumer, "probe.mjs")
    writeFileSync(probe, [
      "const out = {}",
      `for (const [part, specifier] of [["server", ${JSON.stringify(pkg.name)}], ["tui", ${JSON.stringify(`${pkg.name}/tui`)}]]) {`,
      "  const plugin = (await import(specifier)).default",
      "  out[part] = { id: plugin?.id, setup: typeof plugin?.setup }",
      "}",
      "console.log(JSON.stringify(out))",
    ].join("\n"))
    const output = run(process.execPath, [probe], consumer, { PATH: process.env.PATH, ...isolated(join(work, "bun-probe")) })
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({
      server: { id: PLUGIN_ID, setup: "function" },
      tui: { id: TUI_ID, setup: "function" },
    })
  }, 300_000)

  // OpenCode reloads a plugin in place and reuses the module records it holds for unchanged paths, so an entry that
  // imported a sibling module could get an older cached copy of it. Each entry must stand alone.
  test("dist holds only the two entry bundles, and they import no sibling module", () => {
    const dist = join(installedPackage(true), "dist")
    expect(tree(relative(root, dist), dist).sort()).toEqual(["index.js", "tui.js"])
    for (const file of ["index.js", "tui.js"]) expect(relativeImports(readFileSync(join(dist, file), "utf8"))).toEqual([])
  }, 300_000)

  test("dist imports only modules the host provides", () => {
    const dist = join(installedPackage(true), "dist")
    expect(foreign(join(dist, "index.js"), SERVER_HOST_MODULES)).toEqual([])
    expect(foreign(join(dist, "tui.js"), TUI_HOST_MODULES)).toEqual([])
  }, 300_000)
})

describe.each(HOST_VERSIONS)("installed alone, in stock OpenCode %s", (version) => {
  test("is active and answers the status RPC with no jobs yet", async () => {
    const installed = installedPackage(false)
    const host = await serve(version, installed)
    try {
      await host.until("the plugin finishes loading", async () => {
        const { data } = await host.api<{ data: { id: string; state: { status: string } }[] }>("GET", "/api/plugin")
        const found = data.find((item) => item.id === PLUGIN_ID)
        if (found?.state.status === "failed") throw new Error(`${PLUGIN_ID} failed: ${JSON.stringify(found.state)}`)
        return found && found.state.status !== "loading" ? found : undefined
      })
      const { output } = await host.api<{ output: Record<string, unknown> }>("POST", `/api/rpc/${PLUGIN_ID}/status`, { input: {} })
      expect(output).toMatchObject({
        version: pkg.version,
        state: "ready",
        host: { version, range: SUPPORTED_HOST, tested: true },
        jobs: { total: 0, paused: 0, expiring: 0, invalidFiles: 0 },
        unguardedAgents: [],
        problems: [],
        nextStep: "Nothing to do.",
      })
    } catch (error) {
      throw new Error(`${(error as Error).message}\n--- opencode ${version} log ---\n${host.log().slice(-3000)}`)
    } finally {
      await host.close()
    }
  }, 600_000)
})

/**
 * The failure the soak found: a plugin-only reload, which is what `opencode plugin update` does, can leave the running
 * plugin with a stale agent view — the host's own API still lists the project's configuration agents, but the plugin
 * does not. Jobs must fail closed, say what happened, and resume with no further action once the agents are back. The
 * break is a race, so the test retries the bundle change until it loses, as the real update can.
 */
interface HostStatus {
  readonly jobs: { readonly total: number; readonly invalidFiles: number }
  readonly recentRuns: readonly { readonly job: string; readonly name: string; readonly status: string; readonly slot: string }[]
  readonly missingAgents: readonly string[]
  readonly unguardedAgents: readonly string[]
  readonly nextStep: string
  readonly problems: readonly string[]
}

describe.each(HOST_VERSIONS)("a plugin-only reload, in stock OpenCode %s", (version) => {
  test("a dropped agent fails closed, says so, and the next slot runs once after opencode reload", async () => {
    const installed = installedPackage(false)
    const host = await serve(version, installed, {
      name: "agent-reload",
      config: { agents: { jobs: { description: "The jobs agent", mode: "primary", permissions: [{ action: "*", resource: "*", effect: "deny" }] } } },
      files: {
        ".opencode/jobs/status.md": "---\nname: Status\nschedule:\n  every: 1 minute\naction:\n  type: command\n  name: jobs-status\nagent: jobs\n---\n",
      },
    })
    // `opencode reload` can close the socket for a moment (2.2.3 in particular), so a transient reset is retried, not
    // read as a failed assertion.
    const retry = async <T>(read: () => Promise<T>): Promise<T> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await read()
        } catch (error) {
          if (attempt >= 20 || !/ECONNRESET|ECONNREFUSED|socket connection was closed/i.test(String(error))) throw error
          await Bun.sleep(1_000)
        }
      }
    }
    const status = async () => retry(async () => (await host.api<{ output: HostStatus }>("POST", `/api/rpc/${PLUGIN_ID}/status`, { input: {} })).output)
    const sessions = async () => retry(async () => (await host.api<{ data: readonly { readonly id: string }[] }>("GET", "/api/session")).data.length)
    const loaded = async () => (await status()).jobs.total === 1
    try {
      await host.until("the server answers", async () => ((await status()) ? true : undefined), 180_000)
      // The same race can lose at boot. The status names the action, so the test uses it.
      for (let attempt = 0; attempt < 30 && !(await loaded()); attempt += 1) {
        if ((await status()).missingAgents.includes("jobs")) host.reload()
        await Bun.sleep(2_000)
      }
      expect(await loaded()).toBe(true)
      const before = await sessions()

      // The plugin re-setup a plugin update causes. Retried because whether setup sees the configuration agents is a race.
      let broken = false
      for (let attempt = 0; attempt < 4 && !broken; attempt += 1) {
        appendFileSync(join(installed, "dist", "index.js"), "\n// reload\n")
        await Bun.sleep(6_000)
        broken = (await status()).missingAgents.includes("jobs")
      }
      expect(broken).toBe(true)

      const down = await status()
      expect(down.missingAgents).toEqual(["jobs"])
      expect(down.unguardedAgents).toEqual([])
      expect(down.nextStep).toContain("opencode reload")
      expect(down.problems.some((problem) => problem.startsWith("JOBS_AGENT_MISSING: "))).toBe(true)
      expect(down.jobs.invalidFiles).toBe(1)

      // While the row is up, nothing runs and nothing is written.
      expect((await status()).recentRuns.filter((run) => run.status === "succeeded" || run.status === "running")).toEqual([])
      expect(await sessions()).toBe(before)

      // Either the next file scan finds the agents again (auto-recovery, no user action), or they stay missing past a
      // scheduled slot; then the status row's own action restores them. The test accepts either, and proves both that
      // nothing ran while broken and that the next slot runs exactly once after recovery.
      let healed = false
      const waitUntil = Date.now() + 75_000
      while (Date.now() < waitUntil && !healed) {
        healed = await loaded()
        if (!healed) await Bun.sleep(3_000)
      }
      if (!healed) {
        // A whole slot passed while the agent was missing: nothing ran, and nothing was written.
        expect((await status()).recentRuns.filter((run) => run.status === "succeeded" || run.status === "running")).toEqual([])
        expect(await sessions()).toBe(before)
        for (let attempt = 0; attempt < 4 && !healed; attempt += 1) {
          host.reload()
          await Bun.sleep(8_000)
          healed = await loaded()
        }
      }
      expect(healed).toBe(true)

      // The next slot runs once, and creates one session: the run's own.
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline && !(await status()).recentRuns.some((run) => run.status === "succeeded")) await Bun.sleep(3_000)
      const slots = (runs: readonly { readonly slot: string; readonly status: string }[]) => runs.filter((run) => run.status === "succeeded").map((run) => run.slot)
      const final = await status()
      const first = slots(final.recentRuns)
      if (first.length === 0) throw new Error(`the recovered job never ran: ${JSON.stringify(final)}; sessions ${await sessions()}`)
      // Every slot ran once, and the run wrote: a session exists that did not before (one shared parent is allowed).
      expect(new Set(first).size).toBe(first.length)
      expect(await sessions()).toBeGreaterThan(before)
      // No slot runs twice, even as the following ones arrive.
      await Bun.sleep(20_000)
      const later = slots((await status()).recentRuns)
      expect(new Set(later).size).toBe(later.length)
      expect(await sessions()).toBeGreaterThanOrEqual(before + later.length)
      expect(await sessions()).toBeLessThanOrEqual(before + later.length + 1)
    } catch (error) {
      throw new Error(`${(error as Error).message}\n--- opencode ${version} log ---\n${host.log().slice(-3000)}`)
    } finally {
      await host.close()
    }
  }, 600_000)
})

/**
 * OPENCODE_BIN_<version>, or the unmodified npm release with its platform binary, installed with scripts disabled.
 * Installed once per version: several describe blocks serve the same release.
 */
const installed = new Map<string, string>()
function stockBinary(version: string): string {
  const given = process.env[`OPENCODE_BIN_${version.replaceAll(".", "_")}`]
  if (given) return given
  const cached = installed.get(version)
  if (cached) return cached
  const binary = `@opencode/cli-${platform()}-${arch()}`
  const dir = project(`opencode-${version}`)
  // Only this platform's binary: each one is a few hundred megabytes.
  run("npm", ["install", `@opencode/cli@${version}`, `${binary}@${version}`, "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], dir)
  const path = join(dir, "node_modules", binary, "bin", "opencode")
  installed.set(version, path)
  return path
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as { port: number }
  await new Promise((done) => server.close(done))
  return port
}

/**
 * `opencode serve` on its own port and password, in an environment that holds only its temp root and is offline, with
 * a project that loads the installed package.
 */
async function serve(version: string, installed: string, options: { readonly name?: string; readonly config?: Record<string, unknown>; readonly files?: Readonly<Record<string, string>> } = {}) {
  const binary = stockBinary(version)
  const base = join(work, `stock-${version}${options.name === undefined ? "" : `-${options.name}`}`)
  const directory = join(base, "project")
  // Keep the built-in local providers from probing their default ports.
  const providers = { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } }
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "opencode.json"), JSON.stringify({ plugins: [installed], providers, ...options.config }))
  for (const [path, body] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), body)
  }
  const password = randomUUID()
  const env = { ...isolated(base), ...OFFLINE, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", OPENCODE_PASSWORD: password }

  expect(run(binary, ["--version"], directory, env).trim()).toBe(`opencode v${version}`)
  // OpenCode resolves every global path from this environment; none may leave the temp root.
  const paths = run(binary, ["debug", "paths"], directory, env).trim().split("\n").map((line) => line.trim().split(/\s+/))
  expect(paths.length).toBeGreaterThan(5)
  expect(paths.filter(([, path]) => !path?.startsWith(base + sep))).toEqual([])

  const port = await freePort()
  let log = ""
  const server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] })
  server.stdout.on("data", (chunk) => void (log += chunk))
  server.stderr.on("data", (chunk) => void (log += chunk))
  const exited = new Promise((done) => server.once("exit", done))

  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  /** The response's status and parsed body, whatever the status. */
  const request = async (method: string, path: string, body?: unknown, location = directory) => {
    const url = new URL(path, `http://127.0.0.1:${port}`)
    url.searchParams.set("location[directory]", location)
    const response = await fetch(url, { method, headers: { authorization, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // Not JSON: keep the text.
    }
    return { status: response.status, ok: response.ok, text, body: parsed }
  }
  const api = async <T>(method: string, path: string, body?: unknown, location = directory): Promise<T> => {
    const response = await request(method, path, body, location)
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${response.text.slice(0, 500)}`)
    return response.body as T
  }
  /** Polls until `read` returns a value. The server answers before plugins finish loading, more slowly when busy. */
  const until = async <T>(what: string, read: () => Promise<T | false | undefined>, ms = 180_000): Promise<T> => {
    for (const deadline = Date.now() + ms; ; await Bun.sleep(500)) {
      const value = await read().catch((error: unknown) => (Date.now() > deadline ? Promise.reject(error) : undefined))
      if (value) return value
      if (server.exitCode !== null) throw new Error(`opencode ${version} exited before ${what}`)
      if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`)
    }
  }
  const close = async () => {
    if (server.exitCode !== null || server.signalCode !== null) return
    server.kill("SIGTERM")
    const timer = setTimeout(() => server.kill("SIGKILL"), 10_000)
    await exited
    clearTimeout(timer)
  }
  // `opencode reload` on this host: the smallest action that rebuilds a stale agent view.
  const reload = () => run(binary, ["reload", "--server", `http://127.0.0.1:${port}`], directory, env)
  return { api, request, until, close, reload, directory, log: () => log }
}

// The files a `files` entry should put in the tarball. dist/ must hold exactly the two bundles, so stale or foreign
// build output fails the comparison, and so does a missing whitelisted file.
function whitelisted(entry: string): string[] {
  if (entry === "dist") return DIST
  const path = join(root, entry)
  if (!existsSync(path)) return [`${entry} (missing)`]
  return statSync(path).isDirectory() ? tree(entry) : [entry]
}

/** Every file under `dir`, as paths relative to `base` (the repository root by default). */
function tree(dir: string, base = root): string[] {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile() && item.name !== ".DS_Store")
    .map((item) => relative(base, join(item.parentPath, item.name)).split(sep).join("/"))
}

/** Every module specifier in a file: static imports and re-exports, dynamic `import()` and `require()`. */
const specifiers = (source: string) =>
  [...source.matchAll(/(?:^|[\s;}])(?:import|export)\s*(?:[^'"`;]*?\sfrom\s*)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["'`]?([^"'`)]*)["'`]?\s*\)/g)].map((match) => (match[1] ?? match[2])!)

/** Relative imports, and every dynamic `import()` or `require()` call: a self-contained bundle has none. */
const relativeImports = (source: string) => [
  ...specifiers(source).filter((specifier) => specifier.startsWith(".")),
  ...[...source.matchAll(/(?<![\w$.])(?:import|require)\s*\(/g)].map((match) => match[0]),
]

/** The bare specifiers of one bundle that the allowed list does not cover. */
const foreign = (file: string, allowed: RegExp[]) =>
  [...new Set(specifiers(readFileSync(file, "utf8")).filter((specifier) => !allowed.some((pattern) => pattern.test(specifier))))].sort()

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = { ...process.env, npm_config_update_notifier: "false" }): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr}\n${result.stdout}`)
  return result.stdout
}
