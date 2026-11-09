# Configuration

The plugin's options, its permission model and default rules, the tools and commands, the job file format, the status
model, its two RPCs and every error it raises.

## Options

Set options with the object form of the plugin entry. Every option is optional.

```json
{
  "plugins": [
    {
      "package": "@joe-broadhead/opencode-jobs",
      "options": { "enabled": true, "concurrency": 2, "keepAliveMinutes": 20 }
    }
  ]
}
```

| Option | Values | Default | Effect |
| --- | --- | --- | --- |
| `enabled` | `true` or `false` | `true` | `false` stops the runner and leaves the tools, the commands, the dialog and both RPCs working. `/jobs-pause` pauses every job without a restart; this option stops the runner altogether. |
| `allowUntestedHost` | `true` or `false` | `false` | Starts on an OpenCode version outside `>=2.2.3 <2.3.0`, with the `OpenCode` status row saying it is outside the range. |
| `timezone` | An IANA zone name, such as `Europe/London` | The server's zone | The zone a job that names none runs in. A job's own `tz` wins. |
| `concurrency` | A whole number from 1 to 8 | `2` | How many runs may be in flight at once, across every job. It bounds cost and file contention, and a run that arrives while the cap is reached waits for the next free slot. |
| `keepAliveMinutes` | A whole number of minutes from 1 to 59 | `20` | How often the plugin touches its location with an empty session, so the location is never idle-unloaded and the runner keeps running (D2). Keep it below `experimental.location_idle_timeout`; 20 is below the default 60. |
| `access` | `all`, `ask-changes` or `read-only` | `all` | Chooses the Jobs tool rules and script approval policy described below. |
| `scriptFilesRoots` | An array of absolute directory paths | `[]` | Adds roots for declared script files; each root grants read and write access to its tree. |

A wrong option fails setup with `OPTIONS_INVALID`, which names the option and the accepted values. Nothing runs until it
is fixed.

## Permissions

**Every tool is allowed by default.** The plugin inserts nothing that grants anything, and it never weakens a rule you
set: OpenCode's base `* * allow` is the grant. Jobs inserts one block directly after it, chosen by the `access` option:

```json
[
  { "action": "jobs_*", "resource": "*", "effect": "allow" },
  { "action": "jobs_status", "resource": "*", "effect": "allow" },
  { "action": "jobs_list", "resource": "*", "effect": "allow" },
  { "action": "jobs_get", "resource": "*", "effect": "allow" },
  { "action": "jobs_history", "resource": "*", "effect": "allow" },
  { "action": "jobs_pause", "resource": "*", "effect": "allow" },
  { "action": "jobs_pause_all", "resource": "*", "effect": "allow" }
]
```

That is `all`, the default. With `"access": "ask-changes"` the namespace rule is `jobs_* ask` and the same four reads
and two pauses follow as explicit allows; with `"access": "read-only"` it is `jobs_* deny` plus the four reads. A tool
the vendor adds later therefore runs under `all`, asks under `ask-changes` and is denied under `read-only`. Every later
rule still wins, because the last match wins, so an agent's own `deny` or `allow` is untouched.

The access option also decides a script's approval: `all` approves automatically (the digest and the audit record are
still kept); `ask-changes` approves an all-read script with no file writes automatically and asks once per version for
anything else; `read-only` allows the all-read case and denies the rest. **An `ask` with nobody present becomes a
`deny`**, so a run never waits. Pausing every job needs no prompt under `all` or `ask-changes`, because it only stops
work; under `read-only` even a pause is denied.

A job runs as the agent it names, and that agent's own `permissions` are the whole profile. The read-only profile to
start from, pasted into `opencode.json`:

```json
{
  "agents": {
    "jobs": {
      "permissions": [
        { "action": "*", "resource": "*", "effect": "deny" },
        { "action": "read", "resource": "*", "effect": "allow" },
        { "action": "glob", "resource": "*", "effect": "allow" },
        { "action": "grep", "resource": "*", "effect": "allow" },
        { "action": "list", "resource": "*", "effect": "allow" },
        { "action": "jobs_status", "resource": "*", "effect": "allow" },
        { "action": "jobs_list", "resource": "*", "effect": "allow" },
        { "action": "jobs_get", "resource": "*", "effect": "allow" },
        { "action": "jobs_history", "resource": "*", "effect": "allow" },
        { "action": "jobs_pause", "resource": "*", "effect": "allow" }
      ]
    }
  }
}
```

