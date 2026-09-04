# Recipe: Agent Sandbox Integration

How to give an agent real bash semantics over real directories **without
letting it touch disk**, while keeping an exact, reviewable record of
everything it changed. This is the intended usage the `OverlayFs`
change-set APIs and the unresolved-command signaling were built for.

**Working code**: `packages/just-bash/examples/agent-sandbox.mjs`
(runnable) and `packages/just-bash/src/agent-examples/sandboxed-host-sync.test.ts`
(the same flow as a test).

## Execution model

```
            per agent turn
  ┌──────────────────────────────────────────────────┐
  │ 1. analyzeCommands(script)   static pre-flight    │
  │ 2. exec(script)              sandboxed, aborts    │
  │ 3. overlay.diff()            exact change set     │
  │ 4. host applies accepted changes to real disk     │
  │ 5. overlay.sync()            applied drops out;   │
  │                            rejected stay pending  │
  └──────────────────────────────────────────────────┘
```

The sandbox never writes to the underlying directory. Writes land in the
overlay's in-memory upper layer; reads fall through to live disk, so the
agent always sees the current project. The host stays in charge of what
actually changes.

## Filesystem topology

An `InMemoryFs` virtual root, with `OverlayFs` mounted over the user's
real home directory — and over the project directory too when it lives
outside home:

```ts
import { Bash, InMemoryFs, MountableFs, OverlayFs } from "just-bash";

const homeOverlay = new OverlayFs({ root: os.homedir(), mountPoint: "/" });
const projectOverlay = new OverlayFs({ root: projectDir, mountPoint: "/" });

const vfs = new MountableFs({
  base: new InMemoryFs(),
  mounts: [
    { mountPoint: "/home/user", filesystem: homeOverlay },
    { mountPoint: "/project", filesystem: projectOverlay },
  ],
});

const bash = new Bash({
  fs: vfs,
  cwd: "/project",
  abortOnUnresolvedCommands: true,
});
```

Two mount layers, two different `mountPoint` meanings — the mistake to
avoid: **`MountableFs` strips its mount prefix before delegating**, so an
overlay mounted through it must use `mountPoint: "/"` (its own root is
the real directory). A non-root `mountPoint` on `OverlayFs` is for using
the overlay *directly* as a Bash filesystem, where it sees full VFS
paths.

## The per-turn loop

### 1. Static pre-flight (optional)

```ts
const analysis = await bash.analyzeCommands(script);
if (analysis.unresolved.length > 0) {
  // Prompt the user, or plan a native run for exactly these commands.
}
```

`analyzeCommands` parses without executing and reports command names the
sandbox cannot resolve, using the same resolver dispatch uses (builtins,
registered commands, script-defined functions and aliases, VFS PATH).
Dynamic names (`$cmd`, `eval`) are statically unknowable — that blind
spot is what the runtime backstop is for. See the method's JSDoc for the
full limitation list.

### 2. Sandboxed execution with fail-fast

```ts
const result = await bash.exec(script);
result.unresolvedCommands; // every miss, deduped, from any nesting level
```

With `abortOnUnresolvedCommands: true`, the first resolution miss unwinds
the entire exec — past `||` handlers, subshells, loops, nested `bash -c`
— with exit code 127 and output-so-far preserved. Without it, execution
continues like real bash (per-command 127) and misses accumulate in
`result.unresolvedCommands`.

### 3. Review the change set

```ts
const diff = projectOverlay.diff();
// diff.writes:    { path, nodeType, content, mode, mtime, metadataOnly? }[]
// diff.deletions: string[]  (top-most only — never both a dir and its child)
```

`metadataOnly: true` marks `chmod`/`utimes` copy-ups (empty content) —
an agent's `chmod +x build.sh` is reviewable without a content write.
Directory writes for already-existing directories are ensured-parent
scaffolding; applying them is a harmless `mkdir -p`.

### 4. Apply on the host

```ts
for (const rel of diff.deletions) {
  fs.rmSync(path.join(projectDir, rel), { recursive: true, force: true });
}
for (const write of diff.writes) {
  const target = path.join(projectDir, write.path);
  if (write.nodeType === "directory") { fs.mkdirSync(target, { recursive: true }); continue; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!write.metadataOnly) fs.writeFileSync(target, write.content);
  if (process.platform !== "win32") fs.chmodSync(target, write.mode);
}
```

### 5. Reconcile

```ts
await projectOverlay.sync();
```

`sync()` drops every upper-layer entry that now matches disk and keeps
the rest. Host applied everything → pending set is empty. Host rejected
a write → it stays pending for review or `reset()` (discard). There is
no per-path bookkeeping to keep in sync — `sync()` reconciles against
disk truth.

## Out-of-band policy (read this before running agents on live projects)

> OverlayFs does not detect changes made to the underlying directory
> outside the overlay while it is live. If such changes occur, behavior
> is undefined and **data loss is a possible outcome** — including
> deletion of files the overlay never saw, when applying a diff computed
> against a stale view. After intentional external changes (e.g. a
> native command run), call `sync()` or `reset()` to re-baseline.

This mirrors Linux overlayfs's own rule; `sync()`/`reset()` are the
supported reconciliation path.

## Platform notes

- **Mode bits**: preserved and reported on POSIX. On Windows they are
  advisory (nothing enforces them), so `applyDiff` should skip `chmod`
  there — as the example does.
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
  `diff()` output to disk is the privileged step, and it is deliberately
  outside the sandbox.
- `abortOnUnresolvedCommands` + `analyzeCommands` are detection aids,
  not policy enforcement; a script that resolves can still do damage
  *within* the directories you mount. Mount only what the agent needs.
