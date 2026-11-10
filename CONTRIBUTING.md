# Contributing

Read [AGENTS.md](https://github.com/joe-broadhead/opencode-jobs/blob/HEAD/AGENTS.md) first: it lists the rules for this
repository and the APIs that must never appear in it.

## Set up

You need Node.js 22.18 or later, npm, and [Bun](https://bun.sh). CI and the release use Node.js 24 and Bun 1.4.4,
the Bun inside stock OpenCode 2.2.3, 2.2.4, 2.2.5 and 2.2.6.

```sh
npm ci --ignore-scripts
```

### Run your checkout in OpenCode

```sh
npm run build
```

Then list the folder in `plugins`, as an absolute path or a path relative to the config file that contains it, and
restart OpenCode. One entry loads both the server part and the terminal UI part. Run `npm run build` again after you
pull changes.

```json
{
  "plugins": ["/path/to/opencode-jobs"]
}
```

## Check

One command runs every check, in order, and stops at the first failure:

```sh
npm run check
```

| Stage | What it does |
| --- | --- |
| `typecheck` | `tsc --noEmit` over `src/` (both `.ts` and the TUI's `.tsx`) and `test/`, strict, with unused names as errors |
| `unit` | `bun test ./test/unit`: every module in `src/`, the twelve tools, the status model, both RPC contracts, the docs, and the built TUI under OpenTUI 0.8's test renderer |
| `build` | `node scripts/build.mjs`: deletes `dist/` and bundles `src/index.ts` and `src/tui.tsx` with esbuild into the self-contained `dist/index.js` and `dist/tui.js`. The TUI goes through Solid's universal transform first, so its props stay reactive. Fails if a bundle imports anything the host does not provide |
| `icons` | `node scripts/check-icons.mjs`: the family's icon contract for `assets/icon.svg`, its two rasters and `opencode.icons` |
| `host` | `bun test ./test/host`: the plugin inside an embedded OpenCode host, once on each tested release (`@opencode/sdk` 2.2.3, 2.2.4, 2.2.5 and 2.2.6) |
| `pack` | `bun test ./test/pack`: builds, packs and installs the package, imports both entry points, and loads it in stock OpenCode 2.2.3, 2.2.4, 2.2.5 and 2.2.6 |
| `forbidden` | `node scripts/check-forbidden.mjs`: scans `src/`, `test/`, `scripts/` and `dist/` for forbidden APIs and machine-local paths |
| `copies` | `node scripts/check-copies.mjs`: the declaration kit (`test/support/jelly-kit.ts`) and the tools RPC outside its `PLUGIN-SPECIFIC` block equal the copy every plugin carries |
| `whitelist` | Checks `package.json` against the approved package shape, and that `dist/` holds exactly `index.js`, `tui.js` and `quickjs.wasm`, the script runtime's data file |

`npm run drift` is a manual check, not part of `npm run check`. It compares the Jelly declaration's tool list with the tools the code registers, prints each difference by name and exits 1 when there is one.

To run some stages only, name them; they run in the order given:

```sh
node scripts/check.mjs typecheck unit
```

Shortcuts: `npm run typecheck`, `npm run build`, `npm test` (the `unit` stage), `npm run test:host`,
`npm run test:pack` and `npm run lint` (the `forbidden` stage).

`TESTED_HOSTS` in `src/constants.ts` is the one list of tested OpenCode releases: 2.2.3, 2.2.4, 2.2.5 and 2.2.6. The host
and pack stages, status and CI all take their versions from it. Add a release there, and to the README's
requirements, when every check passes on it.

The host stage starts an embedded OpenCode host in a temporary home folder, once for each tested release. A request to
any address other than the local machine fails the test. 2.2.3 is the locked `@opencode/sdk`; the stage installs the
others from npm, outside this repository's lockfile, into a temporary folder that it deletes afterwards. To run the
host stage on one other OpenCode 2.2.x only, install that SDK in a separate folder and point `HOST_SDK_DIR` at it:

```sh
mkdir ../sdk-2.2.6 && cd ../sdk-2.2.6 && npm init -y && npm install @opencode/sdk@2.2.6 --ignore-scripts && cd -
HOST_SDK_DIR=../sdk-2.2.6 node scripts/check.mjs host
```

Every temporary folder of the host and pack stages is a git repository under the system's `/tmp`, never under
`TMPDIR` or your home folder. OpenCode looks for `.opencode` folders and project config upwards from a project, and
stops at a repository's root, so it never picks up your own agents or skills. Each stock server listens on its own
free port.

The pack stage needs network access to the npm registry only when a binary is not set. It checks that the tarball
contains exactly the `files` whitelist, with fewer than 30 entries and at most 128 KB, in fewer than 30 entries; that `dist/` holds only
`index.js` and `tui.js`, with no relative import, dynamic `import()` or `require()`; and that they import only modules
OpenCode provides. It installs the tarball next to the host packages that OpenCode 2.2.3 provides, imports both entry
points under Bun, then installs the tarball alone and loads it with `opencode serve` from stock OpenCode 2.2.3, 2.2.4,
2.2.5 and 2.2.6, asserting that the plugin is active and that the status RPC answers. On each, it then reloads the plugin in place, as
`opencode plugin update` does. Whether that leaves the plugin without the job's agent is a host race that some machines
never lose: when it does, the test asserts that the job fails closed with `JOBS_AGENT_MISSING`, runs nothing and
recovers; when it does not, that the plugin kept the agent. It then takes the agent out of the
configuration and reloads, so every machine asserts that the job fails closed, runs nothing across a slot, and runs the
next slot exactly once when the agent is back.

To use `opencode` binaries you already have, set `OPENCODE_BIN_2_2_3`, `OPENCODE_BIN_2_2_4` and `OPENCODE_BIN_2_2_5`:

```sh
OPENCODE_BIN_2_2_3=/path/to/opencode-2.2.3 OPENCODE_BIN_2_2_4=/path/to/opencode-2.2.4 \
  OPENCODE_BIN_2_2_5=/path/to/opencode-2.2.5 \
  OPENCODE_BIN_2_2_6=/path/to/opencode-2.2.6 node scripts/check.mjs pack
```

Otherwise the stage installs `@opencode/cli` with the binary for your platform (macOS or Linux, arm64 or x64), a few
hundred megabytes per version, once per run, into a temporary folder that it deletes afterwards.

CI (`.github/workflows/ci.yml`) runs `npm ci --ignore-scripts` and `npm run check` on Linux and macOS.

## Commits

Use `type(scope): summary`, for example `fix(status): explain a disabled plugin`. Keep commits small, and keep
`npm run check` green.

## Releases

### Versioning

The version follows semantic versioning on the plugin's contract: its options, the `/jobs-status` command, the `/jobs`
dialog, the status and tools RPCs, and the tool names and their default rules. While the major version is 0, a breaking
change raises the minor version, and anything else the patch version.

Each release supports one tested OpenCode line, stated as `opencode.host` in `package.json` and enforced by the host
check (`SUPPORTED_HOST` in `src/constants.ts`). Both must change together, with the README's requirements. Each
`CHANGELOG.md` entry follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

### Releasing

Every plugin releases as `v0.0.0`, and it installs from that GitHub tag. The release is one commit on top of a `master`
head that CI passed, and the tag points at it.

1. Set `version` to `0.0.0` in `package.json`, date the `## [0.0.0]` entry in `CHANGELOG.md`, then run `npm run check`.
2. Push that commit to `master`, and wait for CI to pass on it.
3. In a clean checkout of `master` at that commit, run `node scripts/release-commit.mjs --ci-sha <its full sha>`. It builds
   `dist/`, removes the lifecycle scripts, and creates the signed commit and the signed annotated tag `v0.0.0`. It never
   pushes; `--dry-run` shows the change first.
4. Push the tag only: `git push origin v0.0.0`.
5. Approve the run in the `release` environment. The release workflow checks the tag and its commit, installs the tag on
   each stock OpenCode host (2.2.3 to 2.2.6), packs it, and creates the GitHub Release with the notes, the tarball and
   `SHA256SUMS`.

A tag that already exists stops step 3. Delete the old tag and its Release first, then start again.

A Git install is removed and updated by its installed spec: `opencode plugin remove github:joe-broadhead/opencode-jobs#v0.0.0`. `opencode plugin update` and `opencode plugin check` take the same spec.
