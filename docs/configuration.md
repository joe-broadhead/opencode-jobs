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
| `keepAliveMinutes` | A whole number of minutes from 1 to 60 | `20` | How often the plugin touches its location with an empty session, so the location is never idle-unloaded and the runner keeps running (D2). Keep it below `experimental.location_idle_timeout`; 20 is below the default 60. |

A wrong option fails setup with `OPTIONS_INVALID`, which names the option and the accepted values. Nothing runs until it
is fixed.

## Permissions

The plugin inserts nothing that grants anything, and it never weakens a rule you set. It inserts one block of rules that
**ask**, directly after each agent's base `* * allow`:

```json
[
  { "action": "jobs_*", "resource": "*", "effect": "ask" },
  { "action": "jobs_status", "resource": "*", "effect": "allow" },
  { "action": "jobs_list", "resource": "*", "effect": "allow" },
  { "action": "jobs_get", "resource": "*", "effect": "allow" },
  { "action": "jobs_history", "resource": "*", "effect": "allow" },
  { "action": "jobs_pause", "resource": "*", "effect": "allow" },
  { "action": "jobs_pause_all", "resource": "*", "effect": "allow" }
]
```

Every later rule still wins, because the last match wins, so an agent's own `deny` or `allow` is untouched. An agent
without a base allow gets nothing: there, unlisted tools are not allowed anyway, and the block's `ask` would turn a
deny into a prompt. Pausing is allowed because it is always safe; creating, updating, deleting, running, resuming and
extending ask, and the prompt is the yes.

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

Never add an `allow` for a write to get a job through an approval. A run cannot ask, so the approval would be denied and
the run would record `JOBS_UNATTENDED`. Leave the write out of the profile; a job that must write needs a person.

## Safety

- **A job whose agent does not deny by default is refused**, at create and again when a slot starts, with
  `JOBS_AGENT_UNGUARDED`. Nothing runs. Status names the agent and prints the block to paste.
- **A run never asks.** A tool the agent would ask about is denied inside the job's session with `JOBS_UNATTENDED`, and
  the run carries on and records it. One `permission.hook("evaluate")` does this, matched to the sessions this plugin
  created for runs. It never turns an allow into a deny or a deny into an allow, and it never touches a session a person
  opened.
- **A run cannot schedule.** Inside a job session, the session's own rules deny `jobs_create`, `jobs_update`,
  `jobs_delete`, `jobs_resume`, `jobs_extend` and `jobs_run_now`.
- **The kill switch.** `/jobs-pause`, the `jobs_pause_all` tool and the dialog's `p` all set one state: nothing new
  starts, and a run in flight is interrupted. Run it again to resume; status says every job is paused and how to resume.
- **Job output is labelled.** A run's summary, a reminder and a notice are framed as output from a scheduled job, never
  as an instruction.

## Tools

Twelve tools, namespace `jobs_`. Reads are allowed by the default rules; every other tool asks.

| Tool | What it does |
| --- | --- |
| `jobs_status` | The compact status: state, counts, how many agents need the block, and the one next step. |
| `jobs_list` | The jobs there are: id, name, state, agent and next run. Filter by state, or cap the list. |
| `jobs_get` | One job: its definition, its runtime state and its last three runs. |
| `jobs_history` | Recent runs, with each summary labelled as job output. |
| `jobs_pause` | Pauses one job. |
| `jobs_pause_all` | Pauses every job at once: the kill switch. |
| `jobs_create` | Creates a job: name, schedule, action, agent, and optionally target, allow, policy, ends, expiry and jitter. |
| `jobs_update` | Replaces fields of a job a tool created. |
| `jobs_delete` | Deletes a job a tool created; its run records stay for history. |
| `jobs_run_now` | Makes a job's next slot this moment. |
| `jobs_resume` | Resumes a paused job. |
| `jobs_extend` | Moves a job's expiry. |

A tool job created by the model expires after seven days, and status counts it as expiring. `jobs_extend` is the
deliberate act that keeps it.

