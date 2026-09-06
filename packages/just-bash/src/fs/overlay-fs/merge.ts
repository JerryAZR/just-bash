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
 * COMPLEXITY: O(n log n) overall (sorts) with O(n·d) prefix work
 * (d = path depth). Prefix queries ride on sorted keys: a key has a
 * same-diff descendant iff its sorted successor starts with its
 * prefix. Subtree consistency enumerates each entry's ancestor chain
 * against a map of surviving suppressors — ancestors always sort
 * before their descendants, so a single pass suffices and NO
 * contiguity premise is needed (sibling keys like `a-b` sort between
 * `a` and `a/b` because '-' < '/'; a stack-of-ranges model gets that
 * class wrong — suppressed writes and resurrected deletions — and
 * was replaced with this enumeration). The semantics-matrix suite
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

  // Subtree consistency via ancestor-prefix enumeration. Ancestors of
  // an entry always sort before it, so in one key-sorted pass each
  // entry probes its ancestor chain ("/x/a/b/c" → "/x/a/b" → "/x/a"
  // → "/x") against `active`: the suppressors that SURVIVED (were not
  // themselves suppressed). Verdicts:
  //   - any surviving LEAF ancestor suppresses (files cannot have
  //     children) — regardless of time
  //   - the LATEST surviving whiteout ancestor suppresses everything
  //     not strictly later than itself (later entries resurrect)
  // A suppressed entry never enters `active` — matching the old
  // all-pairs code, whose suppressed suppressors gave no verdicts.
  const ordered = [...winners.values()].sort(byKey);
  const isSuppressor = (e: Entry) =>
    e.kind === "delete" ||
    (e.kind === "write" &&
      (e.write?.nodeType === "file" || e.write?.nodeType === "symlink"));

  const active = new Map<string, Entry>();
  const suppressed = new Set<Entry>();
  /** Probe e's ancestor chain in `active`; returns the verdict. */
  const suppressedByAncestor = (e: Entry): boolean => {
    let coveredByLeaf = false;
    let maxWhiteout: Entry | undefined;
    let k = e.key;
    for (;;) {
      const slash = k.lastIndexOf("/");
      if (slash <= 0) break;
      k = k.slice(0, slash);
      const s = active.get(k);
      if (!s) continue;
      if (s.kind !== "delete") {
        coveredByLeaf = true; // a leaf suppresses regardless of time
      } else if (!maxWhiteout || later(s, maxWhiteout) > 0) {
        maxWhiteout = s;
      }
    }
    if (coveredByLeaf) return true;
    return maxWhiteout !== undefined && later(e, maxWhiteout) <= 0;
  };

  for (const e of ordered) {
    if (suppressedByAncestor(e)) {
      suppressed.add(e);
      continue;
    }
    if (isSuppressor(e)) active.set(e.key, e);
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
  // Transitivity makes probing only KEPT deletions exact: anything
  // covered by a dropped deletion is also covered by that deletion's
  // own kept ancestor.
  const kept: { path: string; key: string; changedAt: number }[] = [];
  const keptKeys = new Set<string>();
  for (const d of survivingDeletions) {
    let covered = false;
    let k = d.key;
    for (;;) {
      const slash = k.lastIndexOf("/");
      if (slash <= 0) break;
      k = k.slice(0, slash);
      if (keptKeys.has(k)) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    kept.push(d);
    keptKeys.add(d.key);
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
