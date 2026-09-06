import type { OverlayDiff, OverlayWrite } from "./overlay-fs.js";

/**
 * Merge change sets from independent overlays into one deterministic
 * change set. Paths must already share one space (e.g. real absolute
 * paths — map mount-relative diffs through each mount's root first).
 *
 * Semantics (see docs/design/vfs-template-fork-model.md):
 *
 * - Ordering key per entry: `changedAt` (overlay-assigned, untamperable;
 *   missing stamps count as 0), ties broken by input order — later wins.
 * - One winner per path (the latest entry).
 * - A winning whiteout suppresses earlier entries under its subtree;
 *   later entries survive and the path resurrects as their scaffolding
 *   (overlayfs opaque-dir semantics).
 * - A winning file/symlink drops every entry under its path, regardless
 *   of time — files cannot have children.
 * - Scaffolding and metadataOnly need no special rules: ensured-parent
 *   dir entries only ever win alongside their fork's surviving
 *   descendants, and a metadataOnly winner already carries the metadata.
 *
 * Conflicts are racy input by definition; this merge owes determinism,
 * not correctness. It never throws on malformed combinations.
 *
 * COMPLEXITY: O(n log n) overall. Prefix queries ride on sorted keys:
 * descendants of a key form a contiguous range right after it, and
 * ancestor ranges nest properly, so subtree consistency is a stack
 * sweep (a monotonic max-whiteout stack plus an active-leaf counter)
 * rather than all-pairs prefix scans. The semantics-matrix suite
 * (merge.test.ts) is the behavioral contract; this implementation
 * must agree with it on every cell.
 */
