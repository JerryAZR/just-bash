# just-bash (fork)

A fork of [vercel-labs/just-bash](https://github.com/vercel-labs/just-bash),
extended for **agent-harness sandboxing**: run agent-generated bash against
real directories without letting it touch disk, keep an exact reviewable
record of everything it changed, and know precisely which commands the
sandbox couldn't run.

The package publishes as [`@jerryan/just-bash`](https://www.npmjs.com/package/@jerryan/just-bash).

## What this fork adds

**Change-set APIs for `OverlayFs`.** The copy-on-write overlay now records
exactly what happened and reconciles with the host:

- `diff()` — the pending change set: writes (path, node type, content,
  mode, mtime, `metadataOnly` for chmod/utimes copy-ups) and top-most
  deletions.
- `drop(paths)` — intent-neutral removal of listed entries with zero disk
  I/O (applied, rejected, superseded — same operation).
- `sync()` — drop everything that now matches disk (re-baseline after
  out-of-band changes).
- `reset()` — drop everything.
- The upper layer is an explicit tree (`OverlayTree`) with whiteout and
  metacopy nodes — `rm -rf` of a 5k-file tree went from ~15s to ~2ms
  versus the previous flat map. See
  [docs/design/overlay-tree.md](docs/design/overlay-tree.md).

**Unresolved-command signaling.** The sandbox tells you what it couldn't
run instead of silently failing bash-style:

- `BashExecResult.unresolvedCommands` — every command-resolution miss,
  deduplicated, funneled from subshells, pipelines, and nested `bash -c`.
- `abortOnUnresolvedCommands` — opt-in fail-fast: the first miss unwinds
  the whole exec with exit 127 and output-so-far preserved.
- `Bash.analyzeCommands(script)` — static pre-flight: which literal
  command names would fail resolution, without executing anything.

**`createAgentSandbox` — one entry point.** The whole harness recipe in a
few lines:

```typescript
import os from "node:os";
import { createAgentSandbox } from "@jerryan/just-bash";

const sandbox = createAgentSandbox({
  home: os.homedir(),            // real dir -> virtual /home/user, copy-on-write
  project: projectDir,           // real dir -> virtual /project, copy-on-write
  abortOnUnresolvedCommands: true,
});

// Per agent turn:
const analysis = await sandbox.analyzeCommands(script);  // static pre-flight
const result = await sandbox.exec(script);               // sandboxed; writes in memory
const changes = sandbox.diff();                          // real paths, reviewable
await sandbox.applyChanges(changes);                     // host applies + drops applied
```

The sandbox never writes to the underlying directories by itself;
`applyChanges` is always an explicit host call. Full walkthrough:
[docs/recipes/agent-sandbox-integration.md](docs/recipes/agent-sandbox-integration.md)
and the runnable [packages/just-bash/examples/agent-sandbox.mjs](packages/just-bash/examples/agent-sandbox.mjs).

## Packages

| Package | Path | Published |
| --- | --- | --- |
| [`@jerryan/just-bash`](./packages/just-bash) | `packages/just-bash` | npm |
| `just-bash-executor` (upstream's experimental companion) | `packages/just-bash-executor` | private — not published |

See the package's own [README](./packages/just-bash/README.md) for full
usage documentation, and [THREAT_MODEL.md](THREAT_MODEL.md) for the
(inherited) security model.

## Layout

```
packages/         npm packages (just-bash, just-bash-executor)
examples/         example consumers (bash-agent, cjs-consumer, website, ...)
docs/             design docs and recipes
.github/          CI workflows
```

## Working in the repo

```bash
pnpm install              # install all workspace deps
pnpm build                # build all packages
pnpm test:run             # run unit + comparison tests
pnpm test:dist            # smoke-test the bundled output
pnpm lint                 # biome + per-package banned-pattern checks
pnpm typecheck            # tsc across all packages
```

Per-package commands run via `pnpm --filter <name> <script>` — e.g.
`pnpm --filter @jerryan/just-bash test:wasm`.

On Windows, set pnpm's script shell to Git Bash once
(`pnpm config set script-shell "C:\Program Files\Git\bin\bash.exe"`) —
the build scripts are POSIX-shell. Day-to-day local runs are quieter with
`pnpm test:unit -- --exclude src/spec-tests` (upstream's conformance
suites have documented known failures).

## CI

Ubuntu gates (lint, typecheck, unit tests on Node 20/22/24, comparison
tests, WASM tests) run on every push and PR. A dedicated
[windows-tests](.github/workflows/windows-tests.yml) job pins this fork's
deliberate Windows behavior (metacopy promotion, mode rules, mount
scanning, the sandbox flow). Releases are changeset-driven and publish
via npm Trusted Publisher when changesets are queued.

### Platform notes and limitations

These are deliberate, documented platform behaviors — not test failures.
Tests that depend on a missing host capability are gated with capability
probes (`src/test-utils/fs-env.ts`) or `skipIf(platform)` and pass where
the capability exists; none of them document limitations *by failing*.

- **Symlinks (win32)**: creating real symlinks requires elevation or
  Developer Mode. Symlink-dependent tests probe `canCreateSymlinks()`
  and skip on unprivileged hosts; the sandbox's default-deny symlink
  policy is itself host-independent and always enforced.
- **Copy-on-write rename (POSIX only)**: the hard-link containment
  strategy stages via rename-over-open-file, which win32 forbids.
  Those tests skip on win32; a win32-compatible variant is a design
  decision, tracked as such rather than as failing tests.
- **Mode bits (win32)**: POSIX permission bits are advisory only (they
  map at most to the read-only attribute). Exact-mode assertions are
  POSIX-gated; win32-meaningful assertions run everywhere.
- **Native codecs**: tar's xz/zstd paths need optional native modules
  with no win32 prebuilds; those tests probe and skip.
- **Spec-test conformance**: each imported suite keeps an explicit skip
  ledger with per-entry reasons (`src/spec-tests/*/skips.ts`); the
  runner fails on unexpected passes so the ledger cannot rot.

## Upstream

This fork tracks [vercel-labs/just-bash](https://github.com/vercel-labs/just-bash)
via the `upstream` remote. Fixes that belong upstream are reported as
issues there; everything else lives here.
