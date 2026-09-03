# OverlayTree: Design Decisions

Status: **decision record** — documents the design of OverlayFs's in-memory
upper layer and the reasoning behind non-obvious choices. Read this before
modifying `src/fs/overlay-fs/overlay-tree.ts` or `overlay-fs.ts`.

## Purpose

OverlayFs gives an agent harness a sandboxed view of a real project
directory: reads come from disk, every write lands in an in-memory upper
layer, and the host later asks "exactly what changed?" via
`diff()`/`sync()`/`reset()`. The overlay itself never modifies disk.

The upper layer is an explicit tree (`OverlayTree`), not a flat
`Map<path, entry>`. The flat map encoded tree semantics as cross-key
string invariants — and encoded them badly: ghost children (stat says
file, readdir still lists contents), real children leaking through file
shadows, and per-descendant tombstones degrading every readdir for the
rest of the session. The tree makes illegal states unrepresentable and
semantics local.

## Core structure

- **Node types**: `file`, `directory`, `symlink`, `whiteout`. The tree
  root *is* `/`.
- **No parent pointers.** Every operation starts with `descend()`, which
  returns an ancestry stack (`stack: DirNode[]`). Mutations get all
  context from the stack; the tree cannot disagree with itself about
  where a node lives.
- **Descent contract**: `found` (entry or whiteout at the exact path),
  `missing` (clean miss → caller may fall through to disk), `blocked`
  (whiteout at or above the path → ENOENT, no fall-through), `notdir`
  (file/symlink shadow blocks the path → ENOTDIR).
- **Type-safe mutation**: `attach()` of a file/symlink over a directory
  throws EISDIR; a directory over any node throws EEXIST (resurrection
  must go through `ensureDirs`). `detach`/`putWhiteout` may remove
  anything. This mirrors what real bash reports at the syscall boundary
  and killed the flat map's ghost-state class.
- **Byte accounting is centralized in the tree** so `retainedBytes ≡ Σ
  file bytes` holds by construction; `detach`/`putWhiteout` release whole
  subtrees.

## Deletions: whiteout nodes

A whiteout means "this path, and everything under it, was deleted."
Deletions live **in the tree** — there is no side table. Whiteouts are
leaves and **can never nest** (`putWhiteout` collapses a subtree into one
node), so every whiteout is a top-most deletion by construction; `diff()`
needs no filtering machinery.

This is Linux overlayfs's model (whiteout as char device 0/0 stored in
the upper layer) translated to an in-memory node.

## Resurrection and whiteout population

Deleting a tree and then writing inside it (`rm -rf /a; write /a/b/x`)
is the hardest case: resurrecting `/a` must not bring back its deleted
lower-layer contents. The chosen mechanism (over an opaque-flag
alternative, evaluated and retired — see below):

> When a whiteout is resurrected into a directory, readdir the lower
> layer once and insert a whiteout child for every entry found —
> lazily, per level, as descent proceeds.

So resurrection costs one disk readdir per resurrected level, and the
tree afterwards literally contains the minimal correct change set:
explicit whiteouts exactly where deleted entries lived. Read paths stay
trivial ("blocked = whiteout node on your path") with no ancestry state.

A null lower listing (unreadable/gone lower dir) populates nothing:
lookups degrade to individual lower-layer errors rather than leaking.

**Retired alternative (experiment, `overlay-tree-replace-v2`)**: resurrect
as a `replace`-flagged directory (opaque semantics — "don't look at disk
below"), expanded to whiteouts at `diff()` time. Benchmarks
(`overlay-fs.flows.perf.test.ts`) showed per-turn flows wash (the cost
relocates from exec to diff) and only end-of-session flows favor replace
(~2×), while `sync()` dominates on both branches. Populated won on
simplicity (no ancestry rule, non-mutating `diff()`) and on out-of-band
safety: populated keeps later disk additions visible (fall-through),
matching the overlay's live-view-of-disk philosophy.

## Metacopy: metadata-only copy-up

`chmod`/`utimes` on a lower file attaches a **metacopy file node**
(metadata upper, data still lower, `lowerSize` recorded at creation) —
O(1) instead of copying full content against the memory quota. Modeled
on Linux overlayfs's metacopy xattr, as an internal representation only.

Lifecycle: reads fall through to lower data on **POSIX** (metadata is
worth the laziness) and **promote to a full node on first read on
Windows** (mode bits are advisory fiction there, so data residency is
the only value; promotion failure, e.g. quota, just keeps fall-through).
First content write completes the copy-up, preserving the metacopy mode.
`rm` whiteouts metacopy nodes like any other.

Related platform rule (`inheritedMode`): copy-up writes inherit the
lower file's mode on POSIX (rewriting a `0o755` script must stay
executable); on Windows the stat is skipped — the returned mode is
synthesized and nothing in the overlay enforces it.

## Change-set APIs

- **`diff(): OverlayDiff`** — pure tree walk (sync). Writes carry
  root-relative path, node type, content (symlink target as bytes),
  mode, mtime. Deletions are the whiteout set, top-most by construction,
  minus stale markers whose disk path is gone. Mount-root scaffolding
  and out-of-mount writes are excluded.
- **`metadataOnly?: true`** — a pending metacopy node emits an O(1)
  metadata-only write (empty content, upper mode/mtime): hosts can apply
  or prompt on `chmod +x` without touching content.
- **`sync()`** — post-order walk reconciling with disk: content nodes
  drop on byte match (size pre-checked), metacopy nodes drop on metadata
  match (mtime everywhere, mode on POSIX), directories drop only when
  empty of pending children (structural in post-order), stale whiteouts
  detach. After the host applies a diff, `sync()` leaves exactly the
  still-pending changes — no per-path bookkeeping.
- **`reset()`** — clear the tree and rescaffold (trust-disk re-baseline).

## Out-of-band policy

> Concurrent modification of the underlying directory is not supported.
> OverlayFs does not detect changes made outside the overlay while an
> instance is live. If such changes occur, behavior is undefined and
> **data loss is a possible outcome** — including deletion of files the
> overlay never saw, when applying a `diff()` computed against a stale
> view. After intentional external changes (e.g. a native run), call
> `sync()` or `reset()` to re-baseline.

Linux overlayfs takes the same position ("changes to underlying
filesystems while mounted are not allowed"). Our `sync()`/`reset()` are
the supported reconciliation path it doesn't have.

## Studied and rejected (from Linux overlayfs)

`redirect_dir` rename (we keep `mv` = cp+rm, which is what `mv(1)` does
in response to overlayfs's own EXDEV default), `index`/`xino` inode
stability (we document identity instability on copy-up instead),
multi-lower and data-only layers, NFS export, fs-verity, volatile/fsync
durability, userxattr/idmapped/credential stashing (our security model
is path-containment), `opaque="x"` (their per-entry xattr-read cost
doesn't exist for in-memory nodes).

## Invariants

1. Root is always a directory node.
2. Child names are single segments (no `/`, no empty).
3. Whiteouts are leaves and never nest.
4. Single ownership: every non-root node lives in exactly one `children`
   map (file *content buffers* may be shared for hard links).
5. `retainedBytes ≡ Σ` file bytes over the tree (whiteouts/metadata: 0).
6. Directory resurrection happens only through `ensureDirs` (attach of a
   directory over a whiteout is a defensive EEXIST).
