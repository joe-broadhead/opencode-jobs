// The script gate: the real resolve (create, approve, run and after a rule change), the host-tool admission rules, the
// approval's own payload, and the adversarial matrix. The expected effect in the matrix is computed by an independent
// predicate with the host's documented order, not by the `evaluate` under test.
import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { SELF_DENIES } from "../../src/jobs/safety.js"
import { approvalMatches, denied, filesDigest, scriptSessionRules, type Script, type ScriptApproval } from "../../src/jobs/script.js"
import { createScriptGate, type ScriptHost } from "../../src/jobs/script-gate.js"

type Effect = "allow" | "ask" | "deny"
type Rule = { readonly action: string; readonly resource: string; readonly effect: Effect }
type Method = { readonly name: string; readonly action: string; readonly class: string; readonly tool?: string; readonly description?: string }

const wildcard = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value)

/** The host's predicate, written here independently of `evaluate`: the last matching rule wins, no match asks. */
const expected = (rules: readonly Rule[], action: string, resource = "*"): Effect =>
  rules.findLast((rule) => wildcard(rule.action, action) && wildcard(rule.resource, resource))?.effect ?? "ask"

const FAMILY: Record<string, readonly Method[]> = {
  "jobs.scheduler": [
    { name: "jobs_create", action: "jobs_create", class: "write" },
  ],
  "x.posts": [
    { name: "read", action: "x_read", class: "read", tool: "x_get_read", description: "Read items." },
    { name: "write", action: "x_write", class: "write", tool: "x_write_item" },
    { name: "delete", action: "x_delete", class: "destructive", tool: "x_delete_item" },
    { name: "send", action: "x_send", class: "send", tool: "x_send_item" },
  ],
}

const script = (uses: string[]): Script => ({ code: "const a = 1;\nreturn a;", uses })

interface HostOptions {
  readonly rules?: readonly Rule[] | null
  readonly tools?: readonly { readonly id: string; readonly name: string; readonly description?: string; readonly options?: { readonly namespace?: string; readonly permission?: string } }[]
  readonly servers?: readonly string[]
  readonly plugins?: readonly string[]
}

function makeGate(options: HostOptions = {}) {
  const asserted: Record<string, unknown>[] = []
  let rules: readonly Rule[] | null = options.rules === undefined ? [{ action: "*", resource: "*", effect: "allow" }] : options.rules
  const tools = options.tools ?? []
  const plugins = options.plugins ?? Object.keys(FAMILY)
  const servers = options.servers ?? []
  const host: ScriptHost = {
    rpc: ((definition: { id?: string }) => {
      const plugin = String(definition?.id ?? "").replace(/\.tools$/, "")
      return {
        describe: async () => ({ id: `${plugin}.tools`, methods: plugins.includes(plugin) ? (FAMILY[plugin] ?? []) : [] }),
      }
    }) as unknown as Plugin.Context["rpc"],
    tool: { list: async () => tools as never } as never,
    agent: {
      get: async () => {
        if (rules === null) throw new Error("the agent is not readable")
        return { data: { id: "build", name: "build", permissions: rules } }
      },
    } as never,
    plugin: { list: async () => ({ data: plugins.map((id) => ({ id })) }) } as never,
    mcp: { list: async () => ({ data: servers.map((name) => ({ name, status: { status: "connected" } })) }) } as never,
    location: "/work",
    permission: {
      assert: async (input) => {
        asserted.push(input as Record<string, unknown>)
      },
    },
    now: () => 1_000,
  }
  return {
    gate: createScriptGate(host),
    asserted,
    setRules: (next: readonly Rule[] | null) => void (rules = next),
    rules: () => rules,
  }
}

const USES = ["x.posts.read", "x.posts.write", "x.posts.delete", "x.posts.send"]
const ACTIONS = ["x_read", "x_write", "x_delete", "x_send"] as const

const BASE: Rule = { action: "*", resource: "*", effect: "allow" }
const exact = (action: string, effect: Effect, resource = "*"): Rule => ({ action, resource, effect })

