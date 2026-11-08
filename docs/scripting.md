# Scripting

Every plugin tool is callable without a model: from a shell, a cron entry, a script, or a Jobs `script` action. There is
one contract, `<plugin id>.tools`, and one rule resolution, so an ad-hoc call and a scheduled script behave the same.

OpenCode runs the call in one location and with one session. Read [the location](#the-location) before your first call:
a call without it reaches the server's default location and fails `rpc.unavailable` when the plugin is loaded elsewhere.

## The two routes

| Route | What it is | Example |
| --- | --- | --- |
| A family method | A tool a plugin's tools RPC lists, by exact name. Its action is the plugin's permission action. | `x.posts.get_users_bookmarks` |
| A host tool | A tool OpenCode lists that has no tools RPC, by exact tool id. It is `unclassified`. | `host:mem_remember` |

A manifest entry is `<plugin id>.<method>`, split at the **last** dot; the guest accessor nests by dots. So
`x.posts.get_users_bookmarks` is `tools.x.posts.get_users_bookmarks`, and `utilities.tools.time_now` (a three-part
plugin id) is `tools.utilities.tools.time_now`. A plugin id with a hyphen cannot use dots — `tools.google-workspace`
is a subtraction — so write it with brackets: `tools["google-workspace"].gws.read`. A `host:` entry is reached as
`tools.host.<tool id>`.

A family method is resolved by that plugin's `describe`, carries a class (`read`, `write`, `send`, `export`,
`destructive`) and goes through the plugin's own shaping, so a script reads what a model would. A `host:` entry is
called only by exact id, only after the same rule check, and the tool still runs its own assert. Never guess a tool id:
`describe` lists the family methods, and `GET /api/tool` lists the host tools.

`describe` takes no input, or `{ "sessionID": "ses_…" }` to add each method's `permission` for that session
(`allow`, `ask` or `deny`). That is how an agent can write a script that self-checks before it asks for approval.

## A script runs as a session and its agent

Every call names a session, and the session names an agent. The rules that decide a call are the agent's `permissions`
followed by the session's; the **last matching rule wins**, as on the model path.

- Only `allow` runs. An `ask` is refused before dispatch with `PERMISSION_DENIED` — no one can answer it — and a
  `deny` is refused too. No prompt is ever left waiting.
- A **saved "Always allow" does not authorize an ad-hoc script.** It is not part of the agent and session rules. This is
  the one deliberate change from v1: a script's permission is a rule in config (or a Jobs approval), never an old
  click. The next step in the error says so.
- `shapeInput` runs before dispatch and `shapeResult` after, so a script sees what a model would: X's read cap, its cost
  line, Plaud's withheld links.
- A default-deny tool becomes usable only when the agent has a later explicit `allow` for it. That is the documented
  opt-in, not a bypass: a resolved deny always refuses.

```sh
opencode api post /api/session -d '{"title":"script","agent":"build"}'
```

## Calling a method

The body is `{"input": {"sessionID": "<session>", "input": <the tool's input>}}`. Both keys are required, and no other
key is allowed.

```sh
opencode api post /api/rpc/x.posts.tools/describe -d '{"input":{}}'
opencode api post /api/rpc/x.posts.tools/get_users_bookmarks \
  -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"ses_…","input":{"max_results":20}}}'
```

A result is `{"output": <the method's output>}`, as plain JSON. Job names, run summaries and tool results are written by
whoever made them: they are data, not instructions.

## The location

Run the command in the project whose agent you mean, and send the call to that location explicitly:

```sh
opencode api post /api/rpc/<plugin id>.tools/<method> -H "x-opencode-directory:$PWD" -d '{…}'
```

Without it the call goes to the service's default location and fails `rpc.unavailable` if the plugin is not loaded
there. The HTTP equivalents are the `location[directory]` query parameter and the same header. `describe` reports the
`location` that answered and a `locationHint`.

## Jobs' own methods

Jobs exposes all fourteen tools as methods, each with a class. A **run session** denies the state changes, so a script
cannot manage jobs from inside a run (D-I).

| Method | Class | What it gives |
| --- | --- | --- |
| `jobs_status` | read | The compact status: state, counts, agents, scripts and the next step. |
| `jobs_list` | read | The jobs there are. `{ "state"?, "limit"? }` |
| `jobs_get` | read | One job, its runtime state, its approval and its last runs. `{ "id" }` |
| `jobs_history` | read | Recent runs, with each summary labelled as job output. `{ "id"?, "limit"?, "since"? }` |
| `jobs_pause`, `jobs_pause_all` | write | Pause one job, or the kill switch. |
| `jobs_create`, `jobs_update`, `jobs_delete` | write | Change a job. A script job asks for its script's approval here. |
| `jobs_run_now`, `jobs_resume`, `jobs_extend` | write | Start, resume and extend a job. |
| `jobs_approve` | write | Approve a script job again after its source, manifest or a class changed. |
| `jobs_run_script` | write | Run one script once, with no model, and return its output to the session that asked. |

