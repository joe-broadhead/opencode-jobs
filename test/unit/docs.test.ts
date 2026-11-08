// The docs must match the code: every error code the plugin raises has a documented row and no other, the read-only
// agent block is the same in the README and the configuration guide, and a link to a repository file is absolute.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"
import { parseScriptDefinition } from "../../src/jobs/model.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
// Everything a user or the model reads about the current release.
const FILES = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "AGENTS.md", ...files("docs"), ...files("skills")]
const text = (file: string) => readFileSync(join(ROOT, file), "utf8").replace(/\r\n/g, "\n")
const flat = (file: string) => text(file).replace(/\s+/g, " ")

/** The codes `jobsError` and `errorText` are called with in src/: the plugin's own, by construction. */
function raised(): string[] {
  const sources = files("src").filter((name) => name.endsWith(".ts"))
  // The job model raises its codes through `fail`, which builds a JobInputError, so every JOBS_ literal it holds counts;
  // the tools RPC has its own `fail` and its own codes, which scripting.md documents.
  // The bare literal and the `"CODE: message"` form the runtime's reason strings use.
  const job = /"(JOBS_[A-Z_]+)(?:"|:)/g
  const shared = /(?:jobsError|errorText)\(\s*"([A-Z][A-Z_]+)"/g
  const found = sources.flatMap((name) => [...text(name).matchAll(name.startsWith("src/jobs/") ? job : shared)].map((match) => match[1]!))
  return [...new Set(found)].sort()
}