The blanket deny comes first because OpenCode appends an agent's own rules after its base `* * allow`, and within that
list the later rule wins: an allow-only block would inherit the base allow and would not be read-only. Every rule after
it is the profile, and nothing that writes is in it.

### Recipes

A job that needs one more tool gets it from its agent, never from the job:

```json
{
  "agents": {
    "jobs-reviewer": {
      "permissions": [
        { "action": "*", "resource": "*", "effect": "deny" },
        { "action": "read", "resource": "*", "effect": "allow" },
        { "action": "grep", "resource": "*", "effect": "allow" }
      ]
    }
  }
}
```

Then point the job at `agent: jobs-reviewer`. A job's own `allow` list only narrows: it holds `deny` rules, and an
`allow` entry in it is refused with `JOBS_ALLOW_WIDENS`.

A run cannot answer an approval: an `ask` is denied and recorded as `JOBS_UNATTENDED`. Decide which actions the agent
may use unattended, and set its permissions deliberately rather than adding an allow only to silence a prompt.

## Scripts

A job's action may be a script instead of a prompt:

```yaml
action:
  type: script
  script:
    uses:
      - x.posts.get_users_bookmarks
      - host:mem_remember
    code: |
      const page = await tools.x.posts.get_users_bookmarks({ max_results: 100 });
      return { items: page.data?.length ?? 0 };
    timeoutMs: 5m
    limits: { maxCalls: 150, memoryMb: 64, maxOutputBytes: 65536 }
```

`uses` is the manifest of tools the script can reach: a family method (`<plugin id>.<method>`, split at the last dot) or
a host tool (`host:<exact tool id>`). `files` declares the files the script may read and write:

```yaml
files:
  bookmarks: { path: bookmarks.json, mode: readwrite, format: json, maxBytes: 1048576 }
```

A name matches `[a-z][a-z0-9_]{0,31}` (and is not `write`); at most 8 files; `mode` is `read`, `write` or `readwrite`;
`format` is `json` or `text`; `maxBytes` defaults to 1 MB and is at most 8 MB. A relative path resolves against the
job's directory; an absolute path must be inside it or a `scriptFilesRoots` root. A root is a full read/write grant to
that tree, so `/`, the home directory and its ancestors are refused. Symlinks at any component, `..`, `.git` and
`.OPENCODE` (case-folded), OpenCode's own folders and special files are refused (`JOBS_SCRIPT_FILE_PATH`). The file is snapshotted before the run and a write is
committed only on success, in one multi-file commit (validate all, temp and fsync each, keep each original aside, rename
all, roll back on a failure), with a conflict check (`JOBS_SCRIPT_FILE_CONFLICT`) and a per-file
`written`/`rolled_back`/`rollback_failed`/`not_attempted` outcome. The digest covers each resolved path, and a file outside the project also needs the agent's
`{ "action": "external_directory", "resource": "<folder>/*", "effect": "allow" }`, checked at approval and at every run.
A file job is approved automatically at load under `all` (and under `ask-changes` when it is all-read); a changing one
under `ask-changes` waits for `/jobs-approve`. Every slot re-resolves the script and reapplies access. A changed digest or
class can require `/jobs-approve <job>`; `read-only` revokes a changing script. The defaults are 100 calls, 64 MB, 64 KB and 8 MB of buffered
files; `maxCalls` may go to 1,000, `memoryMb` to 512, `maxOutputBytes` to 1 MiB and `maxFileBytes` to 32 MiB. The wall clock is `policy.timeout`, and `timeoutMs` can narrow
it. A script job may omit `agent`; it then runs as `build`. Its agent's rules must not deny its tools: the guarded
`jobs` profile is for prompt jobs.

A script that never yields is stopped by the job's timeout, not by pause: pause aborts an in-flight call, but a
synchronous loop is only interrupted by the deadline. Set `policy.timeout` to the bound the script needs.

