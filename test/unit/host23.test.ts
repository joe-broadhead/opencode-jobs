// OpenCode 2.3.0: a subagent always runs in the background, and a person's Stop aborts a tool's signal. A run is done
// only when its session is idle with no subagent or shell of its own still running, and a stopped one-off script ends
// as interrupted with nothing written.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { forgetBackground, hasBackground, noteIdle, settle } from "../../src/jobs/background.js"
import { forgetJobSession, rememberJobSession } from "../../src/jobs/safety.js"
import { createScriptGate, type ScriptHost } from "../../src/jobs/script-gate.js"
import { runScriptOnce } from "../../src/jobs/script-oneoff.js"
import { runJobTool, type ToolInput } from "../../src/jobs/tools.js"
import { sessionFake } from "./fake.js"

const NOW = Date.UTC(2026, 10, 15, 9, 0, 0)
const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "jobs-host23-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A `wait` that resolves when the test says the session went idle. */
function waits() {
  const pending: (() => void)[] = []
  let calls = 0
  const session = {
    wait: () => {
      calls += 1
      return new Promise<void>((resolve) => pending.push(resolve))
    },
  } as unknown as Pick<Plugin.Context["session"], "wait">
  const idle = () => {
    for (const release of pending.splice(0)) release()
  }
  return { session, idle, calls: () => calls }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("a run waits for its own background work (2.3.0 runs every subagent in the background)", () => {
  test("idle with a subagent of its own still running is not done; the next idle with none is", async () => {
    const id = "ses_bg_1"
    rememberJobSession(id)
    const fake = waits()
    let done = false
    const settled = settle(fake.session, id).then(() => {
      done = true
    })
    noteIdle({ sessionID: id, background: [{ kind: "subagent", sessionID: id }] })
    fake.idle()
    await tick()
    expect(hasBackground(id)).toBe(true)
    expect(done).toBe(false)
    // The subagent's notice wakes the session; its next idle lists nothing of its own.
    noteIdle({ sessionID: id, background: [] })
    await tick()
    fake.idle()
    await settled
    expect(done).toBe(true)
    expect(fake.calls()).toBe(2)
    expect(hasBackground(id)).toBe(false)
    forgetJobSession(id)
  })

  test("work a descendant owns, or an image, does not hold the run; a person's session is never tracked", async () => {
    const id = "ses_bg_2"
    rememberJobSession(id)
    noteIdle({ sessionID: id, background: [{ kind: "shell", sessionID: "ses_child" }, { kind: "image", sessionID: id }] })
    expect(hasBackground(id)).toBe(false)
    noteIdle({ sessionID: "ses_person", background: [{ kind: "subagent", sessionID: "ses_person" }] })
    expect(hasBackground("ses_person")).toBe(false)
    const fake = waits()
    const settled = settle(fake.session, id)
    fake.idle()
    await settled
    expect(fake.calls()).toBe(1)
    forgetJobSession(id)
  })

  test("forgetting a session releases a wait for its background work", async () => {
    const id = "ses_bg_3"
    rememberJobSession(id)
    noteIdle({ sessionID: id, background: [{ kind: "shell", sessionID: id }] })
    const fake = waits()
    const settled = settle(fake.session, id)
    fake.idle()
    await tick()
    forgetBackground(id)
    await tick()
    fake.idle()
    await settled
    expect(hasBackground(id)).toBe(false)
    forgetJobSession(id)
  })
})

describe("a stop reaches a one-off script (2.3.0 aborts a tool's signal on Stop)", () => {
  test("jobs_run_script hands the call's signal to the runner", async () => {
    const controller = new AbortController()
    let given: AbortSignal | undefined
    const input = {
      runScriptOnce: async (_definition: unknown, _call: unknown, signal?: AbortSignal) => {
        given = signal
        return { ok: true, value: 1, calls: [], limits: {}, digest: "d", approval: {} as never, files: [] }
      },
    } as unknown as ToolInput
    await runJobTool(input, "run_script", { code: "return 1;", uses: [] }, { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal: controller.signal })
    expect(given).toBe(controller.signal)
  })

  test("a stopped script ends as interrupted, and its declared file is not written", async () => {
    writeFileSync(join(root, "state.json"), JSON.stringify({ n: 1 }))
    const host: ScriptHost = {
      rpc: ((definition: { id?: string }) => ({
        describe: async () => ({ id: "x.posts.tools", methods: String(definition?.id ?? "").startsWith("x.posts") ? [{ name: "read", action: "x_read", class: "read" }] : [] }),
      })) as unknown as Plugin.Context["rpc"],
      tool: { list: async () => [] } as never,
      agent: { get: async () => ({ data: { id: "build", name: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] } }) } as never,
      plugin: { list: async () => ({ data: [{ id: "x.posts" }] }) } as never,
      mcp: { list: async () => ({ data: [] }) } as never,
      location: root,
      permission: { assert: async () => undefined },
      now: () => NOW,
    }
    const stopped = new AbortController()
    stopped.abort()
    const result = await runScriptOnce({
      definition: { code: 'files.write("state", { n: 2 }); return 1', uses: ["x.posts.read"], files: { state: { path: "state.json", mode: "readwrite", format: "json" } } },
      sessionID: "ses_1",
      callerAgent: "build",
      gate: createScriptGate(host),
      rpc: host.rpc,
      tool: host.tool,
      agentDomain: host.agent,
      session: sessionFake().session,
      clock: { now: () => NOW },
      location: root,
      access: "all",
      job: { id: "script", name: "Script" },
      signal: stopped.signal,
    })
    expect(result.ok).toBe(false)
    expect(result.limits.interrupted).toBe(true)
    expect(result.files.map((file) => file.bytesWritten)).toEqual([0])
    expect(JSON.parse(readFileSync(join(root, "state.json"), "utf8"))).toEqual({ n: 1 })
  })
})
