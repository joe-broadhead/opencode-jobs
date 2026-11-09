// The confined runtime: QuickJS-WASI with no host capabilities, a manifest-only bridge, and the four limits. These run
// in Bun directly, with no host, so a failure here is the runtime's own.
import { describe, expect, test } from "bun:test"
import { quickjsWasm, runScript, type ScriptBridge } from "../../src/jobs/script-runtime.js"
import { SCRIPT_DEFAULTS, type ScriptLimits } from "../../src/jobs/script.js"

const run = (code: string, options: { bridge?: ScriptBridge; allowed?: string[]; limits?: Partial<ScriptLimits>; timeoutMs?: number; signal?: AbortSignal; files?: { values: Record<string, unknown>; writable: ReadonlyMap<string, number> }; classes?: ReadonlyMap<string, string> } = {}) =>
  runScript({
    code,
    allowed: new Set(options.allowed ?? ["host:mem"]),
    limits: { ...SCRIPT_DEFAULTS, ...options.limits },
    timeoutMs: options.timeoutMs ?? 5_000,
    bridge: options.bridge ?? (async () => ({ ok: true })),
    now: () => Date.now(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.files === undefined ? {} : { files: options.files }),
    ...(options.classes === undefined ? {} : { classes: options.classes }),
  })

describe("the script runtime", () => {
  test("exposes the declared files frozen, buffers writes, and refuses a name that is not writable", async () => {
    const result = await run(
      `let frozen = ""; try { files.state.n = 99 } catch (e) { frozen = String(e) } const before = files.state.n; await files.write("state", { n: 2 }); let error = ""; try { await files.write("ro", {}) } catch (e) { error = String(e) } return { frozen, before, error }`,
      { files: { values: { state: { n: 1 } }, writable: new Map([["state", 1024]]) } },
    )
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ frozen: expect.stringContaining("TypeError"), before: 1, error: expect.stringContaining("JOBS_SCRIPT_FILE_MODE") })
    expect(result.writes).toEqual([{ name: "state", json: '{"n":2}' }])
  })

  test("a structured host error never reaches the record: the code and a next step, never [object Object] (RR-8)", async () => {
    const result = await run(`return await tools.host.mem({})`, {
      bridge: async () => {
        throw { name: "AbortError", message: "All fibers interrupted\nstack line" }
      },
    })
    expect(result.ok).toBe(false)
    expect(result.error).not.toContain("[object Object]")
    expect(result.error).not.toContain("AbortError")
    expect(result.error).not.toContain("All fibers interrupted")
    expect(result.error).not.toContain("stack line")
    expect(result.error).toContain("JOBS_SCRIPT_INTERRUPTED")
    expect(result.calls[0]).toMatchObject({ method: "host:mem", outcome: "error" })
    expect(result.error).toContain("Next step:")
    expect(result.limits.interrupted).toBe(true)
    expect(result.limits.timedOut).toBe(false)
  })

  test("a call refused for external_directory carries the code and an allow hint (GAP-17)", async () => {
    const result = await run(`return await tools.host.mem({})`, {
      bridge: async () => {
        throw new Error("permission.rejected: external_directory /srv/out")
      },
      classes: new Map([["host:mem", "unclassified"]]),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain("`external_directory` allow")
    expect(result.calls[0]).toMatchObject({ method: "host:mem", class: "unclassified", outcome: "error", code: "permission.rejected" })
  })

  test("does not put an arbitrary upper-case token in the record's code (DF-17)", async () => {
    const result = await run(`return await tools.host.mem({})`, {
      bridge: async () => {
        throw new Error("SECRET_TOKEN: not a family code")
      },
    })
    expect(result.ok).toBe(false)
    expect(result.calls[0]?.code).toBeUndefined()
  })

  test("has the wasm it ships, and gives the guest no host capability", async () => {
    expect(quickjsWasm().byteLength).toBeGreaterThan(600_000)
    const result = await run(`return {
      fetch: typeof fetch, require: typeof require, process: typeof process, Bun: typeof Bun, Deno: typeof Deno,
      setTimeout: typeof setTimeout, setInterval: typeof setInterval, tools: typeof tools, host: typeof tools.host, mem: typeof tools.host.mem,
    }`)
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ fetch: "undefined", require: "undefined", process: "undefined", Bun: "undefined", Deno: "undefined", setTimeout: "undefined", setInterval: "undefined", tools: "function", host: "function", mem: "function" })
  })

  test("returns the script's value through the bridge, and refuses a method outside the manifest without calling it", async () => {
    const seen: unknown[] = []
    const result = await run(
      `const answer = await tools.host.mem({ content: "from-a-script" }); return { answer, again: await tools.host.mem({ content: "2" }) }`,
      { bridge: async (method, input) => (seen.push([method, input]), { ok: true, method }) },
    )
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ answer: { ok: true, method: "host:mem" }, again: { ok: true, method: "host:mem" } })
    expect(seen).toEqual([["host:mem", { content: "from-a-script" }], ["host:mem", { content: "2" }]])
    expect(result.calls).toHaveLength(2)
    expect(result.calls[0]).toMatchObject({ method: "host:mem", outcome: "ok" })
    // The record has no payloads: only the method, times, outcome and bytes.
    expect(Object.keys(result.calls[0]!).sort()).toEqual(["at", "bytes", "method", "ms", "outcome"])

    const refused = await run(`return await tools.host.other({})`)
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain("JOBS_SCRIPT_UNKNOWN_TOOL")
    expect(refused.calls[0]).toMatchObject({ method: "host:other", outcome: "refused" })
  })

  test("reserves the call cap at dispatch, so a burst of unawaited calls cannot pass it", async () => {
    // SR-1: the cap is checked synchronously in __call. Fifty calls fired at once with a cap of one dispatch once.
    for (const [burst, cap] of [[50, 1], [1000, 100]] as const) {
      const dispatched: number[] = []
      const result = await run(`const p = []; for (let i = 0; i < ${burst}; i += 1) p.push(tools.host.mem({ i })); await Promise.all(p); return "done"`, {
        bridge: async (_method, input) => {
          dispatched.push(Number((input as { i: number }).i))
          return { ok: true }
        },
        limits: { maxCalls: cap },
        timeoutMs: 10_000,
      })
      expect(result.limits.callLimit).toBe(true)
      expect(dispatched).toHaveLength(cap)
      // Every dispatched call has a row: the cap, then one refused row for each call past it. The interrupt stops the
      // guest at its next bytecode, so the burst may not reach every iteration; the bridge count is what must hold.
      expect(result.calls.length).toBeGreaterThanOrEqual(cap)
      expect(result.calls.length).toBeLessThanOrEqual(burst)
      // A dispatched call is not "refused": the cap's rows are exactly the cap, whatever their result did when the
      // interrupt ended the run.
      expect(result.calls.filter((call) => call.outcome !== "refused")).toHaveLength(cap)
      expect(result.calls.filter((call) => call.outcome === "refused")).toHaveLength(result.calls.length - cap)
      expect(result.ok).toBe(false)
    }
  }, 30_000)

  test("stops at the output limit and the wall clock, and truncates by bytes with a marker", async () => {
    const output = await run(`return "${"\u00e9".repeat(2048)}"`, { limits: { maxOutputBytes: 256 } })
    expect(output.outputTruncated).toBe(true)
    expect(output.limits.outputTruncated).toBe(true)
    // A valid JSON value, not a string cut mid-token: the byte length and a marker.
    expect(output.value).toMatchObject({ truncated: true, note: expect.stringContaining("limit") })
    expect((output.value as { bytes: number }).bytes).toBeGreaterThan(256)

    const clock = await run("for (;;) {}", { timeoutMs: 250 })
    expect(clock.ok).toBe(false)
    expect(clock.limits.timedOut).toBe(true)
    expect(clock.limits.interrupted).toBe(false)
    expect(clock.error).toContain("JOBS_SCRIPT_LIMIT")
  }, 30_000)

  test("trips the memory limit, and reports a thrown script as a failure with one bounded line", async () => {
    const memory = await run(`const a = []; for (;;) { a.push(new Array(1_000_000).fill(7)) }`, { limits: { memoryMb: 16 }, timeoutMs: 5_000 })
    expect(memory.ok).toBe(false)
    expect(memory.limits.memoryExceeded).toBe(true)

    const thrown = await run(`throw new Error("boom\\nsecond line")`)
    expect(thrown.ok).toBe(false)
    expect(thrown.error).toStartWith("JOBS_SCRIPT_FAILED: the script failed.")
    expect(thrown.error).not.toContain("boom")
    expect(thrown.error).not.toContain("second line")
    expect(thrown.error!.length).toBeLessThan(400)
  }, 20_000)

  test("a script's thrown text never reaches the run's error; a failed call keeps only its code (RR-8)", async () => {
    const secret = "CONFIDENTIAL_ROW_42"
    const thrown = await run(`throw new Error("${secret}")`)
    expect(thrown.ok).toBe(false)
    expect(thrown.error).toBe("JOBS_SCRIPT_FAILED: the script failed. Next step: Check the run's calls for the code of a failed call, fix the script or its tools, then approve it again if it changed.")
    expect(JSON.stringify(thrown)).not.toContain(secret)

    const failedCall = await run(`return await tools.host.mem({})`, {
      bridge: async () => {
        throw new Error(`JOBS_TOOL_FAILED: ${secret} in the file body`)
      },
    })
    expect(failedCall.ok).toBe(false)
    expect(failedCall.calls[0]).toMatchObject({ method: "host:mem", outcome: "error", code: "JOBS_TOOL_FAILED" })
    expect(JSON.stringify(failedCall)).not.toContain(secret)
  })

  test("aborts an in-flight call when the cleanup signal fires", async () => {
    const controller = new AbortController()
    let sawAbort = false
    const bridge: ScriptBridge = (_method, _input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          sawAbort = true
          reject(new Error("aborted"))
        })
      })
    const pending = run(`return await tools.host.mem({})`, { bridge, signal: controller.signal, timeoutMs: 10_000 })
    setTimeout(() => controller.abort(), 100)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(sawAbort).toBe(true)
    // A kill switch is an interruption, not a timeout, and its in-flight call is aborted (D2).
    expect(result.limits.timedOut).toBe(false)
    expect(result.limits.interrupted).toBe(true)
    expect(result.error).toContain("JOBS_SCRIPT_INTERRUPTED")
    expect(result.calls[0]).toMatchObject({ method: "host:mem", outcome: "aborted" })
  }, 20_000)
})
