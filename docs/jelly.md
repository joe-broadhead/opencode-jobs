# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this
package's `package.json` as JSON, without loading the plugin, when a person reviews the exact
version, and uses it as follows.

Jelly names the plugin **Jobs** (`jelly.title`), with the package name and version beneath. Under
that name it shows the one line in `jelly.summary`, and beside it the mark in `jelly.icon`
(`assets/icon.svg`, shipped in the package): Jelly reads that file once, when it records the
plugin, and keeps it only if it is a clean SVG of drawing elements, with no script, style, link or
outside reference. The mark is a neutral clock face on a slate tile. Jelly's declaration contracts
drop a top-level key they don't know, and refuse an unknown key inside a tool, sign-in or
`contributes` entry, so the section uses only the keys Jelly reads.

## Icons and the vendor

`opencode.icons` lists the same mark in three files of this package, in order: `assets/icon.svg`,
then `assets/icon-128.png` and `assets/icon-256.png`, each a raster rendered from that SVG and each
with its MCP `mimeType` and exact `sizes`. `jelly.icon` stays `assets/icon.svg`, the same file as
the first entry. The three files are also exported as `./icon.svg`, `./icon-128.png` and
`./icon-256.png`, so a consumer can resolve them from the installed package, and all three are in
the published tarball.

`opencode.vendor` is absent: Jobs is this family's own product, not a plugin over a vendor's
service, so there is no vendor logo to fetch and the package carries no vendor marks.

## Tools

12 tools are declared (4 read-only). Six ask: `jobs.create`, `jobs.update`, `jobs.delete`,
`jobs.run_now`, `jobs.resume` and `jobs.extend`. `jelly.tools` lists each with the permission
action it checks, whether it asks and whether it is read-only:

| Tool | Permission | Effect | Read-only |
| --- | --- | --- | --- |
| `jobs.status` | `jobs_status` | allow | yes |
| `jobs.list` | `jobs_list` | allow | yes |
| `jobs.get` | `jobs_get` | allow | yes |
| `jobs.history` | `jobs_history` | allow | yes |
| `jobs.pause` | `jobs_pause` | allow | no |
| `jobs.pause_all` | `jobs_pause_all` | allow | no |
| `jobs.create` | `jobs_create` | ask | no |
| `jobs.update` | `jobs_update` | ask | no |
| `jobs.delete` | `jobs_delete` | ask | no |
| `jobs.run_now` | `jobs_run_now` | ask | no |
| `jobs.resume` | `jobs_resume` | ask | no |
| `jobs.extend` | `jobs_extend` | ask | no |

The plugin inserts its default rules into every agent that has a base allow, so in Jelly these
effects hold without a person pasting anything: reads and pauses run, and every change asks.
Pausing every job is the one change that does not ask, because it only stops work; resuming
asks. A
*job* still runs as the agent it names, and only that agent's own `permissions` can grant a tool a
job needs; a tool Jelly or a plugin adds later is asked about, and a write is included.

## Skills, RPC and views

`jelly.skills` lists the one skill, `jobs`. `jelly.rpc` and `jelly.views` are empty: the dialog
belongs to the OpenCode terminal UI, and the status RPC is read-only and for the dialog.
`jelly.signIns` is empty because there is no service to connect to, and `jelly.contributes` has no
Home feed, widget, work kind or setting.
