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

14 tools are declared (4 read-only): every tool the plugin registers, and nothing else. `jelly.tools` lists each with
the permission action it checks, its effect under the default access (`all`), and whether it is read-only. Every effect
is `allow`, like every other plugin of this family. The four reads change nothing; `jobs.pause` and `jobs.pause_all`
change a job's state (they stop work), so they are declared as not read-only, like the other changes:

| Tool | Permission | Effect | Read-only |
| --- | --- | --- | --- |
| `jobs.status` | `jobs_status` | allow | yes |
| `jobs.list` | `jobs_list` | allow | yes |
| `jobs.get` | `jobs_get` | allow | yes |
| `jobs.history` | `jobs_history` | allow | yes |
| `jobs.pause` | `jobs_pause` | allow | no |
| `jobs.pause_all` | `jobs_pause_all` | allow | no |
| `jobs.create` | `jobs_create` | allow | no |
| `jobs.update` | `jobs_update` | allow | no |
| `jobs.delete` | `jobs_delete` | allow | no |
| `jobs.run_now` | `jobs_run_now` | allow | no |
| `jobs.resume` | `jobs_resume` | allow | no |
| `jobs.extend` | `jobs_extend` | allow | no |
| `jobs.approve` | `jobs_approve` | allow | no |
| `jobs.run_script` | `jobs_run_script` | allow | no |

## Access

`jelly.contributes.settings` declares one setting, `access`, with Jelly's three choices: `all` ("Allowed"), the
default; `ask-changes` ("Ask before changes"); and `read-only` ("Read only"). In Jelly, at **Allowed** every tool runs,
declared or not.
At `ask-changes`, the four reads run and every other tool asks, the two pauses and a tool added later included.
At **Read only**, the four reads run and everything else is denied. A read-only helper is never given a tool declared
as not read-only.

A script's one approval follows the same setting. At `all` a script is approved without a prompt, and its digest and
audit record are still kept. At `ask-changes` an all-read script is approved without a prompt, and a script that can
change something waits for one approval: the digest-bound `jobs_script` prompt, which shows its source, its tools and
its file writes. At `read-only` an all-read script runs, and a script that can change something is denied, an earlier
approval included. `jobs_script` is an approval, not a tool, so it is not in `jelly.tools`; it falls under the `jobs_*`
pattern, which follows `access` the same way.

In OpenCode, the plugin's own default rules, inserted after an agent's base allow, give the same results for every
access value. `/jobs-pause`, an OpenCode command, is a kill switch that runs with no prompt. A *job* still runs as the
agent it names, and only that agent's own `permissions` can grant a tool a job needs.

## Skills, RPC and views

`jelly.skills` lists the one skill, `jobs`. `jelly.rpc` and `jelly.views` are empty: the dialog
belongs to the OpenCode terminal UI, and the status RPC is read-only and for the dialog.
`jelly.signIns` is empty because there is no service to connect to. `jelly.contributes` has no Home
feed, widget or work kind, and one setting, `access` (above).
