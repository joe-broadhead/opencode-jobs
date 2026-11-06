# Repository rules

This repository builds `@joe-broadhead/opencode-jobs`, an OpenCode plugin that runs agent prompts, slash commands and
reminders on cron, interval and one-off schedules, inside the OpenCode server, with run history and unattended
permissions. Read [docs/configuration.md](docs/configuration.md) before you change code, and
[CONTRIBUTING.md](CONTRIBUTING.md) for the checks and the release steps.

## Rules

- **Public API only.** Use only the public `@opencode/plugin` 2.2.3 API. `opencode.host` in `package.json` and
  `SUPPORTED_HOST` in `src/constants.ts` both say exactly `>=2.2.3 <2.3.0`, never `^2.2.3`. `TESTED_HOSTS` in
  `src/constants.ts` is the one list of tested releases (2.2.3, 2.2.4 and 2.2.5): status calls only those tested, and
  the host and pack stages and CI run on each. Inside the range an untested release still starts.
- **Greenfield.** No legacy, migration code, compatibility shim, dual path or deprecated alias, and nothing dead.
  Delete rather than deprecate.
- **No peers, no runtime dependencies, no lifecycle scripts.** `@opencode/plugin`, `@opencode/sdk` and
  `@opencode/client` (whose types the host tests use) are devDependencies pinned to exactly `2.2.3`. Do not add
  another host version to the lockfile: the host stage installs the other tested SDKs into a temp folder.
- **Ship prebuilt, one file per entry.** `scripts/build.mjs` bundles `src/index.ts` and `src/tui.ts` with esbuild into
  the self-contained `dist/index.js` and `dist/tui.js`: no chunks, no relative imports, and only host-provided modules
  external. `tsc` only typechecks. No declaration files, `.tsx` or JSX.
- **No permission rules.** This plugin inserts nothing into any agent and adds no default block. A job runs as the
  agent it names, and that agent's own `permissions` are its profile. A run's session rules only ever narrow them, and
  a job whose agent does not deny by default is refused with `JOBS_AGENT_UNGUARDED` at create and again when a slot
  starts, rather than run into a permission prompt nobody can answer.
- **The permission hooks.** Two `permission.hook("evaluate")` calls are allowed, and only these: the one in
  `src/host/tools-rpc.ts` turns an `ask` on one of the tools RPC's own script calls in flight into a deny, and the one
  in `src/jobs/safety.ts` does the same for a session this plugin created for a run. Each file holds exactly one hook,
  the bundle that inlines both holds two, and `scripts/check-forbidden.mjs` fails any other file, any extra hook, and
  any hook that is not an `evaluate` one. Neither ever turns a deny into anything, and neither touches a session it did
  not create.
- **The kill switch.** `pause/all` in the plugin's storage stops every job at once: the runner starts nothing and
  interrupts what is in flight, and `/jobs-pause` sets and clears it. `enabled: false` stops the runner at setup
  instead, and status says which of the two is in force.
- **Transforms are cheap, synchronous and never throw.** Record failures for status instead.
- **Errors** read `CODE: What happened. Next step: What to do.`, built by `jobsError` or `errorText`. Codes have no
  service prefix; shared failures use the shared names (`HOST_UNTESTED`, `OPTIONS_INVALID`, `STATUS_UNAVAILABLE`).
- **Status.** `src/status.ts` builds one model for `/jobs-status`, the `/jobs` dialog and the status RPC. The RPC keeps
  the fields every plugin of this family shares, `version`, `host` (`version`, `range`, `tested`), `state`,
  `unguardedAgents` and `nextStep`, under those names. Status names jobs, agents, times and outcomes, never a prompt or
  a transcript, and cuts a failure's reason to one line of 160 characters with `src/redact.ts`.
- **`src/constants.ts` has no imports at all**: `scripts/check.mjs` loads it with Node's type stripping.
- **The tools RPC.** `src/host/tools-rpc.ts` is a copy of a module shared by several plugins. Change only its block
  between the `PLUGIN-SPECIFIC` markers here; change the rest in the shared copy first. Only reads become methods:
  never a write, a pause or an unknown tool. Keep the RPC id `jobs.scheduler.tools` and its method names stable:
  scripts call them by name.
- **State is OpenCode's.** Jobs, their runtime state and their run records live in `ctx.storage`, one key per job and
  per run, written only by the leader. Nothing else is written: no file outside `ctx.storage`, and job files are read,
  never edited.
- **Job output is untrusted.** A run's summary, a reminder and a notification are job output, labelled as such, never
  instructions. Job prompts name real tools and say what is data.
- **TypeScript.** No enums, namespaces or parameter properties. `import type` for types, `.js` in relative imports.
- **Tests.** Unit tests use narrow `Pick<Plugin.Context, ...>` fakes. Host tests use the public `@opencode/sdk` with
  `OpenCode.create({ app: { version } })`, a loopback fake server and the temp root from `test/host/isolate.ts`. Every
  temp root of the host and pack tests is a git repository under the system's `/tmp`, never under `TMPDIR` or `HOME`,
  so OpenCode never finds a `.opencode` folder of whoever runs them; each stock server has its own port. No test
  touches the network.
- **Text.** Model-facing text and docs use plain language and describe what the code does now: no process narrative,
  test counts, machine-local paths, secrets or personal data.
- **Releases** come from a `v<version>` tag on `master`. The release workflow refuses a private package or a tag that
  differs from the version; no test or script checks `private`.
- **One check command.** `npm run check` passes before every commit. Never skip, weaken or delete a test to get green.

## Forbidden in this repository

`scripts/check-forbidden.mjs` enforces this list in `src/`, `test/`, `scripts/` and `dist/`:

- dispatch-lease, catalog-ownership and text-only markers, and tool `options.mcp` delegation;
- `Plugin.image` and profile images;
- imported OAuth grants;
- the V1 plugin API: `@opencode-ai/*` packages and hooks such as `tool.execute.before`, `chat.message` or
  `permission.ask`;
- the deprecated `ctx.generate.text` and `experimental.policies`;
- importing `@opencode/ai`;
- a permission hook, except the two `permission.hook("evaluate")` calls, exactly one each: the tools RPC's, in
  `src/host/tools-rpc.ts`, which turns an `ask` on its own script calls in flight into a deny, and the job session's, in
  `src/jobs/safety.ts`, which does the same for a run nobody is watching; and except the bundle, `dist/index.js`, which
  inlines both and must hold exactly two;
- references to private host source or host checkouts;
- machine-local home and temp paths;
- `.tsx` or `.jsx` files in `dist/`.

The pack test also rejects anything in `dist/` other than the two bundles, any relative, dynamic or `require` import in
them, and any import of a module OpenCode does not provide.
