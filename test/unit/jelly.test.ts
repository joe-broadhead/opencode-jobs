// The Jelly declaration: the nine keys Jelly reads, the fourteen tools with the action and effect each one has, and the
// one skill. A declaration a reviewer can check against the live tool table without loading the plugin.
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { DEFAULT_RULES, evaluate } from "../../src/host/permissions.js"
import { DESCRIPTIONS, SCHEMAS, toolId, type ToolName } from "../../src/jobs/tools.js"
import { TUI_ID } from "../../src/constants.js"
import { declarationProblems, docProblems } from "../support/jelly-kit.js"

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  files: string[]
  jelly: Record<string, unknown> & { tools: { name: string; permission: string; effect: string; readOnly: boolean }[]; skills: string[]; rpc: unknown[]; views: unknown[] }
}
const jelly = pkg.jelly
const ROOT = new URL("../../", import.meta.url)
const READ: readonly string[] = ["status", "list", "get", "history"]
const PAUSE: readonly string[] = ["pause", "pause_all"]

describe("the jelly declaration", () => {
  // The shared kit checks the declaration against Jelly's plugin authors' standard; the tests below add what only Jobs
  // declares.
  test("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    const registered = (Object.keys(SCHEMAS) as ToolName[]).map(toolId)
    const effectOf = (permission: string) => evaluate([{ action: "*", resource: "*", effect: "allow" }, ...DEFAULT_RULES], permission)
    expect(declarationProblems(ROOT, { effectOf, registered })).toEqual([])
    expect(docProblems(ROOT)).toEqual([])
  })

  test("has the nine keys Jelly reads, and nothing it would refuse", () => {
    expect(Object.keys(jelly).sort()).toEqual(["contributes", "icon", "rpc", "signIns", "skills", "summary", "title", "tools", "views"].sort())
    expect(jelly.title).toBe("Jobs")
    expect(jelly.summary).toBeString()
    expect(jelly.icon).toBe("assets/icon.svg")
    expect(pkg.files).toContain("assets/icon.svg")
    expect(existsSync(new URL("../../assets/icon.svg", import.meta.url))).toBe(true)
    expect(jelly.rpc).toEqual([])
    expect(jelly.views).toEqual([])
    expect(jelly.signIns).toEqual([])
    expect(jelly.contributes).toEqual({ homeFeeds: [], homeWidgets: [], workKinds: [], settings: [{ key: "access", label: "Access", type: "string", default: "all", description: "all, ask-changes or read-only. all allows every jobs tool; ask-changes asks before a change; read-only denies every change." }] })
    expect(jelly.skills).toEqual(["jobs"])
  })

  test("lists exactly the fourteen tools, each with the action the default rules name", () => {
    const tools = jelly.tools
    expect(tools).toHaveLength(14)
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(14)
    for (const name of Object.keys(SCHEMAS) as ToolName[]) {
      const id = toolId(name)
      const entry = tools.find((tool) => tool.permission === id)
      expect({ id, listed: entry !== undefined }).toEqual({ id, listed: true })
      expect(entry!.name).toBe(id.replace("_", "."))
      expect(entry!.effect).toBe(evaluate(DEFAULT_RULES, id))
      expect(entry!.readOnly).toBe(READ.includes(name))
      expect(DESCRIPTIONS[name]).toBeString()
    }
    for (const name of PAUSE) expect(tools.find((tool) => tool.permission === `jobs_${name}`)!.effect).toBe("allow")
    // A write is never read-only, and the default access (`all`) allows it like every other plugin's tools.
    for (const name of Object.keys(SCHEMAS) as ToolName[]) {
      if (READ.includes(name) || PAUSE.includes(name)) continue
      const entry = tools.find((tool) => tool.permission === toolId(name))!
      expect({ name, effect: entry.effect, readOnly: entry.readOnly }).toEqual({ name, effect: "allow", readOnly: false })
    }
  })

  test("declares exactly the skills the package ships, and the TUI part the package loads", () => {
    // `files` is what npm packs; every declared skill must live under it and exist on disk.
    expect(pkg.files).toContain("skills")
    const shipped = readdirSync(new URL("../../skills", import.meta.url), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    expect(jelly.skills.slice().sort()).toEqual(shipped.sort())
    for (const name of jelly.skills) expect(existsSync(new URL(`../../skills/${name}/SKILL.md`, import.meta.url))).toBe(true)
    expect(TUI_ID).toBe("jobs.scheduler.tui")
  })
})
