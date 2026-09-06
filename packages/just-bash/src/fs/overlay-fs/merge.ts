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
 */
export function mergeDiffs(diffs: OverlayDiff[]): OverlayDiff {
  type Entry = {
    path: string;
    kind: "write" | "delete";
    changedAt: number;
    order: number;
    /** Ensured-parent dir entry: loses to a whiteout at its own path. */
    scaffolding?: boolean;
    write?: OverlayWrite;
  };

  const entries: Entry[] = [];
  let order = 0;
  for (const diff of diffs) {
    const paths = new Set(diff.writes.map((w) => w.path));
    const hasDescendant = (p: string) => {
      const prefix = `${p}/`;
      for (const other of paths) {
        if (other.startsWith(prefix)) return true;
      }
      return false;
    };
    for (const write of diff.writes) {
      entries.push({
        path: write.path,
        kind: "write",
        changedAt: write.changedAt ?? 0,
        order: order++,
        // An ensured-parent entry is a byproduct of writing beneath it;
        // it must never outvote a deletion at its own path (see the
        // resurrection semantics in the design doc). A dir entry with no
        // same-diff descendants is an explicit mkdir and competes fully.
        scaffolding:
          write.nodeType === "directory" && hasDescendant(write.path),
        write,
      });
    }
    for (let i = 0; i < diff.deletions.length; i++) {
      entries.push({
        path: diff.deletions[i],
        kind: "delete",
        changedAt: diff.deletionChangedAt?.[i] ?? 0,
        order: order++,
      });
    }
  }

  const later = (a: Entry, b: Entry) =>
    a.changedAt !== b.changedAt ? a.changedAt - b.changedAt : a.order - b.order;

  // Per-path winner: latest entry — except that a scaffolding dir entry
  // is ignored in any competition where a whiteout participates.
  const byPath = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = byPath.get(e.path);
    if (list) list.push(e);
    else byPath.set(e.path, [e]);
  }
  const winners = new Map<string, Entry>();
  for (const [path, candidates] of byPath) {
    candidates.sort(later);
    const hasWhiteout = candidates.some((c) => c.kind === "delete");
    for (let i = candidates.length - 1; i >= 0; i--) {
      const c = candidates[i];
      if (hasWhiteout && c.kind === "write" && c.scaffolding) continue;
      winners.set(path, c);
      break;
    }
  }

  // Subtree consistency, path-sorted so parents are considered first.
  const ordered = [...winners.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const suppressed = new Set<Entry>();
  for (const w of ordered) {
    if (suppressed.has(w)) continue;
    const prefix = `${w.path}/`;
    const isWhiteout = w.kind === "delete";
    const isLeaf =
      w.kind === "write" &&
      (w.write?.nodeType === "file" || w.write?.nodeType === "symlink");
    if (!isWhiteout && !isLeaf) continue;
    for (const other of ordered) {
      if (other === w || suppressed.has(other)) continue;
      if (!other.path.startsWith(prefix)) continue;
      // A whiteout suppresses only strictly-earlier subtree entries —
      // later ones resurrect the path. A file/symlink suppresses every
      // descendant: files cannot have children.
      if (isWhiteout && later(other, w) > 0) continue;
      suppressed.add(other);
    }
  }

  const writes: OverlayWrite[] = [];
  const survivingDeletions: { path: string; changedAt: number }[] = [];
  for (const w of ordered) {
    if (suppressed.has(w)) continue;
    if (w.kind === "delete") {
      survivingDeletions.push({ path: w.path, changedAt: w.changedAt });
    } else if (w.write) {
      writes.push(w.write);
    }
  }
  // A deletion strictly under another surviving deletion is redundant
  // (applying the ancestor covers it) — drop it regardless of time.
  const kept = survivingDeletions.filter(
    (d) =>
      !survivingDeletions.some(
        (a) => a !== d && d.path.startsWith(`${a.path}/`),
      ),
  );
  writes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    writes,
    deletions: kept.map((d) => d.path),
    ...(kept.length > 0 && {
      deletionChangedAt: kept.map((d) => d.changedAt),
    }),
  };
}