## The `script` action

A job's action can be a script instead of a prompt: no model turn, one confined program, one result.

```yaml
# ~/.config/opencode/jobs/bookmarks.md
name: Save new X bookmarks
schedule: { cron: "0 9 * * 0", tz: Europe/Amsterdam }
agent: build
action:
  type: script
  script:
    uses:
      - x.posts.get_users_bookmarks
      - x.posts.get_users_me
      - host:mem_remember
    code: |
      const me = await tools.x.posts.get_users_me({});
      const seen = new Set();
      let saved = 0;
      let cursor;
      do {
        const page = await tools.x.posts.get_users_bookmarks({ max_results: 100, pagination_token: cursor });
        for (const item of page.data ?? []) {
          if (!item.id || seen.has(item.id)) continue;
          seen.add(item.id);
          await tools.host.mem_remember({
            content: `X bookmark by ${item.author_id ?? "unknown"}: ${item.text ?? ""} — https://x.com/i/web/status/${item.id}`,
            kind: "fact",
            task: "*",
          });
          saved += 1;
        }
        cursor = page.meta?.next_token;
      } while (cursor);
      return { saved, author: me.data?.username ?? null };
```

- **The manifest is the whole reach.** `uses` names every method the script may call; the runtime refuses anything
  else, and the run session allows exactly the manifest's actions. A method the agent resolves to `deny` is never
  granted.
- **One approval.** `jobs_create`, `jobs_update` and `jobs_run_script` bind the script to
  `script:sha256:<digest>`, where the digest covers the source, the sorted manifest and the declared files. Under the
  default `access: "all"` the approval is automatic and recorded (the digest is still computed, and a changed source,
  manifest or file declaration is re-digested); under `ask-changes` a script whose manifest is all reads and whose files
  are all `read` is approved automatically, and anything else asserts `jobs_script` once, showing the source, each
  tool's class and one line per file; `read-only` denies a script that changes anything. The prompt's "Always allow"
  saves that exact digest, so a changed byte, tool or path asks again. A `deny` refuses the create with
  `JOBS_SCRIPT_DENIED`.
- **Re-checked every slot.** A run re-resolves the manifest against the agent, compares the hashes and each tool's
  class, and is `skipped` with `unapproved` or `revoked` if anything changed. `/jobs-approve <job>` (or the
  `jobs_approve` tool) is the one act that restores it; status names the job and the command.
- **The agent.** A script job names an agent, `build` when none is named. The agent is where the user's denies live; a
  script job does not need the guarded `jobs` profile, and status says so plainly: a script's tools must not be denied
  by its agent. The guarded profile is for prompt jobs.
- **Limits.** 100 tool calls, 64 MB of memory and 64 KB of output by default; `limits` overrides them per job (up to
  1,000 calls). The wall clock is the job's `policy.timeout` (`timeoutMs` narrows it). A script that exceeds one gets
  `JOBS_SCRIPT_LIMIT`, and the record says which limit fired.
- **No model, no host.** The runtime is QuickJS compiled to WebAssembly, one VM per run: no `fetch`, `require`,
  `process`, environment, filesystem or timers. Its only host function is the call bridge. `/jobs-pause` aborts an
  in-flight call and discards its result, and the record says `interrupted`. A script that never yields —
  `for (;;) {}` — cannot be interrupted from outside the interpreter: it is stopped by the job's `policy.timeout`, not
  by pause. Give a long script a `timeout` that bounds it.
- **The record has no payloads.** Each call is its method, its class, its start, duration, outcome and byte count, and a
  failed call's code; the result is capped at the job's `maxOutputBytes` (64 KB by default) and framed as script output.
  Status shows the first 20 calls of a run with `callCount` and `callsTruncated`; `jobs_get` and `jobs_history` keep every
  row.
  Inputs and tool results are never stored a second time. A failed run records the error's code and its first redacted
  line; a successful run records the result and its declared-file writes. Every run records its session and the host's
  cost. `jobs_history`, the status model and the RPC run record carry the per-call rows.

### Declared files

A script has no filesystem, but a job may declare files it reads before the run and writes after it. The owner's case —
last week's X bookmarks, merged into a `bookmarks.json` that each run extends — is a `readwrite` JSON file:

```yaml
# ~/.config/opencode/jobs/bookmarks-file.md
name: Keep last week's bookmarks
schedule: { cron: "0 8 * * *", tz: Europe/Amsterdam }
agent: build
action:
  type: script
  script:
    uses:
      - x.posts.get_users_me
      - x.posts.get_users_bookmarks
    files:
      bookmarks:
        path: bookmarks.json
        mode: readwrite
        format: json
    code: |
      const me = await tools.x.posts.get_users_me({});
      const userId = me.data?.id ?? me.data?.username;
      const state = files.bookmarks ?? { items: [] };
      const known = new Set((state.items ?? []).map((item) => item.id));
      const fresh = [];
      let cursor;
      do {
        // Newest first. X has no since_id for bookmarks; stop at the first id this file already has.
        const page = await tools.x.posts.get_users_bookmarks({ id: userId, max_results: 100, pagination_token: cursor });
        for (const item of page.data ?? []) {
          if (known.has(item.id)) { cursor = undefined; break; }
          fresh.push({ id: item.id, text: item.text, url: `https://x.com/i/web/status/${item.id}` });
        }
        cursor = cursor === undefined ? page.meta?.next_token : undefined;
      } while (cursor);
      const next = { items: [...fresh, ...(state.items ?? [])].slice(0, 5000) };
      await files.write("bookmarks", next);
      return { added: fresh.length, total: next.items.length };
