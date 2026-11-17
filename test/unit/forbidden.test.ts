// The forbidden scan's one exception: the two evaluate hooks, the job session's in its file and both in the bundle that
// inlines the source contract's tools RPC too, and nothing anywhere else. The scan is run here against a throwaway tree, so a second hook or a stray one fails here.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { findForbidden, HOOK_FILES } from "../../scripts/check-forbidden.mjs"

// Spelled in two parts: the constructor itself is a forbidden reference in this repository's own sources.
const HOOK = ["permission", "hook"].join(".")
const evaluate = (indent = "") => `${indent}await ctx.${HOOK}("evaluate", () => undefined)\n`

const roots: string[] = []
function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "jobs-forbidden-")))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const hookIds = (root: string) => findForbidden(root).filter((finding: { id: string }) => finding.id === "permission-hook")

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("the forbidden scan", () => {
  test("allows the job session's hook, and the bundle that inlines it and the tools RPC's", () => {
    const root = tree({
      "src/jobs/safety.ts": `export async function registerSafety(ctx) {\n${evaluate("  ")}  }\n`,
      "dist/index.js": `${evaluate()}${evaluate()}`,
    })
    expect(findForbidden(root)).toEqual([])
    expect([...HOOK_FILES.keys()]).toEqual(["src/jobs/safety.ts", "dist/index.js"])
  })

  test("fails a hook in any other file", () => {
    const root = tree({
      "src/host/tools-rpc.ts": evaluate(),
      "src/jobs/safety.ts": evaluate(),
      "dist/index.js": `${evaluate()}${evaluate()}`,
      "src/jobs/other.ts": evaluate(),
    })
    expect(hookIds(root).map((finding: { path: string }) => finding.path).sort()).toEqual(["src/host/tools-rpc.ts", "src/jobs/other.ts"])
  })

  test("fails a second hook in a file that may hold one", () => {
    const root = tree({ "src/jobs/safety.ts": `${evaluate()}${evaluate()}` })
    expect(hookIds(root).map((finding: { why: string }) => finding.why)).toEqual(["src/jobs/safety.ts must hold exactly 1 permission hook, found 2"])
  })

  test("fails a hook that is not an evaluate hook", () => {
    const root = tree({ "src/jobs/safety.ts": `await ctx.${HOOK}("deny", () => undefined)\n` })
    expect(hookIds(root).map((finding: { why: string }) => finding.why)).toEqual(["src/jobs/safety.ts holds a permission hook that is not an evaluate hook"])
  })

  test("still fails a machine-local path", () => {
    const home = ["", "Users", "someone", "project"].join("/")
    const root = tree({ "src/jobs/safety.ts": `${evaluate()}const home = ${JSON.stringify(home)}\n` })
    expect(findForbidden(root).map((finding: { id: string }) => finding.id)).toEqual(["absolute-path"])
  })
})
