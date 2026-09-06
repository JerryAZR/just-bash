---
"@jerryan/just-bash": minor
---

**VFS template fork model** (`createVfsTemplate`): fork a prepared filesystem into cheap copy-on-write instances for parallel agents, then merge their change sets and apply the result back to the host. **Merge is a replay**: entries from all sources (fork instances or plain diffs — the latter cross process boundaries) are ordered by untamperable `changedAt` stamps (ties by input order) and applied to a fresh fork with the stock filesystem operations over the template's real lower, so metacopy, resurrection, and deletion semantics are definitionally identical to the forks' own. Conflicting (racy) entries are refused exactly as a real filesystem would refuse them — deterministic, never throwing, contained to the conflicted path; no invented conflict-resolution rules. `merge()` returns the merged fork — diff it and discard it, or keep working on it. `diff({ space: "vfs" | "host" })` selects virtual vs host-absolute paths; `template.apply()` validates containment and writes through. `applyDiffToRealFs` remains the standalone host-apply primitive. See `docs/design/vfs-template-fork-model.md` and `docs/recipes/parallel-fan-out.md`.

**Bridge: generic oversized-result assembly**: results of ANY size now cross the worker bridge transparently (host publishes a prefix + retains the buffer; the worker assembles with range reads) — one mechanism for file reads, HTTP responses, tool results, exec output, and readdir, replacing the per-channel 8MB ceiling.

**Structural hardening** (architecture-level flaw classes closed):

- **Builtin manifest**: the three disconnected builtin truths (dispatch chain, display set, unimplemented list) are now one leaf manifest; the dispatch table is typed against it, so a listed-but-undispatchable builtin is a compile error, unrepresentable in code.
- **Two-word bridge protocol**: request and result channels are separate SAB words, so a result wait can only be woken by a real result publish — the torn-read flake class is unrepresentable (the re-wait tolerance loop is gone; impossible states fail loudly as protocol violations).
- **Typed fs error codes**: `FsError` carries errnos structurally on `.code`; all ~140 fs throw sites converted, and the five ad-hoc prose-parsing errno heuristics (bridge, python worker, rm/cp/mv/mkdir/ln) are deleted. Unclassifiable errors coerce to honest EIO instead of a fabricated specific errno. A new banned-pattern lint rule makes the legacy `"ECODE: ..."` plain-Error channel unrepresentable in non-test source. `FsError`, `fsErrorCode`, `isFsErrorCode`, `toFsError` are exported; `IFileSystem` documents the error contract.
- **`mergeDiffs` is O(n log n)**: sort+sweep replaces all-pairs prefix scans (8×5000-entry merge in ~47ms).
