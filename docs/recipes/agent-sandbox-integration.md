# Recipe: Agent Sandbox Integration

How to give an agent real bash semantics over real directories **without
letting it touch disk**, while keeping an exact, reviewable record of
everything it changed.

**Working code**: `packages/just-bash/examples/agent-sandbox.mjs`
(runnable) and `packages/just-bash/src/agent-examples/sandboxed-host-sync.test.ts`
(the same flow as a test, using the manual topology).

## The short version: `createAgentSandbox`

```ts
import os from "node:os";
import { createAgentSandbox } from "just-bash";

const sandbox = createAgentSandbox({
  home: os.homedir(),            // real dir -> virtual /home/user
  project: projectDir,           // real dir -> virtual /project
  abortOnUnresolvedCommands: true,
});

// Per agent turn:
const analysis = await sandbox.analyzeCommands(script);  // 1. static pre-flight
const result = await sandbox.exec(script);               // 2. sandboxed exec
const changes = sandbox.diff();                          // 3. exact change set
await sandbox.applyChanges(changes);                     // 4. host applies + drops applied
```

- The sandbox **never writes to the underlying directories by itself**;
  writes stay in an in-memory upper layer, reads fall through to live disk.
- `diff()` returns the combined pending set across all overlays with
  **real absolute paths** — apply-ready, no path mapping.
- `applyChanges(changes?)` applies the given set (default: everything
  pending) and reconciles in one call: applied changes drop out of the
  pending set automatically, **so there is no separate sync step**.
  Pass a filtered subset to reject changes — whatever you omit stays
  pending for review or `sandbox.reset()`.
- `result.unresolvedCommands` reports every command-resolution miss
  (deduped, from any nesting level). With `abortOnUnresolvedCommands`,
  the first miss unwinds the whole exec with exit 127 and output
  preserved — the fail-fast backstop for dynamically constructed
  commands that static analysis cannot see.

`createAgentSandbox` passes all other `BashOptions` through (`env`,
`executionLimits`, custom `commands`, …). `HOME` defaults to
`/home/user`. The `.bash` and `.overlays` properties are escape hatches.

## Topology

An `InMemoryFs` virtual root, with `OverlayFs` copy-on-write overlays
over the real directories you choose to expose:

- `home` → mounted at virtual `/home/user` (omit it and home is plain
  throwaway memory — agents can then write there freely with no review).
- `project` → if it lives **inside** home, the home overlay covers it
  and cwd maps to the virtual subpath (one overlay total). Otherwise it
  gets its own overlay at virtual `/project` (the default cwd).
- Everything else in the VFS (`/tmp`, `/etc`, …) is plain memory.

## Reviewing the change set

```ts
const changes = sandbox.diff();
// changes.writes:    { path (real), nodeType, content, mode, mtime, metadataOnly? }[]
// changes.deletions: real absolute paths, top-most only
```

- `metadataOnly: true` marks `chmod`/`utimes` copy-ups (empty content) —
  an agent's `chmod +x build.sh` is reviewable without a content write.
- Directory writes for already-existing directories are ensured-parent
  scaffolding; applying them is a harmless `mkdir -p`.
- Applying mode bits only makes sense on POSIX — `applyChanges` skips
  `chmod` on Windows, where mode bits are advisory.

## Out-of-band policy (read this before running agents on live projects)

> OverlayFs does not detect changes made to the underlying directory
> outside the overlay while it is live. If such changes occur, behavior
> is undefined and **data loss is a possible outcome** — including
> deletion of files the overlay never saw, when applying a diff computed
> against a stale view. After intentional external changes (e.g. a
> native command run), call `sandbox.sync()` or `sandbox.reset()` to
> re-baseline.

This mirrors Linux overlayfs's own rule; `sync()`/`reset()` are the
supported reconciliation path.

## Advanced: the manual topology

`createAgentSandbox` is a convenience over pieces you can wire yourself
when you need a different layout (read-only knowledge mounts, extra
overlays, custom virtual paths):

```ts
const homeOverlay = new OverlayFs({ root: realHome, mountPoint: "/" });
const projectOverlay = new OverlayFs({ root: realProject, mountPoint: "/" });
const vfs = new MountableFs({
  base: new InMemoryFs(),
  mounts: [
    { mountPoint: "/home/user", filesystem: homeOverlay },
    { mountPoint: "/project", filesystem: projectOverlay },
  ],
});
const bash = new Bash({ fs: vfs, cwd: "/project" });
```

The trap to avoid: **`MountableFs` strips its mount prefix before
delegating**, so an overlay mounted through it must use `mountPoint: "/"`
(its own root is the real directory). A non-root `mountPoint` on
`OverlayFs` is for using the overlay *directly* as a Bash filesystem,
where it sees full VFS paths.

At this level you manage each overlay's `diff()`/`sync()`/`reset()`/`drop()`
yourself (paths are root-relative per overlay), and host-side apply is
your own loop — see the test file for a reference implementation.

## Platform notes

- **Mode bits**: preserved and reported on POSIX; advisory on Windows.
- **Symlinks**: blocked by default (`allowSymlinks: false`); enable only
  if your threat model allows following links inside the project root.
  One known deviation: appending through a lower-layer symlink shadows
  the link with a regular file instead of appending through it.
- **Windows path semantics**: VFS paths are POSIX-style; Windows-absolute
  inputs (`C:\...`) resolve to nothing rather than escaping the sandbox.

## Security notes

- The overlay enforces path containment (no traversal outside `root`);
  it is not a credential sandbox — run the host process with the least
  privilege the project needs.
- The change set is only as trustworthy as your review of it: applying
  changes to disk is the privileged step, and it is deliberately an
  explicit host call (`applyChanges`), never sandbox-initiated.
- `analyzeCommands` + `abortOnUnresolvedCommands` are detection aids,
  not policy enforcement; a script that resolves can still do damage
  *within* the directories you mount. Mount only what the agent needs.
