// The Jelly declaration: the nine keys Jelly reads, the fourteen tools with the action, effect and read-only flag each
// one truly has, the one skill, and the `access` setting with Jelly's three choices. A declaration a reviewer can check
// against the live tool table without loading the plugin, and docs/jelly.md says the same.
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { DEFAULT_RULES, defaultRules, evaluate, type Rule } from "../../src/host/permissions.js"
import { ACCESS_VALUES, DEFAULT_OPTIONS, parseOptions } from "../../src/options.js"
import { CLASS_OF, DESCRIPTIONS, SCHEMAS, toolId, type ToolName } from "../../src/jobs/tools.js"
import { TUI_ID } from "../../src/constants.js"
import { declarationProblems, docProblems } from "../support/jelly-kit.js"
import { ACCESS_CHOICES, type PluginSetting, settingChoices, settingsProblems, settingValueIssue } from "../support/jelly-settings.js"

type DeclaredTool = { name: string; permission: string; effect: string; readOnly: boolean }
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  files: string[]
  jelly: Record<string, unknown> & { tools: DeclaredTool[]; skills: string[]; rpc: unknown[]; views: unknown[]; contributes: { settings: PluginSetting[] } & Record<string, unknown> }
}
const jelly = pkg.jelly
const ROOT = new URL("../../", import.meta.url)
const doc = readFileSync(new URL("../../docs/jelly.md", import.meta.url), "utf8")
const BASE_ALLOW: Rule = { action: "*", resource: "*", effect: "allow" }
/** Every tool the plugin registers, in the order it registers them. */
const REGISTERED = Object.keys(SCHEMAS) as ToolName[]

describe("the jelly declaration", () => {
  // The shared kit checks the declaration against Jelly's plugin authors' standard; the tests below add what only Jobs
  // declares.
  test("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    const effectOf = (permission: string) => evaluate([BASE_ALLOW, ...DEFAULT_RULES], permission)
    expect(declarationProblems(ROOT, { effectOf, registered: REGISTERED.map(toolId) })).toEqual([])
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
    const { settings, ...rest } = jelly.contributes
    expect(rest as Record<string, unknown>).toEqual({ homeFeeds: [], homeWidgets: [], workKinds: [] })
    expect(settings).toHaveLength(1)
    expect(jelly.skills).toEqual(["jobs"])
  })

  test("equals the tool registry: every registered tool, in order, with its true read-only flag, and nothing else", () => {
    // The registry is the tool table the plugin hands the host (`SCHEMAS`), and `CLASS_OF` is what each tool does: a
    // read changes nothing; a pause, like every other tool, changes a job's state, so it is not read-only.
    expect(jelly.tools).toEqual(
      REGISTERED.map((name) => ({ name: toolId(name).replace("_", "."), permission: toolId(name), effect: "allow", readOnly: CLASS_OF[name] === "read" })),
    )
    expect(jelly.tools).toHaveLength(14)
    expect(jelly.tools.filter((tool) => tool.readOnly).map((tool) => tool.name)).toEqual(["jobs.status", "jobs.list", "jobs.get", "jobs.history"])
    for (const name of REGISTERED) expect(DESCRIPTIONS[name]).toBeString()
  })

  test("allows every tool at the default access, as the plugin's own default rules do (OD-29)", () => {
    expect(DEFAULT_OPTIONS.access).toBe("all")
    for (const tool of jelly.tools) expect({ tool: tool.name, effect: evaluate([BASE_ALLOW, ...DEFAULT_RULES], tool.permission) }).toEqual({ tool: tool.name, effect: "allow" })
  })

  test("declares exactly the skills the package ships, and the TUI part the package loads", () => {
    // `files` is what is packed; every declared skill must live under it and exist on disk.
    expect(pkg.files).toContain("skills")
    const shipped = readdirSync(new URL("../../skills", import.meta.url), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    expect(jelly.skills.slice().sort()).toEqual(shipped.sort())
    for (const name of jelly.skills) expect(existsSync(new URL(`../../skills/${name}/SKILL.md`, import.meta.url))).toBe(true)
    expect(TUI_ID).toBe("jobs.scheduler.tui")
  })
})

describe("the settings Jelly shows", () => {
  const settings = jelly.contributes.settings
  const access = settings.find((setting) => setting.key === "access")!
  const accepts = (options: Record<string, unknown>) => {
    try {
      parseOptions(options)
      return true
    } catch {
      return false
    }
  }

  test("Jelly's setting schema reads them, and access is the only one", () => {
    expect(settingsProblems(settings)).toEqual([])
    expect(settings.map((setting) => setting.key)).toEqual(["access"])
  })

  test("access offers Jelly's three choices, word for word, defaults to all, and the parser takes exactly those", () => {
    expect(access).toMatchObject({ label: "Access", type: "string", default: DEFAULT_OPTIONS.access })
    expect(access.choices).toEqual(ACCESS_CHOICES)
    expect(settingChoices(access)?.map((choice) => choice.value)).toEqual([...ACCESS_VALUES])
    for (const { value } of ACCESS_CHOICES) expect(accepts({ access: value })).toBe(true)
    for (const value of ["read", "write", "none", "ALL"]) {
      expect(settingValueIssue(access, value)).not.toBeNull()
      expect(accepts({ access: value })).toBe(false)
    }
  })

  test("each access value gives the jobs_* pattern the family's effect", () => {
    const expected = { all: "allow", "ask-changes": "ask", "read-only": "deny" } as const
    for (const value of ACCESS_VALUES) expect(evaluate([BASE_ALLOW, ...defaultRules(value)], "jobs_added_later")).toBe(expected[value])
  })
})

describe("docs/jelly.md", () => {
  test("its table is the declaration, row for row", () => {
    const rows = [...doc.matchAll(/^\| `(jobs\.[a-z_]+)` \| `(jobs_[a-z_]+)` \| (allow|ask|deny) \| (yes|no) \|$/gm)].map((match) => ({
      name: match[1],
      permission: match[2],
      effect: match[3],
      readOnly: match[4] === "yes",
    }))
    expect(rows).toEqual(jelly.tools)
  })

  test("names the setting and its three choices, and says scripts follow access", () => {
    for (const choice of ACCESS_CHOICES) expect(doc).toContain(`\`${choice.value}\` ("${choice.label}")`)
    expect(doc).toContain("`jobs_script`")
    expect(doc).not.toMatch(/no Home feed, widget, work kind or setting/)
    expect(doc).not.toMatch(/reads and pauses run/)
  })
})
