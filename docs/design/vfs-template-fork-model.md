# VFS Template & the Fork Model: Design Decisions

Status: **implemented** (3.7.0, unreleased) — documents the "template
+ fork" API for running parallel agent tool calls against shared
project roots. Pieces: `changedAt` stamps (257ce4a), `mergeDiffs`
(1926c93), `applyDiffToRealFs` (a2fc1cd), `createVfsTemplate`
(22ea4f3), generic oversized-result assembly (444ebf9), recipe
(975b544). Read alongside `docs/design/overlay-tree.md` (the
per-overlay upper layer) and `docs/recipes/agent-sandbox-integration.md`
(the long-lived, per-turn sandbox model).

## Problem

An agent harness wants to execute several model-issued tool calls **in
parallel** against the same project:

1. Each call must see a complete, coherent filesystem (project + scratch).
2. Calls must not see each other's uncommitted writes to the project
   (isolation), but *must* share scratch space (`/tmp`) normally.
3. When all calls finish, the harness wants one reviewable, merged
   change set — then to apply it to disk in a single step.

## Why not existing pieces

- **One shared overlay** serializes nothing: five writers in one upper
  layer lose the per-call attribution that makes the change set
  reviewable, and conflicting writes interleave destructively.
- **The long-lived `AgentSandbox` model** (`sync()`/`drop()`/`reset()`)
  exists to reconcile one overlay across turns. The parallel flow has
  the opposite lifecycle: overlays are *single-use* — fork, run, diff,
  discard. Reconciliation never happens, so reconciliation APIs are the
  wrong shape.

## Topology

```
shared InMemoryFs (scratch: /tmp and any other non-overlaid paths)
        │
        │   per-fork MountableFs (thin router, one per tool call)
        │     ├── mount /project   → OverlayFs(root = /real/project)   ◀ fresh per fork
        │     └── mount /home/user → OverlayFs(root = /real/home/user) ◀ fresh per fork
        │
   barrier (all calls complete)
        │
   mergeDiffs(diffs)  →  real-absolute paths, later changedAt wins
        │
   apply to real roots (no VFS instance involved)
```

The shared scratch base is the *only* shared mutable state during a
round; every overlaid subtree is read-only-by-construction (each fork's
writes land in its private upper). The barrier makes merge/apply
single-threaded. **Concurrency safety comes from the topology, not from
locking** — the append/sync CAS work in OverlayFs is unnecessary in this
model.

### What is scratch vs overlay

A realistic harness mounts every *persistent* location as an overlay —
the project **and the user's home** (`/home/user`, mirroring
`createAgentSandbox`'s two-overlay topology). Home is a real directory:
users expect agent state (`.bashrc`, caches, tool config) to persist
across sessions, and per-fork overlays keep parallel writes to it
private and reviewable, exactly like project writes. Only true scratch
(`/tmp`, and anything else nobody mounted) lives in the shared in-memory
base. Multi-mount is therefore not an edge case — project + home is the
default shape, and it is why merged diffs must span roots.

## The fork metaphor

`template.fork()` deliberately mirrors process `fork(2)`: the child sees
the same filesystem; its writes to overlaid regions are private
copy-on-write pages (the overlay upper). Scratch regions behave like
shared memory — visible immediately to all forks, with ordinary
process-on-shared-fs semantics. This is the whole API intuition; if a
behavior surprises you, ask what fork would do.

**Forks are single-use.** After the barrier, discard them. Next round
forks fresh overlays on the now-updated roots. There is no `drop()`,
`sync()`, or `reset()` in this model — discarding *is* the
reconciliation.

## Decision: real absolute paths, never a rootDir

Merged diffs use **real absolute paths** (`/real/project/src/app.ts`),
produced by mapping each fork's mount-relative diff through its mount's
`root`. Consequences:

- Apply needs **no `rootDir` parameter** — paths are self-describing.
  A root parameter would be redundant and a double-rooting hazard.
- **Multiple mounts are incoherent with any single root**, so they
  forced this choice. `createVfsTemplate({ mounts: [{at, root}, ...] })`
  is the general case; one mount is the special case.
- This matches the `createAgentSandbox` combined-diff decision
  ("apply-ready paths"). Both diff families speak real paths.

## Decision: `changedAt`, not `mtime`, not magic ordering

Merge conflicts are racy input by definition — two parallel
`echo a > f` / `echo b > f` have no "right" outcome on any OS. The merge
owes **determinism, not correctness**. The rule: **later `changedAt`
wins; ties break by input order.**

`changedAt` is an **overlay-assigned** wall-clock stamp attached to
every diff entry (writes *and* deletions) at mutation time. Rejected
alternatives:

- **File `mtime`**: user-writable. `touch -d "1999-01-01" f` is
  legitimate and would make the fresher write lose. mtime is content
  metadata, not a trustworthy clock.
- **Caller-supplied completion order**: causally pure, but pushes
  bookkeeping onto every caller, and with `Promise.all` the harness
  often doesn't track per-call completion anyway. Kept as an explicit
  overload (`mergeDiffs(diffs, { order: [...] })`) for callers that do
  track causality — never as a hidden default, because a wrong silent
  order produces wrong merges.

`changedAt` is utimes-proof, tie-light (ms-granular plus the input-order
tiebreak), and needs no caller cooperation. **Input array order is the
tiebreak mechanism** — callers that track causality pass diffs in
completion order; there is no separate ordering option.

**Simplicity is a hard requirement.** Conflicts are user mistakes (racy
input); we do not pay for a convoluted algorithm on their behalf. The
semantics below are the current design — if implementation shows them
to be intricate rather than mechanically simple, they will be
*simplified* (e.g. flat per-path latest-wins, directory whiteouts
suppressing earlier subtree entries, no type-folding cleverness) rather
than shipped as something subtle.

