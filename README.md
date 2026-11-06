# Jobs for OpenCode

Run prompts, slash commands and reminders on cron, interval and one-off schedules, inside OpenCode, with run history
and unattended permissions.

Unofficial; not affiliated with OpenCode or Anomaly.

## Requirements

- OpenCode `>=2.2.3 <2.3.0`, tested on 2.2.3, 2.2.4 and 2.2.5. Outside that range the plugin does not start, unless
  you set `allowUntestedHost`.
- macOS or Linux.
- **Jobs run while OpenCode is running.** Nothing runs while the OpenCode service is stopped, and nothing runs after a
  reboot until a client opens a project again.

## Install

```sh
opencode plugin add @joe-broadhead/opencode-jobs
```

Run `opencode reload`, or restart OpenCode, then run `/jobs-status`.

`opencode plugin add opencode-jobs` (unscoped) installs a different, unrelated systemd plugin.

**Update** with `opencode plugin update @joe-broadhead/opencode-jobs`, then run `opencode reload`.

## Use

| Command | What it does |
| --- | --- |
| `/jobs-status` | Posts the status report into the session: how many jobs there are, when they next run, the agents without the default rules, the OpenCode check and the next step. |
| `/jobs-pause` | Pauses every job at once, or resumes them: nothing new starts and a run in flight is interrupted. |
| `/jobs`, or "Jobs: Status" in the command palette | Opens the same report in a dialog. Press `r` to refresh it and `Esc` to close it. |

## Permissions

A job runs as the agent it names, and that agent's own `permissions` are its whole profile. Jobs ships no permission
rules and changes none of yours. The profile to start from is read-only:

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

The first rule denies everything, because an agent's own rules are applied after OpenCode's base rule that allows
everything, and the later rule wins. The rules after it are the profile: reading, searching and the plugin's own reads,
and nothing that writes. Add a rule only when a job needs it, and add it to that agent alone.

A job whose agent does not deny by default is refused with `JOBS_AGENT_UNGUARDED`, and `/jobs-status` prints the block
to paste for that agent.

A run never asks. If a tool the agent asks about is called inside a job's session, the plugin denies it with
`JOBS_UNATTENDED` and the run carries on, so a job can never sit waiting for an approval nobody is there to give. That
is the plugin's only permission hook, and it touches no session a person opened.

[Configuration](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/docs/configuration.md#permissions) explains
each rule and the recipes that widen one action.

## Configure

Set options with the object form of the plugin entry:

```json
{
  "plugins": [{ "package": "@joe-broadhead/opencode-jobs", "options": { "enabled": true } }]
}
```

[docs/configuration.md](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/docs/configuration.md) lists every
option, the job file format and every error.

## Organisation rollout

Put the plugin entry in the system config: `/Library/Application Support/opencode/opencode.json` on macOS, or
`/etc/opencode/opencode.json` on Linux.

```json
{
  "plugins": ["@joe-broadhead/opencode-jobs"]
}
```

Add the read-only agent block from [Permissions](#permissions) to the same config, so every member has it before their
first job. A user's own top-level `permissions` still apply, and a `deny` there always wins.

## Troubleshooting

Run `/jobs-status` first. Its last line is the next step.

| Status or error | What to do |
| --- | --- |
| Jobs: none yet | Nothing is scheduled. |
| The status says the plugin is disabled | The option `enabled` is `false`. Set it to `true`, or remove it, then restart OpenCode. |
| The status says every job is paused | `/jobs-pause` was run. Run it again to resume them; the slots that fell due meanwhile run once, as a late run, or are recorded as missed. |
| Agents without default rules | Not a jobs error: the plugin adds no rules. Give the job's agent its own `permissions`, starting with the block in [Permissions](#permissions). |
| `JOBS_AGENT_UNGUARDED` | The job's agent does not deny by default, so the job is refused rather than run into prompts. Paste the block `/jobs-status` prints for that agent. |
| `JOBS_UNATTENDED` | A run tried a tool its agent asks about. Nothing waits: the call was denied. Add an `allow` rule for that tool to the job agent's own `permissions` if the job needs it. |
| OpenCode: untested | OpenCode is not 2.2.3, 2.2.4 or 2.2.5. Inside `>=2.2.3 <2.3.0` the plugin runs normally; outside it, it runs only because `allowUntestedHost` is set. |
| `/jobs` is missing | The plugin did not start. Run `/plugins` to see the error. |
| `OPTIONS_INVALID` | An option is unknown or has a wrong value. The message names the option and the accepted values. |
| `HOST_UNTESTED` | Your OpenCode is outside `>=2.2.3 <2.3.0`, so the plugin did not start. Use OpenCode `>=2.2.3 <2.3.0`, or set `"allowUntestedHost": true` to run anyway. |
| `STATUS_UNAVAILABLE` | The status could not be read, or the plugin is not running. Follow the next step in the message. |

## What this is not

- **Not a shell or cron replacement.** Core's schedules run a shell command; a job runs an agent under that agent's
  permissions.
- **Not an OS scheduler.** Nothing runs while OpenCode is closed.
- **Not a workflow engine.** A job may start a durable, multi-step `wfl` workflow; it does not implement one.
- **Not a timer.** Utilities' project timers are polled with `utilities_timer_check`; a job happens by itself.

## Uninstall

1. Remove the plugin: `opencode plugin remove @joe-broadhead/opencode-jobs`, then `opencode reload`.
2. Remove the agent block you copied into `opencode.json`, or the job agent's Markdown file.

## Links

- [Configuration](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/docs/configuration.md)
- [Scripting](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/docs/scripting.md)
- [Contributing](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/CONTRIBUTING.md)
- [Security](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/SECURITY.md)
- [Changelog](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/CHANGELOG.md)
- [MIT license](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/LICENSE)
