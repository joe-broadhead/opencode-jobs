/**
 * The guarded-agent rule and the read-only block a job's agent needs (D4, D7).
 *
 * A job runs as the agent it names, and that agent's own `permissions` are its whole profile. This plugin inserts no
 * rule into any agent: the block below is the documented profile a person pastes into `opencode.json`, and status
 * prints it. What this file adds is the check: an agent is *guarded* when its rules deny anything it does not name, so
 * a job under it can never run a write tool unnoticed. A job whose agent is not guarded is refused rather than run
 * into a hundred denials (a run never asks, so every ask the profile would produce is a failure).
 *
 * The block starts with a blanket deny because OpenCode applies an agent's own rules after its base `* * allow`, and
 * within one list the later rule wins (spike V3). An allow-only block would inherit the base allow.
 */
import type { Plugin } from "@opencode/plugin"
import { errorText } from "../constants.js"

/** One permission rule, as an agent's `permissions` hold it. */
export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

/** An agent as the host reports it: the guarded check reads nothing but its rules. */
export type AgentInfo = Awaited<ReturnType<Plugin.Context["agent"]["get"]>>["data"]

/**
 * The read-only profile, in the order it must be pasted: the blanket deny first, then every allow. `read`, `glob`,
 * `grep` and `list` are OpenCode's own reads; the rest are this plugin's read tools and its pause, which is always safe.
 */
export const AGENT_BLOCK: readonly Rule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "list", resource: "*", effect: "allow" },
  { action: "jobs_status", resource: "*", effect: "allow" },
  { action: "jobs_list", resource: "*", effect: "allow" },
  { action: "jobs_get", resource: "*", effect: "allow" },
  { action: "jobs_history", resource: "*", effect: "allow" },
  { action: "jobs_pause", resource: "*", effect: "allow" },
]

/** The agent the documented block names, and the agent a job runs as when nothing else is set. */
export const DEFAULT_AGENT: string = "jobs"

/**
 * The rules this plugin inserts into every agent after its base allow (S3): every `jobs_` tool asks, and the reads and
 * the two pauses are allowed. Reads never change anything, and pausing is always safe; everything else is a change
 * that a person approves. Inserted after the base `* * allow` and before the agent's own rules, so a later rule wins.
 */
export const DEFAULT_RULES: readonly Rule[] = [
  { action: "jobs_*", resource: "*", effect: "ask" },
  { action: "jobs_status", resource: "*", effect: "allow" },
  { action: "jobs_list", resource: "*", effect: "allow" },
  { action: "jobs_get", resource: "*", effect: "allow" },
  { action: "jobs_history", resource: "*", effect: "allow" },
  { action: "jobs_pause", resource: "*", effect: "allow" },
  { action: "jobs_pause_all", resource: "*", effect: "allow" },
]

const BASE_ALLOW: Rule = { action: "*", resource: "*", effect: "allow" }

const same = (left: Rule, right: Rule) => left.action === right.action && left.resource === right.resource && left.effect === right.effect

/**
 * True when the default rules appear as one contiguous block anywhere after the agent's first base allow. Other
 * plugins insert their blocks at the same place, so the block need not come first.
 */
export function hasDefaultRules(rules: readonly Rule[]): boolean {
  const base = rules.findIndex((rule) => same(rule, BASE_ALLOW))
  if (base === -1) return false
  return rules.some(
    (_, start) =>
      start > base &&
      DEFAULT_RULES.every((rule, offset) => {
        const candidate = rules[start + offset]
        return candidate !== undefined && same(candidate, rule)
      }),
  )
}

/**
 * Inserts the default rules right after the agent's first base allow, once. Every later rule still wins, because the
 * last match wins, so no agent's own deny or allow is weakened. An agent without a base allow gets nothing: there,
 * unlisted actions are not allowed anyway, and the block's asks would change a default deny into a prompt.
 */
export function insertDefaultRules(rules: Rule[]): void {
  const base = rules.findIndex((rule) => same(rule, BASE_ALLOW))
  if (base === -1 || hasDefaultRules(rules)) return
  rules.splice(base + 1, 0, ...DEFAULT_RULES.map((rule) => ({ ...rule })))
}



/** The paste-ready config for one agent: the same block the docs show, for status and a refusal's next step. */
export function agentBlock(agent: string): { readonly agents: Record<string, { readonly permissions: readonly Rule[] }> } {
  return { agents: { [agent]: { permissions: AGENT_BLOCK.map((rule) => ({ ...rule })) } } }
}

/** The block as the JSON a person pastes into `opencode.json`. */
export const agentBlockJSON = (agent: string) => JSON.stringify(agentBlock(agent), null, 2)

/** Host wildcards: `*` matches any run of characters and `?` one character, over the whole string. */
const matches = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value)

/** The effect of `rules` for a call that names no resource: the last matching rule wins, and no match asks. */
export function evaluate(rules: readonly Rule[], action: string): Rule["effect"] {
  return rules.findLast((rule) => matches(rule.action, action) && matches(rule.resource, "*"))?.effect ?? "ask"
}

/** A tool no agent block names, so the effect for it is what a tool added tomorrow would get. */
const UNNAMED_TOOL = "jobs_unnamed_tool"