A job defined by a file cannot be changed or deleted by a tool: the file is its definition. It can be paused, and it
never expires on its own.

## Commands

| Command | What it does |
| --- | --- |
| `/jobs-status` | Posts the report into the session. |
| `/jobs-pause` | Pauses every job at once, or resumes them. |
| `/jobs-run <id>` | Runs a job now. Typing it is the approval for that run. |

Typing a command is a person's own act. The model's `jobs_run_now` tool asks instead, because there the prompt is the
yes.

The `/jobs` dialog shows the same report, with `r` to refresh, `p` to pause or resume every job, and `Esc` to close.

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
`every` or `at` with `tz` beside it, or nested under `schedule:` in the same shape a tool job takes. `agent` is
required: that agent's own `permissions` are the run's profile. `policy` takes `catchup` (`latest` or `none`),
`maxLate` (one hour by default), `overlap` (`skip`, `queue-one`, `replace` or `allow`), `timeout` (30 minutes, or five
for a reminder) and `retries` (`max` and `backoff`). `ends` takes `at` or `times`, and `jitter` delays the start of a
run without moving its slot. `allow` holds deny rules only, and `expires` stops the job.

A duration is a number and a unit: `30s`, `30m`, `24h` or `7d`. A project file runs in its project unless it sets
`target.directory`; a global file runs wherever the leader is.

The file is the definition, so tools never edit or delete one: pausing a file job stores runtime state only. A file
that cannot be read, does not parse, names a field that is refused, or names an agent that does not deny by default is
listed by `/jobs-status` with its path, the line at fault and its code, and every other file still loads.

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
- `Agents without default rules` names the job agents that do not deny by default, and prints the block to paste.

## RPCs

Both are read-only, and both answer a `STATUS_UNAVAILABLE` failure with a `nextStep` when their report cannot be read.

| RPC | Methods | What they give |
| --- | --- | --- |
| `jobs.scheduler` | `status`, `list`, `history` | The status model, a summary of the jobs, and the recent runs of one job or all of them. |
| `jobs.scheduler.tools` | `describe`, `jobs_status`, `jobs_list`, `jobs_get`, `jobs_history` | A script's path to the plugin with no model. [Scripting](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/docs/scripting.md) covers it. |

The fields every plugin of this family shares are `version`, `host` (`version`, `range`, `tested`), `state`,
`unguardedAgents` and `nextStep`. Jobs has no service to connect to, so `state` is `ready`, or `disabled` when the
`enabled` option is `false`. Its own fields sit beside them: `jobs`, `runner`, `liveness`, `paused`, `nextRuns`,
`recentRuns`, `failures`, `permissionsBlock` and `problems`.

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
| `JOBS_AGENT_UNGUARDED` | The job's agent does not deny by default, or there is no such agent, so a job under it is refused instead of run into denied prompts. | Give the agent the read-only block, starting with the blanket deny, or point the job at an agent that has it; `/jobs-status` prints it. |
| `JOBS_UNATTENDED` | A run called a tool its agent asks about. The call was denied, and the run continued. | Add an `allow` rule for that tool to the job agent's own `permissions`, and only if the job needs it. |
| `JOBS_DISABLED` | Every job is paused, or the job the call names is. | Resume with `/jobs-pause` or the `jobs_resume` tool, then retry. |
| `JOBS_EXPIRED` | The job has no slot left: its `at` has passed, its `ends` was reached, or its expiry has passed. | Extend it with `jobs_extend`, or create a new job. |
| `JOBS_TIMEOUT` | A run did not finish inside its `policy.timeout`, so it was interrupted. | Raise `timeout` for that job, or make its prompt do less. |
| `JOBS_STORAGE_VERSION` | The job store was written by a newer version of the plugin. | Update the plugin to the version that wrote the store, or clear its storage to start again. |

The tools RPC's own codes are in [Scripting](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/docs/scripting.md#errors).