/** Eleven rule shapes, with a deny in the positions §10.1 asks for. */
const SHAPES: readonly { readonly name: string; readonly rules: readonly Rule[] }[] = [
  { name: "plugin default: base allow only", rules: [BASE] },
  { name: "plugin default: base allow then a blanket deny", rules: [BASE, exact("*", "deny")] },
  { name: "user global: exact allows, then a wildcard deny", rules: [BASE, exact("x_read", "allow"), exact("x_write", "allow"), exact("x_send", "allow"), exact("x_*", "deny")] },
  { name: "user project: exact allow then exact deny", rules: [BASE, exact("x_read", "allow"), exact("x_write", "deny")] },
  { name: "agent: deny then ask", rules: [BASE, exact("x_delete", "deny"), exact("x_delete", "ask")] },
  { name: "agent: ask then deny", rules: [BASE, exact("x_send", "ask"), exact("x_send", "deny")] },
  { name: "closed profile: blanket deny then one allow", rules: [BASE, exact("*", "deny"), exact("x_read", "allow")] },
  { name: "no rules at all", rules: [] },
  { name: "blanket deny with no allow", rules: [exact("*", "deny")] },
  { name: "a deny bound to another resource", rules: [BASE, exact("x_write", "deny", "/other")] },
  { name: "a later explicit allow after a plugin deny (the documented opt-in)", rules: [BASE, exact("x_delete", "deny"), exact("x_delete", "allow")] },
]

describe("the script gate's resolve", () => {
  test("the matrix: no deny-resolved method ever gets a run-session allow, across 11 shapes and 4 actions", async () => {
    let rows = 0
    let denyRows = 0
    for (const shape of SHAPES) {
      const setup = makeGate({ rules: shape.rules })
      const resolved = await setup.gate.resolve(USES, "build")
      const session = scriptSessionRules(resolved, SELF_DENIES)
      const combined = [...shape.rules, ...session]
      for (const action of ACTIONS) {
        rows += 1
        const effect = expected(shape.rules, action)
        const reported = resolved.find((tool) => tool.action === action)?.effect
        expect({ shape: shape.name, action, reported }).toEqual({ shape: shape.name, action, reported: effect })
        const granted = session.some((rule) => rule.action === action && rule.effect === "allow")
        if (effect === "deny") {
          denyRows += 1
          expect({ shape: shape.name, action, granted }).toEqual({ shape: shape.name, action, granted: false })
          expect(denied(resolved).map((tool) => tool.action)).toContain(action)
          // The host's own order over agent ++ session must also end at deny, not at the grant that would widen.
          expect({ shape: shape.name, action, run: expected(combined, action) }).toEqual({ shape: shape.name, action, run: "deny" })
        } else {
          expect({ shape: shape.name, action, granted }).toEqual({ shape: shape.name, action, granted: true })
          expect(expected(combined, action)).toBe("allow")
        }
      }
    }
    expect(rows).toBe(44)
    // Every shape with a deny really exercised the hazard.
    expect(denyRows).toBeGreaterThanOrEqual(8)
  })

  test("re-resolving after the agent gains a deny refuses the run and invalidates the approval", async () => {
    const setup = makeGate()
    const before = await setup.gate.resolve(USES, "build")
    const approval: ScriptApproval = { sourceHash: "a".repeat(64), manifestDigest: "b".repeat(64), filesDigest: filesDigest(), digest: "c".repeat(64), at: 1, resolved: before, files: [] }
    expect(denied(before)).toHaveLength(0)
    // The user adds a deny between runs.
    setup.setRules([BASE, exact("x_write", "deny")])
    const after = await setup.gate.resolve(USES, "build")
    expect(denied(after).map((tool) => tool.action)).toEqual(["x_write"])
    const session = scriptSessionRules(after, SELF_DENIES)
    expect(session.some((rule) => rule.action === "x_write" && rule.effect === "allow")).toBe(false)
    // The approval named allow; the tool now resolves deny, so the run cannot use it.
    expect(approvalMatches(approval, script(USES), after)).toBe(false)
  })

  test("pins the run session's order: a manifest action is granted, then SELF_DENIES denies it", async () => {
    const setup = makeGate({ rules: [BASE, exact("jobs_create", "ask")] })
    const resolved = await setup.gate.resolve(["jobs.scheduler.jobs_create"], "build")
    const session = scriptSessionRules(resolved, SELF_DENIES)
    const allow = session.findIndex((rule) => rule.action === "jobs_create" && rule.effect === "allow")
    const deny = session.findIndex((rule) => rule.action === "jobs_create" && rule.effect === "deny")
    expect(allow).toBeGreaterThan(0)
    expect(deny).toBeGreaterThan(allow)
    expect(expected([...resolved.map(() => BASE), ...session], "jobs_create")).toBe("deny")
  })

  test("resolves a bare service label, and suggests a family method for a typo", async () => {
    const setup = makeGate()
    const resolved = await setup.gate.resolve(["x.read"], "build")
    expect(resolved[0]).toMatchObject({ method: "x.posts.read", action: "x_read" })
    await expect(setup.gate.resolve(["x.posts.rea"], "build")).rejects.toThrow(/x\.posts\.read/)
  })

  test("refuses an unreadable agent and an unknown family method", async () => {
    await expect(makeGate({ rules: null }).gate.resolve(USES, "build")).rejects.toThrow("could not be read")
    await expect(makeGate({ plugins: [] }).gate.resolve(["x.posts.read"], "build")).rejects.toThrow("JOBS_SCRIPT_UNKNOWN_TOOL")
  })
})

