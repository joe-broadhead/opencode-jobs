// The package ships no runtime dependencies: the two libraries the scheduler and the file parser use are bundled into
// dist/index.js and declared in NOTICE. A library is imported from one module only, so it can be replaced there, and
// nothing under src/jobs/ reads the clock by itself.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")
const pkg = JSON.parse(read("package.json")) as {
  files: string[]
  devDependencies: Record<string, string>
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** Every TypeScript file under a folder, relative to the repository. */
function sources(folder: string): string[] {
  return readdirSync(join(ROOT, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") ? [path] : []
  })
}

const jobs = sources("src/jobs")

describe("bundled libraries", () => {
  test("both are pinned exactly, in devDependencies, and the package has no runtime dependency", () => {
    expect(pkg.devDependencies.croner).toBe("11.0.0")
    expect(pkg.devDependencies.yaml).toBe("2.9.1")
    expect(pkg.dependencies).toBeUndefined()
    expect(pkg.optionalDependencies).toBeUndefined()
    expect(pkg.peerDependencies).toBeUndefined()
  })

  test("croner is imported only by the planner and yaml only by the file parser", () => {
    const importers = (name: string) => sources("src").filter((file) => new RegExp(`from "${name}"`).test(read(file)))
    expect(importers("croner")).toEqual(["src/jobs/cron.ts"])
    expect(importers("yaml")).toEqual(["src/jobs/files.ts"])
  })

  test("NOTICE ships, and names both libraries with their licences", () => {
    expect(pkg.files).toContain("NOTICE")
    const notice = read("NOTICE")
    expect(notice).toContain("croner")
    expect(notice).toContain("yaml")
    expect(notice).toContain("MIT")
    expect(notice).toContain("ISC")
    expect(notice).toContain("Copyright (c) 2015-2021 Hexagon <github.com/Hexagon>")
    expect(notice).toContain("Copyright Eemeli Aro <eemeli@gmail.com>")
  })
})

describe("the clock", () => {
  test("is a parameter everywhere under src/jobs: nothing reads it directly", () => {
    for (const file of jobs) {
      const text = read(file)
      expect({ file, now: /Date\.now\s*\(/.test(text) }).toEqual({ file, now: false })
      expect({ file, now: /new Date\s*\(\s*\)/.test(text) }).toEqual({ file, now: false })
    }
  })
})
