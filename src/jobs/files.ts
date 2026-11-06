/**
 * File jobs: Markdown files a project commits, and global ones in `~/.config/opencode/jobs`. The YAML front matter is
 * the definition, and the body is the prompt.
 *
 * A file job's file is the definition and its id is the file's name as a slug; tools may pause one but never write it.
 * Invalid files are returned, never thrown: status lists each one with its path and the line at fault.
 */
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { LineCounter, parseDocument } from "yaml"
import { errorText } from "../constants.js"
import { JobInputError, parseJob, slug, type Job } from "./model.js"

/** A file the parser refused: the path, and the coded message, which repeats the path and names the line. */
export interface InvalidFile {
  readonly path: string
  readonly message: string
}

export interface JobFiles {
  readonly jobs: readonly Job[]
  readonly invalid: readonly InvalidFile[]
  /** The agents a job named that the guard refused, once each: status reports them with the block to paste. */
  readonly refused: readonly string[]
}

export interface JobFileSources {
  readonly now: number
  /** The zone a job file that names none runs in. */
  readonly timezone: string
  /** The project directories to read; a job in one defaults `target.directory` to it. */
  readonly projects: readonly string[]
  /** The global folder. `~/.config/opencode/jobs` when absent. */
  readonly global?: string
  /**
   * Why a job's agent cannot run it, when it cannot: the guarded-agent check at create (D7). A file whose agent is
   * refused never becomes a job, so it is listed like any other invalid file, with the code and the line.
   */
  readonly guard?: AgentGuard
}

/** The guarded-agent check as a file read needs it: the refusal for one agent id, or undefined when it may run. */
export type AgentGuard = (agent: string) => { readonly code: string; readonly what: string; readonly nextStep: string } | undefined

const FRONT_MATTER = "---"

/**
 * What the watch compares to decide whether to parse again: every job file's path, modification time and size, in the
 * project folder and the global one. An unreadable folder counts as absent, so the next scan notices a file arriving.
 */
export async function jobFileSignature(sources: Pick<JobFileSources, "projects" | "global">): Promise<string> {
  const global = sources.global ?? join(homedir(), ".config", "opencode", "jobs")
  const folders = [...sources.projects.map((project) => join(project, ".opencode", "jobs")), global]
  const parts: string[] = []
  for (const folder of folders) {
    const listed = await readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of listed.filter((item) => item.isFile() && item.name.endsWith(".md") && !item.name.startsWith(".")).sort((left, right) => left.name.localeCompare(right.name))) {
      const info = await stat(join(folder, entry.name)).catch(() => undefined)
      if (info !== undefined) parts.push(`${join(folder, entry.name)}:${info.mtimeMs}:${info.size}`)
    }
  }
  return parts.join("|")
}

/** Every job file of every known project and the global folder, parsed and validated. */
export async function readJobFiles(sources: JobFileSources): Promise<JobFiles> {
  const invalid: InvalidFile[] = []
  const jobs: Job[] = []
  const refused: string[] = []
  const byId = new Map<string, string>()
  // The guard is asked once per file, and its refusals are remembered for status, whichever files they came from.
  const given = sources.guard
  const guard: AgentGuard | undefined =
    given === undefined
      ? undefined
      : (agent) => {
          const refusal = given(agent)
          if (refusal !== undefined && !refused.includes(agent)) refused.push(agent)
          return refusal
        }
  const global = sources.global ?? join(homedir(), ".config", "opencode", "jobs")
  const folders = [...sources.projects.map((project) => ({ folder: join(project, ".opencode", "jobs"), directory: project })), { folder: global, directory: undefined }]

  for (const { folder, directory } of folders) {
    const listed = await markdown(folder)
    if (listed.problem !== undefined) invalid.push(listed.problem)
    for (const path of listed.paths) {
      const parsed = await readJobFile(path, { now: sources.now, timezone: sources.timezone, directory, ...(guard === undefined ? {} : { guard }) })
      if ("message" in parsed) {
        invalid.push(parsed)
        continue
      }
      const first = byId.get(parsed.id)
      if (first !== undefined) {
        invalid.push(invalidAt(path, 1, `The job id "${parsed.id}" is already defined by ${first}.`, `Rename one of the two job files so that each id is unique.`))
        continue
      }
      byId.set(parsed.id, path)
      jobs.push(parsed)
    }
  }
  return { jobs, invalid, refused }
}

interface Listed {
  readonly paths: readonly string[]
  readonly problem?: InvalidFile
}

async function markdown(folder: string): Promise<Listed> {
  let entries
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { paths: [] }
    return { paths: [], problem: invalidAt(folder, 1, `The job folder could not be read (${reason(error)}).`, `Check that the folder and its files are readable, then run /jobs-status again.`) }
  }
  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
    .map((entry) => join(folder, entry.name))
    .sort()
  return { paths }
}