describe("the host: route", () => {
  const mem = { id: "mem_remember", name: "mem_remember", description: "Store one fact.", options: { namespace: "mem", permission: "mem_remember" } }
  const mcp = { id: "srv_probe", name: "probe", description: "An MCP read." }

  test("refuses OpenCode's own shell, file and network tools by registration, even when the agent allows them", async () => {
    const core = [
      { id: "bash", name: "bash", description: "Run a shell command" },
      { id: "edit", name: "edit", description: "Edit a file", options: { codemode: false } },
      { id: "webfetch", name: "webfetch", description: "Fetch a URL", options: { codemode: false } },
      { id: "opencode_session_move", name: "session_move", options: { namespace: "opencode" } },
    ]
    const setup = makeGate({ tools: core })
    for (const id of ["bash", "edit", "webfetch", "opencode_session_move"]) {
      await expect(setup.gate.resolve([`host:${id}`], "build")).rejects.toThrow("JOBS_SCRIPT_HOST_TOOL")
    }
    // An MCP tool and a plugin tool are admitted: they have a server prefix or a plugin namespace.
    const admitted = makeGate({ tools: [...core, mem, mcp], servers: ["srv"] })
    const resolved = await admitted.gate.resolve(["host:mem_remember", "host:srv_probe"], "build")
    expect(resolved.map((tool) => [tool.method, tool.kind])).toEqual([["host:mem_remember", "host"], ["host:srv_probe", "host"]])
  })

  test("refuses a family-served tool, with the family method as the next step", async () => {
    const setup = makeGate({ tools: [{ id: "x_get_read", name: "get_read", description: "Read." }], servers: ["x"] })
    await expect(setup.gate.resolve(["host:x_get_read"], "build")).rejects.toThrow(/x\.posts\.read/)
    try {
      await setup.gate.resolve(["host:x_get_read"], "build")
    } catch (error) {
      expect((error as { code?: string }).code).toBe("JOBS_SCRIPT_FAMILY_TOOL")
    }
  })
})

describe("the approval's own payload", () => {
  test("carries the digest, the tools, the writes, and the source with a clear head and where the rest is", async () => {
    const setup = makeGate()
    const resolved = await setup.gate.resolve(USES, "build")
    const long = `// a long script\n${"const value = 1;\n".repeat(900)}return value;`
    const approval = await setup.gate.approve({ sessionID: "ses_1", agent: "build", script: { code: long, uses: USES }, resolved, job: "job_1", source: { messageID: "msg_1", id: "call_1" } })
    const asked = setup.asserted[0] as { action: string; resources: string[]; metadata: Record<string, unknown> }
    expect(asked.action).toBe("jobs_script")
    expect(asked.resources).toEqual([`script:sha256:${approval.digest}`])
    expect(asked.metadata).toMatchObject({ digest: approval.digest, truncated: true, where: 'the original definition of job "job_1"' })
    expect(String(asked.metadata.script)).toStartWith("// a long script")
    expect(String(asked.metadata.script).length).toBe(8192)
    expect((asked.metadata.tools as unknown[]).length).toBe(4)
    expect((asked.metadata.writes as string[]).length).toBe(3)
    expect(approval.resolved).toEqual(resolved)
  })

  test("lists each declared file's path and mode, and binds them into the digest", async () => {
    const setup = makeGate()
    const resolved = await setup.gate.resolve(USES, "build")
    const files = [{ name: "state", path: "/work/state.json", mode: "readwrite" as const, format: "json" as const, maxBytes: 1024 }]
    const script = { code: "return 1", uses: USES, files: { state: { path: "state.json", mode: "readwrite" as const, format: "json" as const } } }
    const first = await setup.gate.approve({ sessionID: "ses_1", agent: "build", script, resolved, files, job: "job_1" })
    const asked = setup.asserted[0] as { metadata: Record<string, unknown> }
    expect(asked.metadata.files).toEqual(files)
    expect(first.filesDigest).toBe(filesDigest(script.files))
    const changed = await setup.gate.approve({ sessionID: "ses_1", agent: "build", script: { ...script, files: { state: { ...script.files.state, mode: "read" } } }, resolved, files: [{ ...files[0]!, mode: "read" } as never], job: "job_1" })
    expect(changed.digest).not.toBe(first.digest)
  })
})
