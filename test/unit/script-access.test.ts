// R18/GAP-21: the access option decides whether a script is approved automatically, asks once, or is denied, from the
// manifest's worst class and the declared files. The digest is computed in every case that approves, and an unattended
// ask becomes a coded refusal, never a hang or a 500.
import { afterAll, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { approveJob, createJob } from "../../src/jobs/actions.js"
import type { ActionInput } from "../../src/jobs/actions.js"
import { readState } from "../../src/jobs/store.js"
import { createReport } from "../../src/jobs/report.js"
import { readJobFiles } from "../../src/jobs/files.js"
import { execute } from "../../src/jobs/execute.js"
import { runJobTool } from "../../src/jobs/tools.js"
import { createScriptGate, type ScriptHost } from "../../src/jobs/script-gate.js"
import { runScriptOnce } from "../../src/jobs/script-oneoff.js"
import type { Script } from "../../src/jobs/script.js"
import type { Access } from "../../src/options.js"
import { agentsFake, memoryStorage, sessionFake, testClock } from "./fake.js"

const NOW = Date.UTC(2026, 11, 6, 9, 0, 0)
const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "jobs-access-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

type Rule = { readonly action: string; readonly resource: string; readonly effect: "allow" | "ask" | "deny" }
const ALLOW: readonly Rule[] = [{ action: "*", resource: "*", effect: "allow" }]

const METHODS = [
  { name: "read", action: "x_read", class: "read" },
  { name: "write", action: "x_write", class: "write" },
]

/** A gate whose one prompt is answered, or refused, by the test; `asserted` counts the prompts. */
function setup(options: { readonly answer?: "yes" | "no" } = {}) {
  const asserted: Record<string, unknown>[] = []
  const host: ScriptHost = {
    rpc: ((definition: { id?: string }) => ({
      describe: async () => ({ id: "x.posts.tools", methods: String(definition?.id ?? "").startsWith("x.posts") ? METHODS : [] }),
    })) as unknown as Plugin.Context["rpc"],
    tool: { list: async () => [] } as never,
    agent: { get: async () => ({ data: { id: "build", name: "build", permissions: ALLOW } }) } as never,
    plugin: { list: async () => ({ data: [{ id: "x.posts" }] }) } as never,
    mcp: { list: async () => ({ data: [] }) } as never,
    location: root,
    permission: {
      assert: async (input) => {
        asserted.push(input as Record<string, unknown>)
        if (options.answer === "no") throw new Error("no one answered")
      },
    },
    now: () => NOW,
  }
  const storage = memoryStorage()
  const clock = testClock(NOW, { instantBelow: 0 })
  const agent = agentsFake({ unguarded: ["build"], names: ["build"] })
  const report = createReport({ storage: storage.storage, location: root, timezone: "UTC", clock: clock.clock, agent, host: { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }, enabled: true, keepAliveMinutes: 20 })
  const input: ActionInput = {
    storage: storage.storage,
    agent,
    clock: clock.clock,
    timezone: "UTC",
    location: root,
    source: () => report.source(),
    wake: () => undefined,
    ready: true,
    scripts: createScriptGate(host),
  }
  const gate = input.scripts!
  const create = (access: Access, script: Script) =>
    createJob({ ...input, access }, { name: "Script", schedule: { every: "1h" }, agent: "build", action: { type: "script", script } }, { sessionID: "ses_1", agent: "build" })
  return { asserted, create, gate, storage, input, source: () => report.source() }
}

const readScript: Script = { code: "return tools.x.posts.read({});", uses: ["x.posts.read"] }
const writeScript: Script = { code: "return tools.x.posts.write({});", uses: ["x.posts.write"] }
const readwriteFile = (mode: "read" | "write" | "readwrite"): Script => ({
  code: "return files.state;",
  uses: ["x.posts.read"],
  files: { state: { path: "state.json", mode, format: "json" } },
})

describe("R18: the access policy decides a script's approval", () => {
  test("`all` approves automatically, computes and records the digest, and never prompts", async () => {
    const run = setup()
    writeFileSync(join(root, "state.json"), "{}")
    for (const script of [writeScript, readwriteFile("readwrite")]) {
      const job = await run.create("all", script)
      const state = await readState(run.storage.storage, job.id)
      expect(state.approval?.approved).toBe("auto")
      expect(state.approval?.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(state.approval?.resolved.length).toBeGreaterThan(0)
    }
    expect(run.asserted).toHaveLength(0)
  })

  test("`ask-changes` approves an all-read script with no file writes, and asks once for a change", async () => {
    const run = setup()
    writeFileSync(join(root, "state.json"), "{}")
    const read = await run.create("ask-changes", readScript)
    expect((await readState(run.storage.storage, read.id)).approval?.approved).toBe("auto")
    const readFile = await run.create("ask-changes", readwriteFile("read"))
    expect((await readState(run.storage.storage, readFile.id)).approval?.approved).toBe("auto")
    expect(run.asserted).toHaveLength(0)

    for (const script of [writeScript, readwriteFile("readwrite")]) {
      const job = await run.create("ask-changes", script)
      expect((await readState(run.storage.storage, job.id)).approval?.approved).toBe("prompt")
    }
    expect(run.asserted).toHaveLength(2)
    expect(run.asserted[0]).toMatchObject({ action: "jobs_script", resources: [expect.stringMatching(/^script:sha256:/)] })
  })

  test("`ask-changes` with nobody to answer refuses with JOBS_UNCHECKED and a next step, and stores nothing", async () => {
    const run = setup({ answer: "no" })
    await expect(run.create("ask-changes", writeScript)).rejects.toThrow(/JOBS_UNCHECKED: .*needs a person's approval/)
    expect((await run.source()).jobs).toHaveLength(0)
  })

  test("`read-only` allows an all-read script and denies a change, before any approval", async () => {
    const run = setup()
    writeFileSync(join(root, "state.json"), "{}")
    const read = await run.create("read-only", readScript)
    expect((await readState(run.storage.storage, read.id)).approval?.approved).toBe("auto")
    expect(run.asserted).toHaveLength(0)
    await expect(run.create("read-only", writeScript)).rejects.toThrow(/JOBS_SCRIPT_DENIED: .*"read-only"/)
    await expect(run.create("read-only", readwriteFile("readwrite"))).rejects.toThrow("JOBS_SCRIPT_DENIED")
  })
})

test("an actual automatic approval becomes visible as unapproved or revoked after access changes (RR-2)", async () => {
  const setupRun = setup()
  const job = await setupRun.create("all", writeScript)
  expect((await readState(setupRun.storage.storage, job.id)).approval?.approved).toBe("auto")
  const clock = testClock(NOW, { instantBelow: 100 }).clock
  for (const [index, access] of (["ask-changes", "read-only"] as const).entries()) {
    const result = await execute({
      storage: setupRun.storage.storage,
      session: sessionFake().session,
      agents: { get: async () => ({ data: { id: "build", name: "build", permissions: ALLOW } }) } as never,
      clock,
      location: root,
      token: "leader-1",
      job,
      slot: NOW + index * 60_000,
      attempt: 1,
      late: false,
      active: () => true,
      scripts: setupRun.gate,
      tool: { list: async () => [] } as never,
      rpc: (() => ({})) as never,
      access,
    })
    expect(result.record?.reason).toBe(access === "ask-changes" ? "unapproved" : "revoked")
    const agent = agentsFake({ unguarded: ["build"], names: ["build"] })
    const report = createReport({ storage: setupRun.storage.storage, location: root, timezone: "UTC", clock, agent, host: { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }, enabled: true, keepAliveMinutes: 20, access, scripts: setupRun.gate })
    const input = { ...setupRun.input, report, assert: async () => undefined }
    const listed = await runJobTool(input, "list", {})
    const got = await runJobTool(input, "get", { id: job.id })
    const script = (listed.output["jobs"] as { script: { needsApproval: boolean; reason: string } }[])[0]!.script
    expect(got.output["script"]).toEqual(script)
    expect(script.needsApproval).toBe(access === "ask-changes")
    expect(script.reason).toContain(access === "ask-changes" ? `/jobs-approve ${job.id}` : "revoked")
  }
})

test("approval points to the full tool or file job definition, and get returns the long source and declared files (SR-5)", async () => {
  const setupRun = setup()
  const code = `// ${"x".repeat(9000)}\nreturn 1;`
  const script: Script = { code, uses: ["x.posts.write"], files: { state: { path: "state.json", mode: "read", format: "json", maxBytes: 2048 } } }
  writeFileSync(join(root, "state.json"), "{}")
  const toolJob = await setupRun.create("ask-changes", script)
  const toolRequest = setupRun.asserted[0] as { metadata: { where: string; truncated: boolean; script: string } }
  expect(toolRequest.metadata).toMatchObject({ where: `the jobs_get tool, job ${JSON.stringify(toolJob.id)}`, truncated: true })
  expect(toolRequest.metadata.script).toHaveLength(8192)
  const clock = testClock(NOW, { instantBelow: 0 }).clock
  const agent = agentsFake({ unguarded: ["build"], names: ["build"] })
  const report = createReport({ storage: setupRun.storage.storage, location: root, timezone: "UTC", clock, agent, host: { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }, enabled: true, keepAliveMinutes: 20, access: "ask-changes", scripts: setupRun.gate })
  const got = await runJobTool({ ...setupRun.input, report, assert: async () => undefined }, "get", { id: toolJob.id })
  expect(got.output["job"]).toMatchObject({ action: { type: "script", script } })
  expect(got.text).toContain("x".repeat(9000))
  expect(JSON.stringify(got.output["script"])).not.toContain("x".repeat(100))

  const projectJobs = join(root, ".opencode", "jobs")
  const globalJobs = join(root, "global-jobs")
  mkdirSync(projectJobs, { recursive: true })
  mkdirSync(globalJobs, { recursive: true })
  const projectPath = join(projectJobs, "project-script.md")
  const globalPath = join(globalJobs, "global-script.md")
  const contents = `---\nname: File script\nschedule: { every: 1h }\nagent: build\naction: ${JSON.stringify({ type: "script", script })}\n---\n`
  for (const path of [projectPath, globalPath]) writeFileSync(path, contents)
  const files = await readJobFiles({ now: NOW, timezone: "UTC", projects: [root], global: globalJobs })
  expect(files.invalid).toEqual([])
  expect(files.jobs.map((job) => job.sourcePath).sort()).toEqual([globalPath, projectPath].sort())
  const source = async () => ({ files, jobs: files.jobs, agents: [], known: true })
  for (const fileJob of files.jobs) {
    await approveJob({ ...setupRun.input, source, access: "ask-changes" }, fileJob.id, { sessionID: "ses_1", agent: "build" })
    const request = setupRun.asserted.at(-1) as { metadata: { where: string; truncated: boolean } }
    expect(request.metadata).toMatchObject({ where: `the job file ${JSON.stringify(fileJob.sourcePath)}`, truncated: true })
  }
})

describe("R18: the same policy for the ad-hoc jobs_run_script", () => {
  const once = (gate: ReturnType<typeof setup>["gate"], access: Access) =>
    runScriptOnce({
      definition: { code: "return tools.x.posts.write({});", uses: ["x.posts.write"] },
      sessionID: "ses_1",
      callerAgent: "build",
      gate,
      rpc: {} as never,
      tool: {} as never,
      agentDomain: {} as never,
      session: {} as never,
      clock: { now: () => NOW },
      location: root,
      access,
      job: { id: "script", name: "Script" },
    })

  test("`read-only` denies a change before any session or prompt", async () => {
    const run = setup()
    await expect(once(run.gate, "read-only")).rejects.toThrow(/JOBS_SCRIPT_DENIED: .*"read-only"/)
    expect(run.asserted).toHaveLength(0)
  })

  test("`ask-changes` with nobody to answer refuses with JOBS_UNCHECKED, and no second attempt leaks an internal error", async () => {
    const run = setup({ answer: "no" })
    await expect(once(run.gate, "ask-changes")).rejects.toThrow(/JOBS_UNCHECKED: .*needs a person's approval/)
    // The same call again is the same coded refusal, not a different failure from a half-created session.
    await expect(once(run.gate, "ask-changes")).rejects.toThrow(/JOBS_UNCHECKED: /)
  })
})