/** Every file under a folder, relative to the repository. */
function files(folder: string): string[] {
  return readdirSync(join(ROOT, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`
    return entry.isDirectory() ? files(path) : [path]
  })
}

const errorsSection = () => /## Errors\n([\s\S]*?)(?:\n## |\s*$)/.exec(text("docs/configuration.md"))?.[1] ?? ""

/** The read-only agent block's rule lines, in order, from a fenced JSON example. */
const agentBlock = (file: string) => {
  const fence = /```json\n(\{[\s\S]*?\n\})\n```/g
  for (const [, body] of text(file).matchAll(fence)) {
    if (!body.includes('"agents"')) continue
    const config = JSON.parse(body) as { agents: Record<string, { permissions: { action: string; effect: string }[] }> }
    const rules = Object.values(config.agents)[0]!.permissions
    return rules.map((rule) => `        { "action": ${JSON.stringify(rule.action)}, "resource": "*", "effect": ${JSON.stringify(rule.effect)} }`)
  }
  return undefined
}

describe("docs", () => {
  test("the configuration guide documents every code the plugin raises, and no other", () => {
    const codes = raised()
    expect(codes.length).toBeGreaterThan(2)
    const errors = errorsSection()
    for (const code of codes) {
      expect(code).not.toStartWith("JOBS_SCHEDULER_")
      expect({ code, documented: errors.includes(`| \`${code}\` |`) }).toEqual({ code, documented: true })
    }
    const documented = [...errors.matchAll(/\| `([A-Z][A-Z_]+)` \|/g)].map((match) => match[1]!)
    expect(documented.filter((code) => !codes.includes(code))).toEqual([])
  })

  test.each(["README.md", "docs/configuration.md", "docs/scripting.md", "SECURITY.md"])("%s says nothing provisional or pending", (file) => {
    expect(flat(file)).not.toMatch(/provisional|not yet (?:checked|published|signed|built)|private package|TODO/i)
  })

  test("no doc names the plugin's version or a tag", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }
    for (const file of FILES.filter((name) => name !== "CHANGELOG.md")) {
      expect({ file, version: flat(file).includes(pkg.version) }).toEqual({ file, version: false })
      expect({ file, tag: /opencode-jobs@\d/.test(flat(file)) }).toEqual({ file, tag: false })
    }
  })

  test("the README and the configuration guide give the same read-only agent block, blanket deny first", () => {
    const readme = agentBlock("README.md")
    expect(readme).toBeDefined()
    expect(agentBlock("docs/configuration.md")).toEqual(readme)
    expect(readme![0]).toBe('        { "action": "*", "resource": "*", "effect": "deny" }')
    for (const action of ["read", "glob", "grep", "list", "jobs_status", "jobs_list", "jobs_get", "jobs_history", "jobs_pause"]) {
      expect({ action, allowed: readme!.some((line) => line.includes(`"${action}"`) && line.endsWith('"effect": "allow" }')) }).toEqual({ action, allowed: true })
    }
  })

  test("the scripting guide names the tools RPC, its describe method, the two routes and the script action", () => {
    const guide = flat("docs/scripting.md")
    expect(guide).toContain("`<plugin id>.tools`")
    expect(guide).toContain("`describe`")
    expect(guide).toContain("`host:mem_remember`")
    expect(guide).toContain("opencode api post /api/rpc/x.posts.tools/describe")
    expect(guide).toContain("## The `script` action")
    expect(guide).toContain("x-opencode-directory")
    expect(guide).toContain("scriptBudgetUsd")
    expect(guide).toContain("X_BUDGET")
  })

  test("the configuration guide names both RPCs and the shared status fields", () => {
    const guide = flat("docs/configuration.md")
    for (const name of ["`jobs.scheduler`", "`jobs.scheduler.tools`", "`status`, `list`, `history`"]) expect(guide).toContain(name)
    for (const field of ["`version`", "`host`", "`state`", "`unguardedAgents`", "`nextStep`"]) expect(guide).toContain(field)
  })

  test("every script example parses with the real parser, and none names the guarded jobs profile", () => {
    let examples = 0
    for (const file of ["README.md", "docs/scripting.md", "docs/configuration.md", "skills/jobs/SKILL.md"]) {
      for (const [, block] of text(file).matchAll(/```(?:ya?ml|markdown)\n([\s\S]*?)```/g)) {
        if (!/["']?type["']?\s*:\s*["']?script/.test(block)) continue
        examples += 1
        // A full job file is front matter; a fragment is the action itself.
        const body = block.replace(/^---\n/, "").replace(/\n---\s*$/, "")
        const parsed = parse(body) as { agent?: unknown; action?: { type?: unknown; script?: unknown } }
        expect({ file, agent: parsed.agent }).not.toEqual({ file, agent: "jobs" })
        expect(() => parseScriptDefinition(parsed.action?.script)).not.toThrow()
      }
    }
    // The two walkthroughs and the configuration fragment are examples; if the docs lose them, the test must notice.
    expect(examples).toBeGreaterThanOrEqual(2)
  })

  test("under the default access no model-facing guide claims a tool asks (VERIFY item 16)", () => {
    for (const file of ["skills/jobs/SKILL.md", "docs/jelly.md"]) {
      for (const line of text(file).split("\n")) {
        const falseClaim = /\basks\b/.test(line) && !line.includes("ask-changes") && !line.includes("agent asks")
        expect({ file, line, falseClaim }).toEqual({ file, line, falseClaim: false })
      }
    }
  })

  test("the README names every code the plugin raises in its troubleshooting table, and no other", () => {
    const readme = /## Troubleshooting\n([\s\S]*?)\n## /.exec(text("README.md"))?.[1] ?? ""
    const rows = [...readme.matchAll(/\| `([A-Z][A-Z_]+)` \|/g)].map((match) => match[1]!)
    expect([...new Set(rows)].sort()).toEqual(raised())
  })

  test("the README's Uninstall removes the plugin, and its commands are the ones the plugin registers", () => {
    const uninstall = /## Uninstall\n([\s\S]*?)## Links/.exec(text("README.md"))?.[1] ?? ""
    expect(uninstall).toContain("opencode plugin remove @joe-broadhead/opencode-jobs")
    expect(flat("README.md")).toContain("`/jobs-status`")
    expect(flat("README.md")).toContain("Jobs: Status")
  })

  test("every link to a repository file is absolute, on the default branch", () => {
    for (const file of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "docs/configuration.md", "docs/scripting.md"]) {
      const targets = [...text(file).matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!)
      const local = targets.filter((target) => !/^(?:https?:|#)/.test(target))
      expect({ file, local }).toEqual({ file, local: [] })
      const repoLinks = targets.filter((target) => target.startsWith("https://github.com/joe-broadhead/opencode-jobs/") && !target.includes("/blob/HEAD/"))
      expect({ file, repoLinks }).toEqual({ file, repoLinks: [] })
    }
  })
})
