// GAP-10: a uses entry is `<plugin id>.<method>`, split at the last dot, and the guest accessor nests by dots. The
// examples are checked against the real parser and against the docs.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseScriptDefinition } from "../../src/jobs/model.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const accessor = (entry: string) =>
  entry.startsWith("host:")
    ? `tools.host.${entry.slice("host:".length)}`
    : `tools${entry
        .split(".")
        .map((segment) => (segment.includes("-") ? `[${JSON.stringify(segment)}]` : `.${segment}`))
        .join("")}`
const split = (entry: string) => ({ plugin: entry.slice(0, entry.lastIndexOf(".")), method: entry.slice(entry.lastIndexOf(".") + 1) })

const EXAMPLES = [
  { entry: "x.posts.get_users_bookmarks", plugin: "x.posts", method: "get_users_bookmarks", accessor: "tools.x.posts.get_users_bookmarks" },
  { entry: "utilities.tools.time_now", plugin: "utilities.tools", method: "time_now", accessor: "tools.utilities.tools.time_now" },
  { entry: "host:mem_remember", plugin: "host:mem_remember", method: "mem_remember", accessor: "tools.host.mem_remember" },
  { entry: "google-workspace.gws.read", plugin: "google-workspace.gws", method: "read", accessor: 'tools["google-workspace"].gws.read' },
]

describe("a manifest entry and its guest accessor", () => {
  test.each(EXAMPLES)("$entry splits at the last dot and nests as $accessor", (example) => {
    expect(() => parseScriptDefinition({ code: "return 1", uses: [example.entry] })).not.toThrow()
    expect(accessor(example.entry)).toBe(example.accessor)
    if (!example.entry.startsWith("host:")) {
      expect(split(example.entry)).toEqual({ plugin: example.plugin, method: example.method })
      // The accessor's segments are the plugin id's, in order, then the method.
      const shown = example.accessor.replace(/\["([^"]+)"\]/g, ".$1").replace(/^tools\./, "")
      expect(shown).toBe(`${example.plugin}.${example.method}`)
    }
  })

  test("the scripting guide shows every example", () => {
    const guide = readFileSync(join(ROOT, "docs/scripting.md"), "utf8")
    for (const example of EXAMPLES) expect({ entry: example.entry, shown: guide.includes(example.accessor) || guide.includes(example.entry) }).toEqual({ entry: example.entry, shown: true })
  })
})