interface ReadContext {
  readonly now: number
  readonly timezone: string
  readonly directory?: string
  readonly guard?: AgentGuard
}

/** One file, as a job or as a refusal that names its path and the line at fault. */
async function readJobFile(path: string, context: ReadContext): Promise<Job | InvalidFile> {
  let text: string
  let modified: number
  try {
    const [raw, info] = await Promise.all([readFile(path, "utf8"), stat(path)])
    text = raw.replace(/\r\n/g, "\n")
    modified = info.mtimeMs
  } catch (error) {
    return invalidAt(path, 1, `The file could not be read (${reason(error)}).`, `Check that the file is readable, then run /jobs-status again.`)
  }

  const lines = text.split("\n")
  if (lines[0]?.trim() !== FRONT_MATTER) {
    return invalidAt(path, 1, `The file must start with a YAML front matter block: a line --- on the first line.`, `Add the job's fields between two --- lines at the top of the file, and its prompt after them.`)
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === FRONT_MATTER)
  if (close === -1) {
    return invalidAt(path, 1, `The front matter block is not closed with a --- line.`, `Close the front matter with a line --- before the prompt.`)
  }
  const body = lines.slice(close + 1).join("\n").trim()
  const counter = new LineCounter()
  const doc = parseDocument(lines.slice(1, close).join("\n"), { lineCounter: counter })
  const broken = doc.errors[0]
  if (broken !== undefined) {
    const line = (broken.linePos?.[0]?.line ?? 1) + 1
    return invalidAt(path, line, `The front matter is not valid YAML: ${firstLine(broken.message)}.`, `Fix the YAML in the front matter, then run /jobs-status again.`)
  }
  const value = doc.toJS() ?? {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidAt(path, 2, `The front matter must be a YAML mapping of fields, found ${Array.isArray(value) ? "a list" : typeof value}.`, `Write the job's fields as "key: value" lines between the --- lines.`)
  }

  // A file may write the schedule flat (`cron`, `every` or `at`, with `tz` beside them) or nested under `schedule`.
  const fields: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  let flat = false
  if (fields.schedule === undefined && (fields.cron !== undefined || fields.every !== undefined || fields.at !== undefined)) {
    const schedule: Record<string, unknown> = {}
    for (const key of ["cron", "every", "at", "tz"]) {
      if (fields[key] === undefined) continue
      schedule[key] = fields[key]
      delete fields[key]
    }
    fields.schedule = schedule
    flat = true
  }

  let action = fields.action
  let injected = false
  const promptWithoutText = action === undefined || (typeof action === "object" && action !== null && !Array.isArray(action) && (action as Record<string, unknown>).type === "prompt" && (action as Record<string, unknown>).text === undefined)
  if (promptWithoutText) {
    if (body === "") {
      return invalidAt(path, close + 1, `The job has no prompt: the body after the front matter is empty.`, `Write the prompt after the closing --- line, or give the action its own "text".`)
    }
    action = { ...(action === undefined ? {} : (action as Record<string, unknown>)), type: "prompt", text: body }
    injected = true
  }

  const line = (field: string) => {
    if (injected && field.startsWith("action")) return close + 1
    const keyPath = flat ? field.replace(/^schedule\./, "") : field
    const key = keyPath.split(".").filter((part) => part !== "")
    const node = key.length === 0 ? doc.contents : (doc.getIn(key, true) as { range?: readonly [number, number, number] } | undefined)
    if (node === undefined || node === null || !Array.isArray(node.range)) return 1
    return counter.linePos(node.range[0]).line + 1
  }

  try {
    const job = parseJob({ ...fields, action }, {
      now: context.now,
      timezone: context.timezone,
      id: slug(basename(path, ".md")),
      source: "file",
      createdAt: modified,
      createdBy: "user",
      ...(context.directory === undefined ? {} : { directory: context.directory }),
    })
    const refusal = context.guard?.(job.agent)
    if (refusal !== undefined) return invalidAt(path, line("agent"), refusal.what, refusal.nextStep, refusal.code)
    return job
  } catch (error) {
    if (!(error instanceof JobInputError)) throw error
    // A refused grant keeps its own code: it is not a malformed file, and its next step names the agent's file.
    const code = error.code === "JOBS_ALLOW_WIDENS" ? error.code : "JOBS_INVALID_FILE"
    return invalidAt(path, line(error.field), error.what, error.nextStep, code)
  }
}

const invalidAt = (path: string, line: number, what: string, nextStep: string, code = "JOBS_INVALID_FILE"): InvalidFile => ({
  path,
  message: errorText(code, `${path}:${line}: ${what}`, nextStep),
})

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
const firstLine = (text: string) => text.split(/\r?\n/, 1)[0] ?? text
