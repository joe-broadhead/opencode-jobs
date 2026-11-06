// The TUI part: one palette command that opens the dialog, `r` and `p` inside it, and the three states the dialog
// renders. The render itself runs against the built bundle on OpenTUI 0.8's test renderer (test/tui-renderer.mjs).
import { beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dialogText, keysLine, viewOf } from "../../src/tui.js"
import { buildStatus } from "../../src/status.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const DIST = `${ROOT}/dist/tui.js`

beforeAll(() => {
  const built = spawnSync("node", ["scripts/check.mjs", "build"], { cwd: ROOT, encoding: "utf8" })
  if (built.status !== 0) throw new Error(`build failed: ${built.stderr}`)
})

describe("the dialog's text", () => {
  const facts = { host: { version: "2.2.5", range: ">=2.2.3 <2.3.0", tested: true }, enabled: true, keepAliveMinutes: 20 }

  test("is the report without its heading, or why there is none", () => {
    const text = dialogText({ state: "ready", status: buildStatus(facts) })
    expect(text).toStartWith("- Runner: no leader yet")
    expect(text).toContain("- Jobs: none yet")
    expect(text).toContain("- Next step: Nothing to do.")
    expect(text).not.toContain("Jobs status")
    expect(dialogText({ state: "loading" })).toBe("Reading the job status…")
    expect(dialogText({ state: "unavailable", message: "STATUS_UNAVAILABLE: no.", nextStep: "Restart OpenCode." })).toBe("STATUS_UNAVAILABLE: no.\n\nNext step: Restart OpenCode.")
  })

  test("names exactly the standard's keys, because the kill switch is a palette command that asks", () => {
    expect(keysLine()).toBe("r refresh · esc close")
  })

  test("keeps the RPC's coded next step, and falls back to the restart step", () => {
    expect(viewOf({ type: "unavailable", message: "STATUS_UNAVAILABLE: no.", data: { nextStep: "Try again." } })).toEqual({
      state: "unavailable",
      message: "STATUS_UNAVAILABLE: no.",
      nextStep: "Try again.",
    })
    expect(viewOf(new Error("boom"))).toMatchObject({ state: "unavailable", nextStep: "Restart OpenCode, then run /jobs-status again." })
  })
})

describe("the built TUI part", () => {
  test("is one plain JavaScript file that imports only host-provided modules", () => {
    expect(existsSync(DIST)).toBe(true)
    expect(readdirSync(`${ROOT}/dist`).filter((file) => file.endsWith(".tsx"))).toEqual([])
    const code = readFileSync(DIST, "utf8")
    const imports = [...code.matchAll(/^import\b[^;]*?\bfrom\s*"([^"]+)"/gm)].map((match) => match[1])
    expect([...new Set(imports)].sort()).toEqual(["@opencode/plugin/rpc", "@opencode/plugin/tui", "@opentui/core", "@opentui/solid", "solid-js"])
    // Node parses no JSX, so this fails if any is left in the bundle.
    const syntax = spawnSync(process.execPath, ["--check", DIST], { encoding: "utf8" })
    expect(syntax.status, syntax.stderr).toBe(0)
  })

  test("renders the empty, healthy and stopped states, and answers r, p and esc", () => {
    const result = spawnSync("bun", ["--conditions=browser", "test/tui-renderer.mjs"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 })
    expect(result.error, "Bun must be on PATH").toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain("PASS dist/tui.js renders the empty, healthy and stopped states")
  }, 150_000)
})
