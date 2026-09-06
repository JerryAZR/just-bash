# Recipe: Parallel Tool Calls with the Fork Model

Run several model-issued tool calls **in parallel** against the same
project roots, then merge their change sets into one reviewable diff and
apply it in a single step. This is the fork model; for the long-lived,
single-session sandbox see
[agent-sandbox-integration.md](agent-sandbox-integration.md). The design
rationale lives in
[docs/design/vfs-template-fork-model.md](../design/vfs-template-fork-model.md).

## The flow

```ts
import { Bash, createVfsTemplate } from "@jerryan/just-bash";

// 1. The template: shared scratch + the real roots to privatize.
const tpl = createVfsTemplate({
  mounts: [
    { at: "/project", root: "/abs/path/to/project" },
    { at: "/home/user", root: "/abs/path/to/home" },
  ],
});

// 2. The model issues five tool calls — each gets its own COW fork.
const calls = ["task one", "task two", "task three", "task four", "task five"];
const results = await Promise.all(
  calls.map(async (task) => {
    const bash = new Bash({ fs: tpl.fork(), cwd: "/project" });
    return bash.exec(`# ${task}\nmake-changes.sh`);
  }),
);

// 3. Barrier: merge (array order is the conflict tiebreak)…
const merged = await tpl.merge([/* the forks, in completion order */]);

// 4. …review the merged diff (host-absolute paths, ready to audit)…
console.log(merged.diff({ space: "host" }).writes.map((w) => w.path));

// 5. …and apply to disk in one step.
tpl.apply(merged.diff({ space: "host" }));

// 6. Next round: fork() again — forks are unmanaged; discard is the
//    reconciliation. The merged instance is itself a live fork:
//    diff it and drop it, or keep working on it.
```

What each call sees:

- **Over-laid subtrees** (`/project`, `/home/user`): private. Fork A's
  writes are invisible to fork B until merge. This is exactly
  `fork(2)`'s copy-on-write.
- **Everything else** (`/tmp`, and any path you didn't mount): shared
  in-memory, visible to all forks immediately.

## The `/tmp` contract

Isolation is total inside overlaid subtrees. If parallel calls need to
exchange intermediate files — one writes, another reads — those files
**must go to `/tmp`** (or another unmounted path). This is a
harness/prompting-level contract; the filesystem cannot infer it.

## Merge semantics (what to tell reviewers)

Conflicts are racy input — two parallel writes to one file have no
"right" outcome on any OS. The merge owes determinism, not correctness:

- **Later `changedAt` wins** per path; ties break by the order you pass
  forks to `merge()`. `changedAt` is stamped by the overlay at mutation
  time and cannot be forged with `touch -d`.
- **Deletions vs writes**: the later entry wins. A directory whiteout
  suppresses *earlier* entries under it; *later* ones survive and the
  path resurrects (fork A `rm -rf /out` at t2, fork B writes `/out/f` at
  t3 → `/out` ends up containing only `f`).
- **Files can't have children**: a winning file/symlink drops every
  entry under its path.
- `metadataOnly` (chmod/utimes) merges as metadata; a content winner
  overrides it.

## Lifecycle rules

- **Forks are single-use.** `tpl.apply()` consumes the registered forks;
  merging a consumed (or foreign) filesystem fails loudly.
- **`tpl.apply()` validates** that every merged entry lands inside a
  registered root — an out-of-root entry throws rather than writing
  somewhere unexpected.
- **Rounds serialize at apply.** Run the next fan-out only after the
  previous apply finished.

## Standalone pieces

Managing your own mounts? The template is sugar over three public
primitives:

- `mergeDiffs(diffs)` — deterministic merge of any same-path-space diffs
- `applyDiffToRealFs(diff)` — apply a real-absolute diff with no VFS
  instance involved (deletions deepest-first, then writes)
- `OverlayFs` + `MountableFs` — build per-call filesystems by hand if
  the topology needs something the template doesn't express
