# Architecture

One leader runs the jobs, one record per slot proves it, and two surfaces read one model. This page is the map; the
code comments carry the detail.

## Components

| File | What it does |
| --- | --- |
| `src/plugin.ts` | Setup: options, the store's schema, the surfaces, the leader, the runner, the keep-alive and adoption. Returns the cleanup that undoes all of it. |
| `src/jobs/leader.ts` | One leader per process (a synchronous `globalThis` lock) and a lease in storage across processes. A step-down stops the runner and lets the next leader adopt. |
| `src/jobs/runner.ts` | The loop: read the jobs, work out each one's due slots, apply the policies, start runs, sleep until the next slot or 30 s. |
| `src/jobs/execute.ts` | One run: the slot record written before anything starts, the session, the prompt, the timeout, the outcome and the summary. |
| `src/jobs/adopt.ts` | On becoming leader: re-attach to runs left `running`, finalise each once from the session's outcome. |
| `src/jobs/keepalive.ts` | An empty session created and removed every `keepAliveMinutes`, so the leader's location is never idle-unloaded. |
| `src/jobs/report.ts` | Reads the store once for every surface: the status model, the jobs list and the run history. |
| `src/jobs/actions.ts` | Every change: create, update, delete, pause, resume, extend, run now, pause all. |
| `src/jobs/tools.ts` | The twelve tools and the four tools-RPC reads, over `actions.ts` and `report.ts`. |
| `src/jobs/safety.ts` | The run session and the one evaluate hook. |
| `src/host/permissions.ts` | The default rules the plugin inserts, and the guarded-agent check. |
| `src/status.ts` | The status model and its nine rows. |
| `src/rpc.ts`, `src/commands.ts`, `src/tui.tsx` | The status RPC, the three commands, and the dialog. |

## The run record is the dedup point

A run's key is `run/<job>/<slot ISO>`. The record is written `queued` with the leader's token **before** anything
starts, the write is allowed to be visible, and the record is read back. A write that comes back with another token
means another leader owns the slot, and this one does nothing. A terminal record means the slot is done.

`ctx.storage` has no compare-and-set, so the in-process lock is what is exact; the lease makes overlap across processes
rare, and the record decides the slot when it happens.

## What a run does

1. Check that the job's agent still denies by default, or record the slot as skipped with `JOBS_AGENT_UNGUARDED`.
2. Create the run's session as that agent, as a child of the one parked `Jobs` parent, with the job's deny-only rules
   and the metadata that marks it as a run session.
3. Prompt it, or run its command, or post a reminder.
4. `session.wait` against `policy.timeout`; on a timeout, interrupt and record `timed_out`.
5. Read `outcome` — the host's word is the source of truth — and the last assistant text as the summary, then write the
   record.

A run that outlives its instance writes nothing: the next leader adopts the record and finalises it once.

## Unattended safety

A job runs as the agent it names, and that agent's `permissions` are the whole profile. Session rules only deny: the
job's own deny list plus the tools that would let a run create, change or run another job. One
`permission.hook("evaluate")` turns an `ask` inside a run session into a `deny` with `JOBS_UNATTENDED`. It matches a
process-wide registry of the sessions this plugin created for runs — `globalThis`, so a hot reload keeps it, and
adoption registers an adopted session again — and it only ever tightens.

## Liveness

`experimental.location_idle_timeout` (60 minutes by default) unloads a location that has done nothing. The keep-alive
is the one workaround this design cannot do without: an empty `session.create` + `session.remove` counts as activity
and costs no model call. It runs every `keepAliveMinutes`, capped at an hour, and the `Liveness` status row names the
period and the last beat. If the location unloads anyway, the runner restarts when a client opens the project, and the
missed slot runs once inside `maxLate`.

## Platform facts

Each was measured on isolated stock binaries; the spike files are in the design repository.

| # | Fact | Consequence |
| --- | --- | --- |
| F1 | A plugin loads lazily, when its location is first touched. | Status survives a location that never loaded; runs start when it does. |
| F2 | One instance per location; `globalThis` is shared by the process. | The in-process leader lock is exact. |
| F3 | `ctx.storage` is global to the plugin, with no compare-and-set. | One writer (the leader), one key per job and run, and a read-back after the claim. |
| F4 | Sessions can be created in another location. | The leader can run a job in its `target.directory`. |
| F5 | `create` → `prompt` → `wait` → `outcome` is the run loop. | `outcome` is the source of truth for the record. |
| F6 | An `ask` blocks forever; a `deny` hides the tool; an evaluate hook can tighten. | The profile is deny-by-default, and the hook turns a leftover ask into a deny. |
| F7 | A reload runs `cleanup` then `setup`. | Every registration is disposed, and adoption re-attaches the open run. |
| F8 | 60-minute idle unload by default. | The keep-alive, and the `Liveness` row. |
| F9 | Events are server-wide; `wait` is the truth. | Nothing is driven by an event; the loop reads state. |
| F10 | Core's `experimental.schedules` is off by default on every tested release. | Jobs never calls it, and does not depend on it. |
| F11 | A session can have children; removing a parent removes them. | Runs hang off one parked `Jobs` parent, recreated if it is deleted. |
| F12 | Session rules merge with the agent's and override them; within a block, the later rule wins. | The agent block starts with a blanket deny; a job's list is deny-only. |
| F13 | `ctx.rpc` reaches another plugin's handler by id; the server validates the registrant's schema. | The v0.1 `rpc` action is viable; not built in v0. |
| F14 | Storage writes are visible to another instance on its next read; `scan` is paged. | Every list follows `next`. |
| F15 | An agent's own rules are appended after the base `* * allow`. | The documented block must deny first; the plugin's default rules are inserted after the base allow. |