Under the default `access: "all"` the approval is automatic and recorded; `ask-changes` asks once for a script that
changes something; `read-only` denies it. It is bound to `script:sha256:<digest>` of the source, the sorted manifest and
the declared files.
The record keeps each call's method, class, start, outcome, duration, size and a failure's code, never its input or
result; the result is capped at `maxOutputBytes` and framed as script output. It also keeps the run's `sessionID` and
`cost`. `/jobs-pause` aborts a run mid-call.

`jobs_run_script` runs one script once with the same approval and keeps no job. `jobs_approve` (and `/jobs-approve <job>`)
re-approves a script job after a change.

## Safety

- **An agent that does not deny by default is a warning**, `JOBS_AGENT_UNGUARDED`, not a refusal. Its jobs run with the
  agent's permissions; status names it and prints the read-only block to paste.
- **A job whose agent the host no longer lists is refused**, at file read and again when a slot starts, with
  `JOBS_AGENT_MISSING`. This can happen after a plugin update: OpenCode's running plugin can keep a stale agent list
  while its own API still lists the agent. Nothing runs; status names the agent, and the next step is `opencode reload`
  in a terminal, or a restart. Every slot re-checks, so jobs resume on their own once the agent is back.
- **A run never asks.** A tool the agent would ask about is denied inside the job's session with `JOBS_UNATTENDED`, and
  the run carries on and records it. Two `permission.hook("evaluate")` hooks exist: this one, matched to the sessions
  this plugin created for runs (a registry of their ids), and the tools RPC's, matched to a script's own call in flight.
  Neither turns an allow into a deny or a deny into an allow, and neither touches a session a person opened.
- **Agents unknown.** If the host cannot list its agents, nothing runs: the slot is recorded `skipped` with
  `JOBS_AGENTS_UNKNOWN`, and status says the agent list could not be read. It never guesses a block to paste for an
  agent that may be fine.
- **A run cannot schedule.** Inside a job session, the session's own rules deny all eight that create, change or
  multiply jobs: `jobs_create`, `jobs_update`, `jobs_delete`, `jobs_resume`, `jobs_extend`, `jobs_run_now`,
  `jobs_approve` and `jobs_run_script`.
- **The kill switch.** `/jobs-pause`, the `jobs_pause_all` tool and the palette's "Jobs: Pause or resume every job"
  (which asks first) all set one state: nothing new starts, and a run in flight is interrupted. Resume with `/jobs-pause`
  or `jobs_resume` with `{ "all": true }`; the tool follows `access`. Status says every job is paused and how to resume.
- **Job output is labelled.** A run's summary, a reminder and a notice are framed as output from a scheduled job, never
  as an instruction.

## Tools

Fourteen tools, namespace `jobs_`. With the default `access` (`all`) every one is allowed, like every other plugin's
tools; `access: "ask-changes"` makes the changes ask, and `"read-only"` denies them.

| Tool | What it does |
| --- | --- |
| `jobs_status` | The compact status: state, counts, how many agents need the block, and the one next step. |
| `jobs_list` | The jobs there are: id, name, state, agent and next run. Filter by state, or cap the list. |
| `jobs_get` | One job's definition, its runtime state and its last three runs. A script job also includes approval facts and a run's capped result. |
| `jobs_history` | Recent runs, with each summary labelled as job output. Status and its RPC name what a run did, never what was said in it. |
| `jobs_pause` | Pauses one job. |
| `jobs_pause_all` | Pauses every job at once: the kill switch. It runs without asking, because it only stops work. |
| `jobs_create` | Creates a job: name, schedule, action, agent, and optionally target, allow, policy, ends, expiry and jitter. |
| `jobs_update` | Replaces fields of a job a tool created. |
| `jobs_delete` | Deletes a job a tool created; its run records stay for history. |
| `jobs_run_now` | Runs a job once, now, as a manual run with its own slot: the schedule is untouched. An expired job is refused with `JOBS_EXPIRED`. |
| `jobs_resume` | Resumes a paused job, or every job with `{ "all": true }`. It follows `access`. |
| `jobs_extend` | Moves a job's expiry. |
| `jobs_approve` | Re-approves a script job after its source, manifest or declared files change, and prints the new digest. |
| `jobs_run_script` | Runs one script once, with the same approval and no job kept: the ad-hoc route. |

A job created with the tool — by the model or by a person — expires after seven days unless `expires` is set, and
status counts it as expiring. `jobs_extend` is the deliberate act that keeps it.

