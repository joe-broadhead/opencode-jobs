# Security

## Supported versions

Fixes go into the newest release. Older releases are not patched.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub private vulnerability reporting: open the repository's **Security**
tab and choose **Report a vulnerability**. Do not open a public issue. Include the plugin version, the OpenCode
version, your plugin options and the steps to reproduce. Never include job prompts, run transcripts or other content.

Vulnerabilities in OpenCode itself are out of scope. Report those to the OpenCode project.

## Data handling

- The plugin holds no credential and runs no network request of its own. A run uses the model and the tools that the
  agent it names already has.
- A job is a name, a schedule and an action. Jobs created through a tool live in OpenCode's own storage; a job
  committed with a project lives in a Markdown file at `.opencode/jobs/<name>.md` in that project, where the
  repository's own review covers it.
- Status names jobs, agents, times and outcomes. It shows no prompt and no transcript, and a failure's reason is cut to
  one line with no URL credentials, query or token.
- Nothing the plugin writes is a secret. Do not put a secret in a job prompt: a prompt is stored with the job and
  reaches the model.

## Permissions

What a run can do is the agent's own `permissions`, and nothing else:

1. **A job names one agent**, and that agent's rules are the run's profile. The plugin ships no rules, inserts none into
   any agent, and never weakens a deny. The documented profile is read-only and starts with a blanket deny, because an
   agent's own rules are applied after OpenCode's base rule that allows everything.
2. **Changing a job needs a person.** Creating, updating, deleting, running and resuming a job ask for approval, and
   the prompt is the yes. Pausing is always allowed.

## Scripts

The tools RPC (`jobs.scheduler.tools`, see
[docs/scripting.md](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/docs/scripting.md)) gives a script the
reads with no model, and adds no authority:

- A script names a session that names an agent, and runs as them, under that agent's rules and the session's own.
- An ask on a script's call is denied, not prompted, because no one is there to answer it. The permission hook that
  does this touches only one of the RPC's own calls in flight, and only ever turns an ask into a deny.
- Only reads are methods. No write and no run-now is a method, even with an allow rule.
- The RPC is reachable only by callers of the OpenCode server API, who already hold the server's full authority. The
  session is not a login: it scopes a script to what its agent may do.