/**
 * True when the agent's rules deny a tool they do not name. That is the whole safety property: an unguarded agent
 * allows what it does not name, so one of its rules would let a write tool run without asking.
 */
export function isGuarded(rules: readonly Rule[]): boolean {
  return evaluate(rules, UNNAMED_TOOL) === "deny"
}

/** Why a job could not run as an agent: what is wrong, without the code or the next step. */
export interface AgentRefusal {
  /** Unguarded or missing: the job's agent needs the block. Agents unknown: the host could not be asked. */
  readonly code: "JOBS_AGENT_UNGUARDED" | "JOBS_AGENTS_UNKNOWN"
  readonly what: string
  readonly nextStep: string
  /** The coded message, for a caller that has no path of its own. */
  readonly message: string
}

/** The next step when the host could not say which agents exist: not a configuration answer, a restart. */
const UNKNOWN_NEXT = "Restart OpenCode, then run /jobs-status again. Nothing runs while the agents are unknown."

const nextStep = (agent: string) =>
  `Give the agent ${JSON.stringify(agent)} the read-only block, starting with {"action":"*","resource":"*","effect":"deny"}, or point the job at an agent that has it. Run /jobs-status to print the block.`

/** One refusal, with its code, so the message and the code cannot drift apart. */
function agentRefusal(what: string, next: string, code: AgentRefusal["code"] = "JOBS_AGENT_UNGUARDED"): AgentRefusal {
  return { code, what, nextStep: next, message: messageOf(code, what, next) }
}

/** The coded message, by hand for each code, because the code is part of the text and must be documented. */
function messageOf(code: AgentRefusal["code"], what: string, next: string): string {
  if (code === "JOBS_AGENTS_UNKNOWN") return errorText("JOBS_AGENTS_UNKNOWN", what, next)
  return errorText("JOBS_AGENT_UNGUARDED", what, next)
}

/** The refusal for one agent id, or undefined when the agent exists and denies by default. */
export function refusalFor(agents: readonly AgentInfo[], id: string): AgentRefusal | undefined {
  const agent = agents.find((candidate) => candidate.id === id || candidate.name === id)
  if (agent === undefined) return agentRefusal(`There is no agent named ${JSON.stringify(id)}, so a job cannot run as it.`, nextStep(id))
  if (isGuarded(agent.permissions)) return undefined
  return agentRefusal(`The agent ${JSON.stringify(id)} does not deny by default, so a job under it would ask on every write and be denied every time.`, nextStep(id))
}

/**
 * True when the host says the thing looked up does not exist: a tagged not-found error, an HTTP 404, or the SDK's plain
 * `Agent not found: <id>` error, which carries neither a tag nor a status.
 */
function notFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const found = error as { _tag?: unknown; name?: unknown; status?: unknown; statusCode?: unknown; message?: unknown }
  const tag = found._tag ?? found.name
  return (
    (typeof tag === "string" && /not.?found/i.test(tag)) ||
    found.status === 404 ||
    found.statusCode === 404 ||
    (typeof found.message === "string" && /^(?:agent )?not found\b/i.test(found.message))
  )
}

/**
 * The refusal for one agent, read from the host now, as it resolves in the directory the run happens in: an agent is a
 * directory's configuration, and a name can mean different rules in two projects (DR-4). A host that cannot answer at
 * all is its own refusal, not a pass: nothing runs while the agents are unknown, and the next step is a restart rather
 * than a permissions change.
 */
export async function guardAgent(agent: Pick<Plugin.Context["agent"], "get">, id: string, directory?: string, fallback?: string): Promise<AgentRefusal | undefined> {
  // A job that targets another directory is resolved there and nowhere else (DR-4). A job that runs where the leader is
  // asks for no location first, because that is what such a run resolves, and falls back to the leader's location: the
  // two mean the same configuration, and a host between reloads resolves one more reliably than the other.
  const attempts = directory !== undefined ? [directory] : [...new Set([undefined, fallback].filter((value): value is string | undefined => value === undefined || value !== ""))]
  let last: AgentRefusal | undefined
  for (const where of attempts) {
    const info = await agent.get({ agentID: id, ...(where === undefined ? {} : { location: { directory: where } }) }).then(
      (found) => found.data,
      (error: unknown) => (notFound(error) ? null : undefined),
    )
    if (info === undefined) {
      last = agentRefusal(`The agents could not be read, so the job ${JSON.stringify(id)} was not checked and did not run.`, UNKNOWN_NEXT, "JOBS_AGENTS_UNKNOWN")
      continue
    }
    if (info === null) {
      last = agentRefusal(`There is no agent named ${JSON.stringify(id)}, so a job cannot run as it.`, nextStep(id))
      continue
    }
    if (directory === undefined) return refusalFor([info], id)
    return refusalFor([info], id)
  }
  return last ?? agentRefusal(`There is no agent named ${JSON.stringify(id)}, so a job cannot run as it.`, nextStep(id))
}

/** The agents the job list names that are not guarded, in the order they are first named. */
export function unguardedAgents(agents: readonly AgentInfo[], wanted: readonly string[]): string[] {
  return [...new Set(wanted.filter((id) => refusalFor(agents, id) !== undefined))]
}
