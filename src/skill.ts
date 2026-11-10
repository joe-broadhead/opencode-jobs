// The jobs skill: `skills/jobs/SKILL.md` under the package root, registered with OpenCode so a question about scheduled jobs
// loads it. The file's front matter names the skill and says when to use it. A missing or malformed file is skipped with
// a warning, and setup carries on without it.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin, Skill } from "@opencode/plugin"
import { jobsError } from "./constants.js"

export const SKILL_ID = "jobs"

type SkillEditor = Parameters<Parameters<Plugin.Context["skill"]["transform"]>[0]>[0]

/** Reads `skills/jobs/SKILL.md`: the front matter's name must be the skill's id, and it needs a description. */
export async function loadSkills(packageRoot: string, warn: (message: string) => void = console.warn): Promise<Skill.Info[]> {
  const path = join(packageRoot, "skills", SKILL_ID, "SKILL.md")
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(await readFile(path, "utf8"))
    const fields = Object.fromEntries(
      (match?.[1] ?? "")
        .split(/\r?\n/)
        .map((line) => /^(\w+):\s*(.+?)\s*$/.exec(line))
        .filter((found) => found !== null)
        .map((found) => [found[1], found[2]]),
    )
    if (!match || fields.name !== SKILL_ID || !fields.description) throw new Error("expected front matter with name and description")
    const info = { id: SKILL_ID, name: SKILL_ID, description: fields.description, path, content: match[2]!.trim(), autoinvoke: true } as Skill.Info
    return [info]
  } catch {
    warn(jobsError("SKILLS_INVALID", `The skill ${SKILL_ID} is missing or malformed, so it was skipped.`, "Reinstall the plugin.").message)
    return []
  }
}

/** The transform that adds the loaded skills to OpenCode's list. */
export const skillTransform = (skills: readonly Skill.Info[]) => (editor: SkillEditor) => {
  for (const skill of skills) editor.add(skill)
}