**Coverage note.** `READDIR` results are oversized-transparent by
construction (the generic assembly is op-agnostic — the three tested
channels prove the loop); no dedicated multi-hundred-thousand-entry
test exists for it.

## Merge semantics (last-touch-wins, precisely)

For each real path, entries compete in `changedAt` order (ties: input
order); the winner takes the path wholesale:

- **Write vs whiteout**: later entry wins. Fork A deletes `/x`, fork B
  writes `/x` — if B's entry is later, `/x` exists (B's content); if A's
  is later, `/x` is deleted and B's write is discarded.
- **Directory whiteouts have subtree scope**: a whiteout on `/out`
  suppresses exactly the entries at-or-under `/out` that are *earlier*
  than it. Later entries survive and the path resurrects as scaffolding
  for them (Linux overlayfs opaque-dir + upper-entry semantics). Worked
  example: whiteout `/out` at t2, B writes `/out/f` at t3, C writes
  `/out/g` at t4 → merged `/out` contains only `{f, g}`; had the
  whiteout been last, `/out` would be deleted entirely.
- **Scaffolding never resurrects**: an ensured-parent directory entry
  folds silently and can never override a whiteout by itself; only a
  content-bearing entry can.
- **Apply order is fixed**: deletions first (deepest path first), then
  writes with ensured parents — one deterministic final state.
- **Type conflicts** (fork A writes file `/p`; fork B creates
  `/p/sub/...`): the winner's node type decides. Directory wins → A's
  file entry is dropped; file wins → B's entries under `/p` are dropped.
- **Scaffolding directories** (ensured-parent entries emitted by
  `diff()`): they lose to a *whiteout* at their own path regardless of
  time (an ensured parent can never outvote a deletion), but compete
  normally otherwise — a later scaffolding dir can beat an earlier
  file, which is how type conflicts resolve coherently.
- **`metadataOnly` entries** (chmod/utimes metacopy): contribute
  metadata, never discard content. When a metadataOnly entry is latest
  at its path and an earlier content write exists, the merged entry
  keeps the content and takes the metadataOnly entry's mode/mtime (and
  ordering stamp).

## Apply semantics

- **`template.apply(merged)`** validates every entry against the
  template's mount map (an entry outside every registered root fails
  loudly) and applies via the existing `apply.ts` primitives
  (canonicalize, write, mkdir, metadataOnly chmod+utimes, deletions via
  remove). No overlay instance is involved.
- **Standalone `applyDiffToRealFs(diff)`** is the same engine without a
  template: absolute paths are caller-trusted input; per-entry
  canonicalization still blocks symlink escapes. Documented as: only
  feed it diffs your own overlays produced.
- **Whiteouts apply as `rm`** of the absolute target (including when an
  earlier-in-order fork rewrote that path — last-touch-wins applies to
  deletions identically).

## The `/tmp` contract (harness-facing)

Isolation is total *inside overlaid subtrees*: a file fork A creates in
`/project/scratch` is invisible to fork B until merge. If the model's
parallel calls need to exchange intermediate files, those must go to
`/tmp` (or any non-overlaid path). The fs cannot decide this — it is a
prompting/harness-level contract, documented in the recipe.

Shared scratch semantics are the InMemoryFs baseline: every single op is
atomic (synchronous bodies, run-to-completion — appends included);
compound commands interleave with ordinary process-on-shared-fs
semantics.

## API surface

```ts
const tpl = createVfsTemplate({
  mounts: [
    { at: "/project",   root: "/real/project" },
    { at: "/home/user", root: "/real/home/user" },
  ],
});

const a = tpl.fork();   // MountableFs: shared scratch + fresh overlay per mount
const b = tpl.fork();
await Promise.all([run(a), run(b)]);

const merged = tpl.merge([a, b]);   // real-absolute diff, changedAt order
tpl.apply(merged);                  // validate + write to roots
```

Free functions for harnesses managing their own mounts:
`mergeDiffs(diffs, opts?)`, `applyDiffToRealFs(diff)`.

## Implementation pieces (3.7.0)

1. `changedAt` stamps on diff entries (OverlayTree/diff plumbing; writes
   and whiteouts).
2. `mergeDiffs(diffs, opts?)` — ordering, whiteout/type/scaffolding/
   metadata folding.
3. `applyDiffToRealFs(diff)` — standalone wrapper over
   `src/fs/overlay-fs/apply.ts` (no drop; caller owns overlay lifecycle).
4. `createVfsTemplate({ mounts })` + `fork()`/`merge()`/`apply()`.
5. **Ranged transfer for the remaining bridge channels**
   (`HTTP_REQUEST`, `INVOKE_TOOL`, `EXEC_COMMAND`, `READDIR`): the same
   offset/length pattern as the file ops, so no legitimate payload hits
   the 8MB transport buffer. Layering rule: the transport must be
   transparent *up to* the intentional policy limits (`maxOutputSize`
   and friends); past them, the policy fails loudly with its own honest
   error — the two layers are never confused.
6. Recipe: `docs/recipes/parallel-fan-out.md`.

Deliberately dropped from an earlier draft (the "shared base holds the
project" topology): `LowerFs` generalization and `PrefixFs` subtree
adapter — unnecessary because the project lower stays a real root, which
OverlayFs already serves.

## Non-goals / future

- **Two-word bridge protocol** (request/result state separation) —
  upstream-proposal territory; the spurious-wake tolerance in
  sync-backend covers the observed class.
- **Concurrent rounds** (round N applying while round N+1 runs) —
  rounds must serialize at apply. Memory-apply is near-synchronous, so
  this is cheap to respect; nothing enforces it beyond documentation.
