# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.0] - Unreleased

### Added

- The plugin loads on OpenCode `>=2.2.3 <2.3.0`, tested on 2.2.3, 2.2.4 and 2.2.5, and refuses a host outside the range
  unless `allowUntestedHost` is set.
- `/jobs-status` and the `/jobs` dialog ("Jobs: Status" in the palette): a status model with the jobs there are, when
  they next run, the recent runs, the agents without the default rules, the OpenCode check and one next step.
- The status RPC `jobs.scheduler`, with the fields this family of plugins shares: `status`, `list` and `history`.
- The tools RPC `jobs.scheduler.tools`, which lets a script reach the plugin with no model, as a session and its agent.
- The job model: a schedule (a five-field cron expression with a time zone, an interval, or a one-off time), an action
  (`prompt`, `command` or `remind`), the agent that runs it, and its policy (catch-up, overlap, timeout, retries), with
  slots that stay correct across daylight saving.
- Job files: a job committed as Markdown in `.opencode/jobs`, with its fields in the front matter and its prompt in the
  body. A file that cannot be read is listed with its path and the line at fault, and every other file still loads.
- Run records in OpenCode's own storage, with a schema version, a migration, and retention that keeps the last 50 runs
  of a job and the last 30 days, whichever keeps less.
- The options `enabled`, `allowUntestedHost` and `timezone`.
- The read-only agent profile every job runs as, documented with the blanket deny that makes it closed, and refused
  with `JOBS_AGENT_UNGUARDED` when a job's agent does not deny by default.
- Unattended safety: a run never waits for a permission prompt, and a tool its agent asks about is denied in the job's
  session with `JOBS_UNATTENDED` and recorded. The evaluate hook that does it is matched to the plugin's own run
  sessions, and only ever tightens.
- A run's session rules: the job's deny-only list, plus the tools a run may never call, so a prompt cannot create,
  change or multiply jobs.
- The kill switch: `/jobs-pause` pauses every job at once, interrupting what is in flight and starting nothing, and
  status says so until it is run again.
- Job output framed as job output: a reminder posted into a session says what it is and where it came from.
- The family icon kit's mark and its 128 and 256 pixel rasters, declared in `opencode.icons` and exported from the
  package, with the `jelly` declaration documented in `docs/jelly.md`. Jobs declares no vendor, and the package carries
  no vendor marks.