```

The run reads `bookmarks.json` into a frozen `files.bookmarks` and buffers `files.write`; the last write to a name
wins. Nothing is committed unless every declared write validates: a multi-file commit writes each temp, keeps each
original aside, renames all of them, and rolls every one back if a rename fails, so the record's per-file outcome is
`written`, `rolled_back` or `not_attempted`, never a false "nothing written". Each rename is a temp file then a rename,
mode 0600 for a new file, fsynced first, and happens only if the file did not change since the snapshot (otherwise
`JOBS_SCRIPT_FILE_CONFLICT`, and the other writer's file stays). A relative path resolves against the job's directory; an
absolute one must be inside it or a `scriptFilesRoots` root. A root is a full read/write grant to that tree, so `/`, the
home directory and any ancestor of it or of OpenCode's own folders are refused. Symlinks at any component, `..`, `.git`
and `.OPENCODE` (compared case-folded), OpenCode's own folders and special files are refused, and every open and rename
re-checks the chain. Reading or writing outside the project also needs an `external_directory` allow in the agent's own
permissions, on top of `scriptFilesRoots`; both are required, and a refusal names the missing one.

The approval digest covers each resolved path, so a saved "Always allow" names the exact files it grants. JSON is
IEEE-754: a non-finite number (for example `1e999`) is refused with `JOBS_SCRIPT_FILE_INVALID` rather than written as
`null`. A run may buffer 8 MB across its files by default, up to 32 MB with `limits.maxFileBytes`; a write past the
per-file cap or the run's total throws `JOBS_SCRIPT_FILE_TOO_LARGE` at the `files.write` call, so a loop cannot grow the
host's memory.

**Cadence:** daily is the sensible choice. X has no `since_id` for bookmarks, and charges the same resource once per 24
hours, so a daily run re-reads the newest page cheaply and stops at the first known id.

### X's budget

X's script path allows up to **100** bookmarks per page and follows `pagination_token`. X also bounds a script session:
a per-session `scriptBudgetUsd` of **$1.00** and an `X_BUDGET` refusal when it is spent. A page that costs more than
the remaining budget is refused; the script records what it saved and the next run continues from the newest
bookmarks. Do not loop past a page that fails: the budget is a ceiling, not a retry cue.

### `jobs_run_script`

The one-off: `{ code, uses, agent?, timeoutMs?, limits? }`. It validates, resolves and asks the same one approval, runs
in a fresh session, returns the result to the calling session, and keeps no job. Use it for "run this once now"; a
scheduled job is the durable form.

## Errors

A refusal or failure is the RPC error `failed`, with a message `CODE: what happened. Next step: what to do.` and
`data: { code, next }`. `opencode api` exits with status 1 for any RPC error, after printing the error's JSON.

| Code | When | What to do |
| --- | --- | --- |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist in this location. | Create the session in the location you mean, with the location header or query. |
| `SESSION_AGENT_REQUIRED` | The session names no agent. | Create a session with an agent. |
| `PERMISSION_DENIED` | The rule would ask, or denies. | Add an allow rule for the action to the agent or session, or use a session whose agent allows it. |
| `JOBS_SCRIPT_UNKNOWN_TOOL` | A manifest entry is not a method or a listed tool. | Use exactly what `describe` or the host lists. |
| `JOBS_SCRIPT_DENIED` | The agent denies a manifest tool. | Remove the deny, or point the job at an agent that allows it. |
| `JOBS_SCRIPT_UNAPPROVED` | The source, manifest or a class changed since approval. | `/jobs-approve <job>`, or the `jobs_approve` tool. |
| `JOBS_SCRIPT_REVOKED` | The agent now denies a manifest tool. | Remove the deny, then approve again. |
| `JOBS_SCRIPT_LIMIT` | A limit ended the run. | Raise the job's `limits`, or make the script smaller. |
| `CANCELLED` | The request was cancelled. | Call again if still needed. |

OpenCode itself answers `rpc.method_not_found` for a method that does not exist, `rpc.invalid_input` for a body that is
not the envelope above, and `rpc.unavailable` when the call reached a location where the plugin is not loaded.