A job defined by a file cannot be changed or deleted by a tool: the file is its definition. It can be paused, and it
never expires on its own.

## Commands

| Command | What it does |
| --- | --- |
| `/jobs-status` | Posts the report into the session. |
| `/jobs-pause` | Pauses every job at once, or resumes them. |
| `/jobs-run <id>` | Runs a job now. Typing it is the approval for that run. |
| `/jobs-approve <id>` | Re-approves a script job after a source, manifest or file change. |

Typing a command is a person's own act. The model's `jobs_run_now` tool follows `access`: it asks under `ask-changes`.

The `/jobs` dialog shows the same report with `r` to refresh and `Esc` to close; its hint reads exactly
`r refresh · esc close`. It only reads: the kill switch is the palette command "Jobs: Pause or resume every job", which
asks before it changes anything.

## Job files

A job that belongs to a project is a Markdown file in `<project>/.opencode/jobs/`, and a job for every project is in
`~/.config/opencode/jobs/`. A file's name is the job's id, and one file holds one job. Commit it like any other file.

```markdown
---
name: Morning brief
cron: "0 7 * * 1-5"
tz: Europe/London
agent: jobs
policy:
  overlap: queue-one
  maxLate: 24h
  timeout: 10m
---
Summarise yesterday's work and today's calendar in five lines.
```

The YAML front matter holds the job's fields, and the body is the prompt. The schedule is written flat, as `cron`,
`every` or `at` with `tz` beside it, or nested under `schedule:` in the same shape a tool job takes. `every` is a fixed
interval: `tz` anchors its `anchor` (or its creation instant) in that zone, so `every: "24h"` keeps a 24-hour gap and
drifts by an hour across a daylight-saving change; use `cron` for a wall-clock repeat. `agent` is
required: that agent's own `permissions` are the run's profile. `policy` takes `catchup` (`latest` or `none`),
`maxLate` (one hour by default), `overlap` (`skip`, `queue-one`, `replace` or `allow`), `timeout` (30 minutes, or five
for a reminder) and `retries` (`max` and `backoff`). `ends` takes `at` or `times`, and `jitter` delays the start of a
run without moving its slot. `allow` holds deny rules only, and `expires` stops the job. `retries` takes `max` and
`backoff`: a failed run is retried for the same slot, with the next `attempt`, after the backoff. `notify` takes a
`sessionID`, and a run posts its outcome there as job output.

A duration is a number and a unit: `30s`, `30m`, `24h` or `7d`. A project file runs in its project unless it sets
`target.directory`; a global file runs wherever the leader is.

The file is the definition, so tools never edit or delete one: pausing a file job stores runtime state only. The job
folders are checked once a minute, and a file is parsed again only when its modification time changed; a change is
picked up within a minute. A file that cannot be read, does not parse, names a refused field or a missing agent is listed
by `/jobs-status` with its path, the line at fault and its code, and every other file still loads. An unguarded agent is
a warning and does not prevent the file from loading.

Run records are kept for 50 runs per job and 30 days, whichever keeps less. Retention never removes a run that is still
`running` or a job's newest run, and a removed record's session goes with it unless that session is busy.

## Status

`/jobs-status`, the `/jobs` dialog, the `jobs.scheduler` RPC's `status` method and the `jobs_status` tool render one
model. The tool keeps only state, counts, the number of agents to fix and the next step; the full report has nine rows:

```
Jobs status
- Runner: leader in /projects/app (pid 4121) since 2026-12-06T08:00:00.000Z
- Liveness: keep-alive every 20 minutes; last beat 2026-12-06T08:20:00.000Z ok
- Jobs: 2 total, 0 paused, 0 expiring, 0 invalid files
- Next runs: Morning brief at 2026-12-07T07:00:00.000Z
- Recent runs: Morning brief succeeded 4 s
- Failures needing attention: none
- Agents without default rules: none
- OpenCode: 2.2.5 (tested; supported range >=2.2.3 <2.3.0)
- Next step: Nothing to do.
```

Exactly one line is `Next step:`. It reads `Nothing to do.` when nothing needs you.

- `Runner` names the leader, its location and process, or that it stopped. When the kill switch is set, it starts
  `paused since <time>`.