export function mergeDiffs(diffs: OverlayDiff[]): OverlayDiff {
  type Entry = {
    path: string;
    /** Slash-normalized form of `path` — the ONLY form used for identity
     * and prefix comparisons, so merges work identically when callers
     * join paths with platform separators (nodePath.join on Windows
     * produces backslashes). Output always uses the original `path`. */
    key: string;
    kind: "write" | "delete";
    changedAt: number;
    order: number;
    /** Ensured-parent dir entry: loses to a whiteout at its own path. */
    scaffolding?: boolean;
    write?: OverlayWrite;
  };
  const keyOf = (p: string) => p.replace(/\\/g, "/");
  const byKey = (a: Entry, b: Entry) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  /** a ordered after b? (changedAt, then input order) */
  const later = (a: Entry, b: Entry) =>
    a.changedAt !== b.changedAt ? a.changedAt - b.changedAt : a.order - b.order;

  const entries: Entry[] = [];
  let order = 0;
  for (const diff of diffs) {
    // Sort this diff's write keys once: with keys sorted, a key has a
    // descendant in the same diff iff the immediately following key
    // starts with its prefix — O(W log W) instead of O(W^2) scans.
    const sortedKeys = diff.writes.map((w) => keyOf(w.path)).sort();
    const hasDescendant = (key: string): boolean => {
      // Binary search for the first key >= `${key}/`; that key (if any)
      // is the candidate descendant. Equivalent to "successor starts
      // with prefix" because `${key}/` sorts immediately after `key`.
      const prefix = `${key}/`;
      let lo = 0;
      let hi = sortedKeys.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedKeys[mid] < prefix) lo = mid + 1;
        else hi = mid;
      }
      return lo < sortedKeys.length && sortedKeys[lo].startsWith(prefix);
    };
    for (const write of diff.writes) {
      const key = keyOf(write.path);
      entries.push({
        path: write.path,
        key,
        kind: "write",
        changedAt: write.changedAt ?? 0,
        order: order++,
        // An ensured-parent entry is a byproduct of writing beneath it;
        // it must never outvote a deletion at its own path (see the
        // resurrection semantics in the design doc). A dir entry with no
        // same-diff descendants is an explicit mkdir and competes fully.
        scaffolding: write.nodeType === "directory" && hasDescendant(key),
        write,
      });
    }
    for (let i = 0; i < diff.deletions.length; i++) {
      entries.push({
        path: diff.deletions[i],
        key: keyOf(diff.deletions[i]),
        kind: "delete",
        changedAt: diff.deletionChangedAt?.[i] ?? 0,
        order: order++,
      });
    }
  }

  // Per-path winner: latest entry — except that a scaffolding dir entry
  // is ignored in any competition where a whiteout participates.
  const byPath = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = byPath.get(e.key);
    if (list) list.push(e);
    else byPath.set(e.key, [e]);
  }
  const winners = new Map<string, Entry>();
  for (const [key, candidates] of byPath) {
    candidates.sort(later);
    const hasWhiteout = candidates.some((c) => c.kind === "delete");
    for (let i = candidates.length - 1; i >= 0; i--) {
      const c = candidates[i];
      if (hasWhiteout && c.kind === "write" && c.scaffolding) continue;
      // A metadataOnly winner absorbs into the latest content write
      // when one exists: the chmod/utimes contributes mode/mtime (and
      // the ordering stamp), never discards content.
      if (c.kind === "write" && c.write?.metadataOnly) {
        const content = candidates
          .slice(0, i)
          .reverse()
          .find(
            (e) =>
              e.kind === "write" &&
              e.write &&
              !e.write.metadataOnly &&
              e.write.nodeType === "file",
          );
        if (content?.write) {
          winners.set(key, {
            ...content,
            changedAt: c.changedAt,
            write: {
              ...content.write,
              mode: c.write.mode,
              mtime: c.write.mtime,
              changedAt: c.changedAt,
            },
          });
          break;
        }
      }
      winners.set(key, c);
      break;
    }
  }

  // Subtree consistency as a stack sweep over key-sorted winners.
  // Ancestor prefix ranges nest properly on sorted distinct keys, so
  // the active suppressors of the current entry are exactly a stack:
  //   - any active LEAF suppresses (files cannot have children)
  //   - otherwise the LATEST active whiteout suppresses everything not
  //     strictly later than itself (later entries resurrect).
  // A suppressed entry is never pushed, which is sound: its suppressor
  // is later and covers its whole subtree range, so every verdict the
  // suppressed entry would have given is subsumed.
  const ordered = [...winners.values()].sort(byKey);
  const isSuppressor = (e: Entry) =>
    e.kind === "delete" ||
    (e.kind === "write" &&
      (e.write?.nodeType === "file" || e.write?.nodeType === "symlink"));

  // Range end (exclusive) of an entry's subtree in `ordered`: first
  // index whose key does not start with `${key}/`.
  const rangeEnd = (from: number, key: string): number => {
    const prefix = `${key}/`;
    let lo = from + 1;
    let hi = ordered.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ordered[mid].key.startsWith(prefix)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  type Active = {
    end: number; // exclusive subtree-range end in `ordered`
    leaf: boolean;
    entry: Entry; // whiteout entry when !leaf
  };
  const stack: Active[] = [];
  let activeLeaves = 0;
  const suppressed = new Set<Entry>();

  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i];
    while (stack.length > 0 && stack[stack.length - 1].end <= i) {
      if (stack.pop()?.leaf) activeLeaves--;
    }
    if (activeLeaves > 0) {
      suppressed.add(e);
      continue;
    }
    // Latest active whiteout = deepest whiteout on the stack is NOT
    // necessarily the latest by (changedAt, order); find the max among
    // active whiteouts. The stack is shallow (path depth), and the
    // verdict needs only the maximum — scan it.
    let maxWhiteout: Entry | undefined;
    for (const a of stack) {
      if (a.leaf) continue;
      if (!maxWhiteout || later(a.entry, maxWhiteout) > 0) {
        maxWhiteout = a.entry;
      }
    }
    if (maxWhiteout && later(e, maxWhiteout) <= 0) {
      suppressed.add(e);
      continue;
    }
    if (isSuppressor(e)) {
      const leaf = e.kind !== "delete";
      stack.push({ end: rangeEnd(i, e.key), leaf, entry: e });
      if (leaf) activeLeaves++;
    }
  }

  const writes: OverlayWrite[] = [];
  const survivingDeletions: { path: string; key: string; changedAt: number }[] =
    [];
  for (const w of ordered) {
    if (suppressed.has(w)) continue;
    if (w.kind === "delete") {
      survivingDeletions.push({
        path: w.path,
        key: w.key,
        changedAt: w.changedAt,
      });
    } else if (w.write) {
      writes.push(w.write);
    }
  }
  // A deletion strictly under another surviving deletion is redundant
  // (applying the ancestor covers it) — drop it regardless of time.
  // Sorted by key, deletion ranges nest: an open-range stack decides.
  const kept: { path: string; key: string; changedAt: number }[] = [];
  const openRanges: string[] = []; // prefixes of enclosing deletions
  for (const d of survivingDeletions) {
    while (
      openRanges.length > 0 &&
      !d.key.startsWith(openRanges[openRanges.length - 1])
    ) {
      openRanges.pop();
    }
    if (openRanges.length > 0) continue; // covered by an ancestor deletion
    kept.push(d);
    openRanges.push(`${d.key}/`);
  }
  writes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    writes,
    deletions: kept.map((d) => d.path),
    ...(kept.length > 0 && {
      deletionChangedAt: kept.map((d) => d.changedAt),
    }),
  };
}
