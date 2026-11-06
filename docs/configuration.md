# Configuration

The plugin's options, its permission model, its two RPCs and every error it raises.

## Options

Set options with the object form of the plugin entry. Every option is optional.

```json
{
  "plugins": [{ "package": "@joe-broadhead/opencode-jobs", "options": { "enabled": false } }]
}
```

| Option | Values | Default | Effect |
| --- | --- | --- | --- |
| `enabled` | `true` or `false` | `true` | `false` stops the runner and leaves the status command, the dialog and both RPCs working. |
| `allowUntestedHost` | `true` or `false` | `false` | Starts on an OpenCode version outside `>=2.2.3 <2.3.0`, with the `OpenCode` status row saying it is outside the range. |
| `timezone` | An IANA zone name, such as `Europe/London` | The server's zone | The zone a job that names none runs in. A job's own `tz` wins. |
| `concurrency` | A whole number from 1 to 8 | `2` | How many runs may be in flight at once, across every job. It bounds cost and file contention, and a run that arrives while the cap is reached waits for the next free slot. |

A wrong option fails setup with `OPTIONS_INVALID`, which names the option and the accepted values. Nothing runs until it
is fixed.

## Permissions

This plugin ships no permission rules, inserts none into any agent, and changes nothing you configured. A job runs as
the agent it names, and that agent's own `permissions` are its whole profile.

The read-only profile to start from, pasted into `opencode.json`:

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

A job runs as one named agent, and that agent's rules are the only profile it gets. Add a rule to the agent only when a
job needs it, and add it to that agent alone.

## Safety

- **A job whose agent does not deny by default is refused**, at create and again when a slot starts, with
  `JOBS_AGENT_UNGUARDED`. Nothing runs. Status names the agent and prints the block to paste.
- **A run never asks.** A tool the agent would ask about is denied inside the job's session with `JOBS_UNATTENDED`, and
  the run carries on and records it. One `permission.hook("evaluate")` does this, matched to the sessions this plugin
  created for runs. It never turns an allow into a deny or a deny into an allow, and it never touches a session a person
  opened.
- **A run cannot schedule.** Inside a job session, the session's own rules deny `jobs_create`, `jobs_update`,
  `jobs_delete`, `jobs_resume`, `jobs_extend` and `jobs_run_now`.
- **A job may only narrow.** A job's `allow` list holds deny rules and nothing else. An `allow` entry is refused with
  `JOBS_ALLOW_WIDENS`, because a session rule that allows would override the agent's deny.
- **The kill switch.** `/jobs-pause` pauses every job at once: nothing new starts, and a run in flight is interrupted.
  Run it again to resume; status says every job is paused and how to resume them. The `enabled` option stops the runner
  at setup instead.
- **Job output is labelled.** A run's summary, a reminder and a notice are framed as output from a scheduled job, never
  as an instruction.

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
run without moving its slot.

A duration is a number and a unit: `30s`, `30m`, `24h` or `7d`. A project file runs in its project unless it sets
`target.directory`; a global file runs wherever the leader is.

The file is the definition, so tools never edit or delete one: pausing a file job stores runtime state only. A file
that cannot be read, does not parse, or names a field that is refused is listed by `/jobs-status` with its path and the
line at fault, and every other file still loads.

## Status

`/jobs-status`, the `/jobs` dialog and the `jobs.scheduler` RPC's `status` method render one model:

```
Jobs status
- Jobs: none yet
- Next runs: none
- Recent runs: none
- Agents without default rules: none
- OpenCode: 2.2.5 (tested; supported range >=2.2.3 <2.3.0)
- Next step: Nothing to do.
```

Exactly one line is `Next step:`. It reads `Nothing to do.` when nothing needs you.

`- Jobs` counts the jobs there are, how many are paused, how many are expiring and how many files could not be read.
`- Next runs` and `- Recent runs` name the next five slots and the last ten runs, with each run's outcome.

## RPCs

Both are read-only, and both answer a `STATUS_UNAVAILABLE` failure with a `nextStep` when the status cannot be read.

| RPC | Methods | What they give |
| --- | --- | --- |
| `jobs.scheduler` | `status`, `list`, `history` | The status model, a summary of the jobs, and the recent runs of one job or all of them. |
| `jobs.scheduler.tools` | `describe` | A script's path to the plugin with no model. [Scripting](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/docs/scripting.md) covers it. |

The fields every plugin of this family shares are `version`, `host` (`version`, `range`, `tested`), `state`,
`unguardedAgents` and `nextStep`. Jobs has no service to connect to, so `state` is `ready`, or `disabled` when the
`enabled` option is `false`.

## Errors

Every message reads `CODE: What happened. Next step: What to do.`, with one next step.

| Code | When | Next step |
| --- | --- | --- |
| `OPTIONS_INVALID` | An option is unknown, or its value is the wrong type. | Fix the plugin options in opencode.json; the message names the accepted values and gives an example. |
| `HOST_UNTESTED` | OpenCode is outside `>=2.2.3 <2.3.0`, and `allowUntestedHost` is not set. | Use a supported OpenCode, or set `"allowUntestedHost": true`. |
| `STATUS_UNAVAILABLE` | The status could not be read, or the plugin is not running in this location. | Restart OpenCode, then run `/jobs-status` again. |
| `JOBS_INVALID_SCHEDULE` | The schedule names two kinds or none, the cron expression is not five fields or never fires, the interval is under a minute, or the zone or time does not exist. | Use a five-field cron expression, an interval of at least a minute, and an IANA time zone such as `Europe/London`. |
| `JOBS_INVALID_JOB` | A field other than the schedule is missing or wrong: the name, the action, the agent, the policy, `ends` or `jitter`. | Set the field the message names; it gives the accepted values. |
| `JOBS_INVALID_FILE` | A job file has no front matter, unclosed front matter, YAML that does not parse, or a field that is refused; the message names the file and the line. | Fix the file at the line the message names, then run `/jobs-status` again. |
| `JOBS_ALLOW_WIDENS` | A job's `allow` list holds an `allow` entry, and a job may only narrow its agent's rules. | Move the grant to the job agent's own `permissions` in opencode.json, and keep the job's list to deny rules. |
| `JOBS_AGENT_UNGUARDED` | The job's agent does not deny by default, or there is no such agent, so a job under it is refused instead of run into denied prompts. | Give the agent the read-only block, starting with the blanket deny, or point the job at an agent that has it; `/jobs-status` prints it. |
| `JOBS_UNATTENDED` | A run called a tool its agent asks about. The call was denied, and the run continued. | Add an `allow` rule for that tool to the job agent's own `permissions`, and only if the job needs it. |
| `JOBS_TARGET_MISSING` | A `remind` action or a `notify` target names no session. | Set the session id, and create that session if it is gone. |
| `JOBS_STORAGE_VERSION` | The job store was written by a newer version of the plugin. | Update the plugin to the version that wrote the store, or clear its storage to start again. |

The tools RPC's own codes are in [Scripting](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/docs/scripting.md#errors).
