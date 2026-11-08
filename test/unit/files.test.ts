import { describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { readJobFiles, type AgentGuard } from "../../src/jobs/files.js"

const FIXTURES = fileURLToPath(new URL("../fixtures/jobs/", import.meta.url))
const NOW = Date.UTC(2026, 11, 6, 12, 0, 0)
const PROJECT = join(FIXTURES, "project")
const GLOBAL = join(FIXTURES, "global")
const read = (overrides: { projects?: string[]; global?: string; timezone?: string; guard?: AgentGuard } = {}) =>
  readJobFiles({
    now: NOW,
    timezone: "UTC",
    projects: overrides.projects ?? [PROJECT],
    global: overrides.global ?? GLOBAL,
    ...(overrides.timezone === undefined ? {} : { timezone: overrides.timezone }),
    ...(overrides.guard === undefined ? {} : { guard: overrides.guard }),
  })

describe("job files", () => {
  test("a project file's flat schedule, zone, agent and policy are read, and the body is the prompt", async () => {
    const { jobs } = await read()
    const morning = jobs.find((job) => job.id === "morning")!
    expect(morning).toMatchObject({
      id: "morning",
      name: "Morning brief",
      source: "file",
      createdBy: "user",
      schedule: { kind: "cron", cron: "0 7 * * 1-5", tz: "Europe/London" },
      action: { type: "prompt", text: "Summarise yesterday's work and today's calendar in five lines." },
      agent: "jobs",
      policy: { overlap: "queue-one", maxLateMs: 86_400_000, timeoutMs: 600_000 },
    })
    // A project file defaults the run's directory to the project it sits in.
    expect(morning.target.directory).toBe(PROJECT)
    // A file job never expires: a person committed it.
    expect(morning.expires).toBeUndefined()
    expect(morning.createdAt).toBe(Math.floor(statSync(join(PROJECT, ".opencode/jobs/morning.md")).mtimeMs))
  })

  test("a global file may nest the schedule, and has no default directory", async () => {
    const { jobs } = await read()
    const nightly = jobs.find((job) => job.id === "nightly")!
    expect(nightly.schedule).toMatchObject({ kind: "every", everyMs: 6 * 3_600_000 })
    expect(nightly.target).toEqual({ model: { providerID: "anthropic", id: "claude-sonnet-4" } })
    expect(nightly.action).toEqual({ type: "prompt", text: "Review the open pull requests and list the one that needs attention first." })
  })

  test("reads a file with no zone in the plugin's zone", async () => {
    const { jobs } = await read({ projects: [], timezone: "Europe/London" })
    const nightly = jobs.find((job) => job.id === "nightly")!
    expect(nightly.schedule.kind).toBe("every")
    const { jobs: other } = await readJobFiles({ now: NOW, timezone: "Europe/London", projects: [], global: join(FIXTURES, "conflict/global") })
    expect(other[0]!.schedule).toMatchObject({ kind: "cron", tz: "Europe/London" })
  })

  test("ignores a file that is not Markdown and a dotfile", async () => {
    const { jobs, invalid } = await read()
    expect(jobs.map((job) => job.id).sort()).toEqual(["morning", "nightly"])
    expect(invalid.map((file) => file.path)).not.toContain(join(GLOBAL, "notes.txt"))
    expect(invalid.map((file) => file.path)).not.toContain(join(GLOBAL, ".hidden.md"))
  })

  test("a missing folder is not an error", async () => {
    const { jobs, invalid } = await read({ projects: [join(FIXTURES, "nothing-here")], global: join(FIXTURES, "nothing-here-either") })
    expect(jobs).toEqual([])
    expect(invalid).toEqual([])
  })

  test("a folder that is not a folder is reported, not thrown", async () => {
    const { invalid } = await read({ projects: [], global: join(GLOBAL, "notes.txt") })
    expect(invalid).toHaveLength(1)
    expect(invalid[0]!.path).toBe(join(GLOBAL, "notes.txt"))
    expect(invalid[0]!.message).toStartWith(`JOBS_INVALID_FILE: ${join(GLOBAL, "notes.txt")}:1: The job folder could not be read`)
  })

  test("a job whose agent is not guarded is refused at create, with the code, its path and the agent's line", async () => {
    const { jobs, invalid } = await read({
      guard: (agent) => (agent === "jobs" ? { code: "JOBS_AGENT_UNGUARDED", what: `The agent "jobs" does not deny by default.`, nextStep: "Give it the read-only block." } : undefined),
    })
    expect(jobs.map((job) => job.id)).toEqual(["nightly"])
    const refused = invalid.find((file) => file.path === join(PROJECT, ".opencode/jobs/morning.md"))
    expect(refused!.message).toBe(`JOBS_AGENT_UNGUARDED: ${join(PROJECT, ".opencode/jobs/morning.md")}:5: The agent "jobs" does not deny by default. Next step: Give it the read-only block.`)
  })
})

describe("invalid job files", () => {
  const expected: [string, number][] = [
    ["allow-widens.md", 6],
    ["bad-cron.md", 3],
    ["bad-overlap.md", 6],
    ["broken-yaml.md", 3],
    ["missing-agent.md", 1],
    ["no-front-matter.md", 1],
    ["no-prompt.md", 5],
    ["unclosed.md", 1],
  ]

  test.each(expected)("%s is refused with its code, path and line %i", async (name, line) => {
    const { invalid } = await read()
    const found = invalid.find((file) => file.path === join(GLOBAL, name))
    expect(found).toBeDefined()
    // A refused grant keeps its own code; every other malformed file is a JOBS_INVALID_FILE.
    const code = name === "allow-widens.md" ? "JOBS_ALLOW_WIDENS" : "JOBS_INVALID_FILE"
    expect(found!.message).toStartWith(`${code}: ${join(GLOBAL, name)}:${line}: `)
    expect(found!.message).toContain(" Next step: ")
    expect(found!.message.endsWith(".")).toBe(true)
  })

  test("every invalid file is reported, and the valid ones still load", async () => {
    const { jobs, invalid } = await read()
    expect(invalid).toHaveLength(expected.length)
    expect(jobs).toHaveLength(2)
    // The errors name what is wrong, in the same order every time.
    expect(invalid.map((file) => file.message.split(`${GLOBAL}/`)[1]!.split(":")[0])).toEqual(["allow-widens.md", "bad-cron.md", "bad-overlap.md", "broken-yaml.md", "missing-agent.md", "no-front-matter.md", "no-prompt.md", "unclosed.md"])
    expect(invalid.find((file) => file.path.endsWith("bad-overlap.md"))!.message).toContain(`"policy.overlap" is "sometimes"`)
    expect(invalid.find((file) => file.path.endsWith("allow-widens.md"))!.message).toContain(`The job's "allow" list may only deny`)
  })

  test("a project file wins over a global file with the same id, and the conflict names both", async () => {
    const { jobs, invalid } = await read({ projects: [join(FIXTURES, "conflict/project")], global: join(FIXTURES, "conflict/global") })
    expect(jobs.map((job) => job.id)).toEqual(["brief"])
    expect(jobs[0]!.schedule).toMatchObject({ cron: "0 8 * * *" })
    expect(invalid).toHaveLength(1)
    expect(invalid[0]!.path).toBe(join(FIXTURES, "conflict/global/brief.md"))
    expect(invalid[0]!.message).toContain(`The job id "brief" is already defined by ${join(FIXTURES, "conflict/project/.opencode/jobs/brief.md")}`)
  })
})

describe("a script job file's body", () => {
  test("is refused when the body is not empty, rather than silently dropped (GAP-15)", async () => {
    const { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } = await import("node:fs")
    const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "jobs-script-body-")))
    try {
      mkdirSync(join(root, ".opencode", "jobs"), { recursive: true })
      writeFileSync(
        join(root, ".opencode", "jobs", "script.md"),
        "---\nname: Script\nschedule:\n  every: 1 hour\nagent: build\naction:\n  type: script\n  script:\n    uses:\n      - host:mem\n    code: |\n      return 1\n---\nA note that would be silently dropped.\n",
      )
      const { jobs, invalid } = await readJobFiles({ now: NOW, timezone: "UTC", projects: [root] })
      expect(jobs).toHaveLength(0)
      expect(invalid[0]?.message).toStartWith("JOBS_SCRIPT_BODY_IGNORED: ")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
