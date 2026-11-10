// `npm run drift`: the Jelly declaration's tool list against the tools the code registers. The unit suite checks the same
// lists; this prints each difference by name and exits 1 when there is one, so a maintainer can see what moved.
import { readFileSync } from "node:fs"
import { SCHEMAS, toolId } from "../src/jobs/tools.js"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const declared = new Set(pkg.jelly.tools.map((tool) => tool.permission))
const registered = new Set(Object.keys(SCHEMAS).map((name) => toolId(name)))
const missing = [...registered].filter((id) => !declared.has(id))
const extra = [...declared].filter((id) => !registered.has(id))
for (const id of missing) console.log(`not declared in package.json jelly.tools: ${id}`)
for (const id of extra) console.log(`declared in package.json jelly.tools but not registered by the code: ${id}`)
if (missing.length || extra.length) process.exit(1)
console.log(`drift: none; ${registered.size} tools declared and registered.`)
