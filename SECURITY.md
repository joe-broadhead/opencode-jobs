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
  one line with no URL credentials, query or token. A run's summary is job output and is returned only by the
  `jobs_history` tool, labelled as such; the status RPC's `status` and `history` carry none.
- Nothing the plugin writes is a secret. Do not put a secret in a job prompt: a prompt is stored with the job and
  reaches the model.

## Permissions

What a run can do is the agent's own `permissions`, and nothing else:

1. **Every tool is allowed by default.** OpenCode's base rule allows everything, and the plugin's block follows the
   `access` option: `all` (the default) allows every `jobs_` tool; `ask-changes` asks for a change and allows the reads
   and pauses; `read-only` allows the reads and denies every change. The block never weakens a deny you set. A job
   names one agent, and that agent's rules are the run's profile: with a default agent, a run can use every tool the
   agent can. The documented profile is read-only and starts with a blanket deny, because an agent's own rules are
   applied after OpenCode's base rule that allows everything.
2. **A job whose agent does not deny by default is a warning, not a refusal.** It runs, and `/jobs-status` names it
   with the read-only block to paste. Treat that warning seriously: such a job's runs can use every tool its agent can,
   including writes and sends. A job whose agent the host no longer lists is still refused with `JOBS_AGENT_MISSING`.
3. **A run never asks.** Two `evaluate` hooks exist, and only these. One turns an `ask` inside a session this plugin
   created for a run into a deny, in the plugin's own words, so an unattended run cannot wait for an approval; the other
   turns an `ask` on one of the tools RPC's own script calls in flight into a deny, because no one can answer it. Each
   matches only its own call or session, considers only those checks, and only ever narrows: an allow stays an allow and
   a deny stays a deny. They are a deliberate exception to the family's rule against permission hooks, matched by the
   repository's forbidden-API scan to their two files and to the bundle that inlines both.
4. **A run cannot schedule.** Inside a job session, the session's own rules deny creating, updating, deleting,
   extending, resuming and running a job, so a prompt that asks for one cannot grow the schedule.
5. **Changing a job follows `access`.** Under the default `all`, the tools that create, update, delete, run and
   resume a job are allowed without a prompt. Under
   `ask-changes` they ask, and the prompt is the yes; under `read-only` they are denied. Pausing is allowed under `all`
   and `ask-changes`, because it only stops work.
6. **The kill switch** stops every job at once, and is never silent: `/jobs-pause` posts what it did into the session,
   and status says every job is paused and how to resume them. The `enabled` option stops the runner at setup instead.
7. **Job output is labelled.** A summary, a reminder and a notice are framed as output from a scheduled job, not as an
   instruction from the person.

## What runs unattended

With the default `access: "all"`, a script job is approved without a prompt, and so is an all-read script under
`ask-changes`. The approval record keeps the digest, the resolved tools, the declared files and whether approval was
automatic; a changed source, manifest or file declaration needs a new approval under the same policy.
The files a script may touch are the job's declared files only, under the path policy in
[docs/scripting.md](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/docs/scripting.md#declared-files); a write
is committed only after a successful run and never over a file that changed since the run read it. Each file is replaced
by rename; a multi-file commit attempts to roll back if a rename fails.
An `ask` with nobody present still becomes a `deny`.

## Scripts

The tools RPC (`jobs.scheduler.tools`, see
[docs/scripting.md](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/docs/scripting.md)) gives a script the
reads with no model, and adds no authority:

- A script names a session that names an agent, and runs as them, under that agent's rules and the session's own.
- An ask on a script's call is denied, not prompted, because no one is there to answer it: the call is marked, and the
  tools RPC's permission hook turns its ask into a deny. The hook only ever tightens.
- The methods are `describe` and all fourteen Jobs tools. Only an allowed method runs; a job's run session denies the
  tools that create, change or multiply jobs.
- The RPC is reachable only by callers of the OpenCode server API, who already hold the server's full authority. The
  session is not a login: it scopes a script to what its agent may do.