- `Liveness` names the keep-alive period and whether the last touch worked. If jobs keep stopping, this is the row to
  read: raise `experimental.location_idle_timeout` above `keepAliveMinutes`, or set it to `false`.
- `Jobs` counts the jobs, how many are paused, how many are expiring and how many files could not be read.
- `Next runs` names the next five slots; `Recent runs` the last ten, with outcome, duration, late and skipped marks.
- `Failures needing attention` names the jobs whose recent runs failed, with the code and how many times.
- `Agents without default rules` names the job agents that do not deny by default, and prints the block to paste. When
  the host cannot list its agents it reads `unknown; the agent list could not be read`, and nothing runs until a
  restart answers.

## RPCs

Both are read-only, and both answer a `STATUS_UNAVAILABLE` failure with a `nextStep` when their report cannot be read.

| RPC | Methods | What they give |
| --- | --- | --- |
| `jobs.scheduler` | `status`, `list`, `history` | The status model, a summary of the jobs, and the recent runs of one job or all of them. |
| `jobs.scheduler.tools` | `describe` and all fourteen Jobs tools | A script's path to the plugin with no model. Only an allowed method runs. [Scripting](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/docs/scripting.md) covers it. |

The fields every plugin of this family shares are `version`, `host` (`version`, `range`, `tested`), `state`,
`unguardedAgents` and `nextStep`. Jobs has no service to connect to, so `state` is `ready`, or `disabled` when the
`enabled` option is `false`. Its own fields sit beside them: `jobs`, `runner`, `liveness`, `paused`, `nextRuns`,
`recentRuns`, `failures`, `missingAgents`, `scriptJobs`, `permissionsBlock` and `problems`. A run carries its
`sessionID` and `cost`; a script run also carries its per-call rows (method, class, start, duration, outcome, bytes and
a failure's code), its `error`, and its declared `files` (name, path, mode, bytes and hashes), never the content. `missingAgents` names the
agents a job uses that the host no longer lists, and `scriptJobs` counts the script jobs approved and waiting for a new
approval; both are empty or absent when there are none.

## Errors

Every message reads `CODE: What happened. Next step: What to do.`, with one next step. A run's failure is recorded with
its code and shown in status; it is not thrown at you.

| Code | When | Next step |
| --- | --- | --- |
| `OPTIONS_INVALID` | An option is unknown, or its value is the wrong type or outside its range. | Fix the plugin options in opencode.json; the message names the accepted values and gives an example. |
| `HOST_UNTESTED` | OpenCode is outside `>=2.2.3 <2.3.0`, and `allowUntestedHost` is not set. | Use a supported OpenCode, or set `"allowUntestedHost": true`. |
| `STATUS_UNAVAILABLE` | The status could not be read, or the plugin is not running in this location. | Restart OpenCode, then run `/jobs-status` again. |
| `JOBS_INVALID_SCHEDULE` | The schedule names two kinds or none, the cron expression is not five fields or never fires, the interval is under a minute, or the zone or time does not exist. | Use a five-field cron expression, an interval of at least a minute, and an IANA time zone such as `Europe/London`. |
| `JOBS_INVALID_JOB` | A field other than the schedule is missing or wrong — the name, the action, the agent, the policy, `ends` or `jitter` — or a tool tried to change or delete a job defined by a file. | Set the field the message names; it gives the accepted values. A file job is edited in its file. |
| `JOBS_INVALID_FILE` | A job file has no front matter, unclosed front matter, YAML that does not parse, or a field that is refused; the message names the file and the line. | Fix the file at the line the message names, then run `/jobs-status` again. |
| `JOBS_ALLOW_WIDENS` | A job's `allow` list holds an `allow` entry, and a job may only narrow its agent's rules. | Move the grant to the job agent's own `permissions` in opencode.json, and keep the job's list to deny rules. |
| `JOBS_TARGET_MISSING` | A job, session or agent the call names does not exist. | Run `jobs_list` to see the jobs there are, and create the session before naming it. |
| `JOBS_AGENT_UNGUARDED` | The job's agent does not deny by default; its jobs still run under its permissions. | Review the agent's permissions; `/jobs-status` prints a read-only block. |
| `JOBS_AGENT_MISSING` | OpenCode no longer lists the job's agent, which can happen after a plugin update. No job that names it runs. | Run `opencode reload` in a terminal, or restart OpenCode; every slot re-checks, so the next slot runs once the agent is back. |
| `JOBS_SCRIPT_FILE_PATH` | A declared file's path is outside the allowed roots, or has a symlink, `..`, `.git`, a special file, or OpenCode's own directories. | Fix the path; it is never opened. |
| `JOBS_SCRIPT_FILE_INVALID` | A declared JSON file is invalid, or a text write was not a string. | Fix the file or the value. |
| `JOBS_SCRIPT_FILE_TOO_LARGE` | A declared file or write is over its `maxBytes`. | Raise the cap or write less. |
| `JOBS_SCRIPT_FILE_CONFLICT` | The write target changed after the snapshot. | Nothing is written; let the next run read it. |
| `JOBS_SCRIPT_FILE_MODE` | The script wrote a `read` file. | Declare it `write` or `readwrite`, then approve again. |
| `JOBS_SCRIPT_BODY_IGNORED` | A script job file has a body, which is not a prompt. | Remove the body or move it into the code. |
| `JOBS_SCRIPT_LIMIT` | The script hit a call, memory, output or wall-clock limit. | Raise the limit, or make the script smaller. |
| `JOBS_SCRIPT_FAILED` | The script threw, or one of its calls failed. | Read the error in the run record, fix the script or its tool, then approve it again if it changed. |
| `JOBS_SCRIPT_INTERRUPTED` | The run was interrupted: the kill switch, a shutdown, or a leader change. | Run it again with `jobs_run_now`, or wait for the next slot. |
| `JOBS_SCRIPT_HOST_TOOL` | A `host:` entry names OpenCode's own shell, file, network or task tool, which a script may not reach. | Remove it; a script reaches MCP servers and plugin tools only. |
| `JOBS_SCRIPT_FAMILY_TOOL` | A `host:` entry names a tool a loaded plugin serves through its tools RPC. | Use `<plugin id>.<method>` instead, so the plugin's shaping and budgets apply. |
| `JOBS_SCRIPT_DENIED` | The job's agent denies a tool the script's manifest names. A session allow beats an agent deny, so the script is refused rather than granted it. | Remove the deny rule for that tool, or point the job at an agent that allows it. |
| `JOBS_SCRIPT_UNKNOWN_TOOL` | A manifest entry is not a method the plugin's tools RPC describes, or a tool the host lists. | Use `<plugin id>.<method>` or `host:<tool id>`, then approve the script again. |
| `JOBS_SCRIPT_UNAPPROVED` | The script's source, its manifest or a tool's class changed since it was approved, so the slot was skipped. | Approve it again with the `jobs_approve` tool or `/jobs-approve <job>`. |
| `JOBS_SCRIPT_REVOKED` | The script's agent now denies one of its tools, so every run is skipped until that changes. | Remove the deny rule, or point the job at an agent that allows the tool, then approve it again. |
| `JOBS_UNATTENDED` | A run called a tool its agent asks about. The call was denied, and the run continued. | Decide with the person whether that agent may have it. A read goes in the agent's own `permissions`; a write belongs with a person, not a run. |
| `JOBS_DISABLED` | Every job is paused, or the job the call names is. | Resume with `/jobs-pause` or the `jobs_resume` tool, then retry. |
| `JOBS_EXPIRED` | The job has no slot left: its `at` has passed, its `ends` was reached, or its expiry has passed. | Extend it with `jobs_extend`, or create a new job. |
| `JOBS_TIMEOUT` | A run did not finish inside its `policy.timeout`, so it was interrupted. It counts toward the five-failure pause. | Raise `timeout` for that job, or make its prompt do less. |
| `JOBS_AGENTS_UNKNOWN` | The host could not list its agents, so no job ran and no agent was judged. | Restart OpenCode, then run `/jobs-status` again. |
| `JOBS_UNCHECKED` | A tool that changes something was called with no tool call to check its permission against. | Call it from a session, where its action is checked, and never from a script. |
| `JOBS_STORAGE_VERSION` | The job store was written by a newer version of the plugin. | Update the plugin to the version that wrote the store, or clear its storage to start again. |

The tools RPC's own codes are in [Scripting](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/docs/scripting.md#errors).
