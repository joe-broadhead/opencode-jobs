// The jobs skill: read from skills/jobs/SKILL.md, handed to OpenCode's skill list, and skipped with a warning when its file is
// missing or its front matter does not name it. The registration is checked against a narrow fake of the skill editor; the
// host test checks what the stock OpenCode lists.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadSkills, skillTransform, SKILL_ID } from "../../src/skill.js"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const temp: string[] = []
afterAll(() => {
  for (const root of temp) rmSync(root, { recursive: true, force: true })
})

const scratch = (files?: Record<string, string>) => {
  const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "jobs-skill-")))
  temp.push(root)
  if (files) for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

describe("the jobs skill", () => {
  test("reads the shipped SKILL.md: the id, the front matter's description, autoinvoke, and the body without the front matter", async () => {
    const warnings: string[] = []
    const skills = await loadSkills(ROOT, (message) => warnings.push(message))
    expect(warnings).toEqual([])
    expect(skills).toHaveLength(1)
    const [skill] = skills
    expect(SKILL_ID).toBe("jobs")
    expect(skill).toMatchObject({ id: "jobs", name: "jobs", autoinvoke: true })
    expect(skill?.description).toContain("what jobs do I have scheduled")
    expect(String(skill?.path)).toBe(join(ROOT, "skills", "jobs", "SKILL.md"))
    expect(skill?.content.startsWith("# Jobs")).toBe(true)
    expect(skill?.content).not.toContain("description:")
  })

  test("hands the loaded skill to OpenCode's editor, once", async () => {
    const [skill] = await loadSkills(ROOT)
    const added: unknown[] = []
    skillTransform(skill ? [skill] : [])({ add: (value: unknown) => void added.push(value) } as never)
    expect(added).toEqual([skill])
  })

  test("a missing file is skipped with SKILLS_INVALID and a next step, and setup carries on", async () => {
    const warnings: string[] = []
    expect(await loadSkills(scratch(), (message) => warnings.push(message))).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toStartWith("SKILLS_INVALID: The skill jobs is missing or malformed, so it was skipped.")
    expect(warnings[0]).toContain("Next step: Reinstall the plugin.")
  })

  test("a file whose front matter names another skill is skipped, not registered under the wrong id", async () => {
    const root = scratch({ "skills/jobs/SKILL.md": "---\nname: other\ndescription: Something else.\n---\n\n# Other\n" })
    const warnings: string[] = []
    expect(await loadSkills(root, (message) => warnings.push(message))).toEqual([])
    expect(warnings[0]).toStartWith("SKILLS_INVALID: ")
  })

  test("a file with no description is skipped", async () => {
    const root = scratch({ "skills/jobs/SKILL.md": "---\nname: jobs\n---\n\n# Jobs\n" })
    expect(await loadSkills(root, () => undefined)).toEqual([])
  })
})
