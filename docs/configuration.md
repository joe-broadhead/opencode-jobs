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

The tools RPC's own codes are in [Scripting](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/docs/scripting.md#errors).
