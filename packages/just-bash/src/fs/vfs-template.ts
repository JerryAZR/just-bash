import nodePath from "node:path";
import { FsError } from "./fs-error.js";
import { InMemoryFs } from "./in-memory-fs/in-memory-fs.js";
import { MountableFs } from "./mountable-fs/mountable-fs.js";
import { applyDiffToRealFs, canonicalizeRealPath } from "./overlay-fs/apply.js";
import type { OverlayDiff, OverlayWrite } from "./overlay-fs/overlay-fs.js";
import { OverlayFs as OverlayFsImpl } from "./overlay-fs/overlay-fs.js";

/** One privatized subtree: virtual mount point + real backing root. */
export interface VfsTemplateMount {
  /** Virtual absolute path the overlay serves (e.g. "/project"). */
  at: string;
  /** Real absolute directory the overlay reads through and diffs against. */
  root: string;
}

export interface VfsTemplateOptions {
  /**
   * Subtrees privatized per fork. Everything else (/, /tmp, ...) lives
   * in the template's shared scratch memory fs: writes there are
   * visible to every fork immediately and never appear in diffs.
   */
  mounts: VfsTemplateMount[];
  /**
   * Per-overlay content-byte budget (OverlayFs maxMemoryBytes),
   * bounding each fork's copy-up memory. Default: the OverlayFs
   * default.
   */
  maxMemoryBytes?: number;
}

/**
 * Template for cheap parallel forks (see
 * docs/design/vfs-template-fork-model.md). The template owns the shared
 * scratch fs and the mount configuration; each fork() stamps out a
 * ready MountableFs with fresh copy-on-write overlays over every
 * mounted real root. Forks are unmanaged: the template keeps no
 * registry, consumes nothing, and never tracks lifecycles.
 *
 * MERGE IS A REPLAY. `merge` combines the given change sets (fork
 * instances are diffed in vfs space; plain diffs pass through), orders
 * every entry by (changedAt, input order), and applies the entries to a
 * fresh fork with the stock filesystem operations — the same codepath
 * the forks themselves used, over the same lower. Anything the
 * filesystem refuses (write under a file, chmod of a deleted path, ...)
 * is skipped, which keeps conflicting (racy) input deterministic and
 * contained to the conflicted path. After each replayed operation the
 * touched node's changedAt is rewritten from the replay position, so
 * merged output is byte-deterministic and wall-clock-free. The merged
 * fork is returned: diff it and discard it, or keep working on it.
 *
 * ```ts
 * const tpl = createVfsTemplate({ mounts: [{ at: "/project", root: projDir }] });
 * const a = tpl.fork();
 * const b = tpl.fork();
 * await Promise.all([runAgent(a), runAgent(b)]);
 * const merged = await tpl.merge([a, b]);
 * tpl.apply(merged.diff({ space: "host" }));
 * ```
 */
export interface VfsTemplate {
  /** A fresh per-call filesystem: shared scratch + fresh overlays. */
  fork(): MountableFs;
  /**
   * Replay the given sources' change sets onto a fresh fork and return
   * it. Sources may be fork instances (diffed in vfs space) or plain
   * diffs (e.g. serialized across a process boundary). Array order is
   * the tie-break for equal changedAt stamps. Entries outside every
   * mount point replay into the shared scratch (ordinary fork
   * semantics, never reported in diff()) — merge expects diffs in
   * this template's vfs space.
   */
  merge(sources: Array<MountableFs | OverlayDiff>): Promise<MountableFs>;
  /**
   * Validate a merged host-space diff against the mount map (every
   * entry inside a registered root, no symlink writes, no root-self
   * deletion) and apply it to the real filesystem. Type-conflicting
   * on-disk targets are replaced (the change-set supersedes the base).
   */
  apply(merged: OverlayDiff): void;
}

export function createVfsTemplate(options: VfsTemplateOptions): VfsTemplate {
  if (options.mounts.length === 0) {
    throw new FsError("EINVAL", "createVfsTemplate needs at least one mount");
  }
  const mounts = options.mounts.map(({ at, root }) => {
    const canonical = canonicalizeRealPath(root);
    const normalizedAt = at.startsWith("/") ? at : `/${at}`;
    return { at: normalizedAt.replace(/\/+$/, "") || "/", root: canonical };
  });
  const seenAts = new Set<string>();
  for (const { at } of mounts) {
    if (seenAts.has(at)) {
      throw new FsError(
        "EINVAL",
        `duplicate mount point '${at}' in createVfsTemplate`,
      );
    }
    seenAts.add(at);
    if (at === "/") {
      throw new FsError(
        "EINVAL",
        "mount point '/' would swallow the shared scratch space",
      );
    }
    for (const other of seenAts) {
      if (other !== at && at.startsWith(`${other}/`)) {
        throw new FsError(
          "EINVAL",
          `mount point '${at}' is nested inside '${other}'`,
        );
      }
    }
  }
  // Nested host roots put two overlays over one real subtree: each
  // shadows it independently and the forks see divergent state.
  const seenRoots: string[] = [];
  for (const { root } of mounts) {
    for (const other of seenRoots) {
      const sep = nodePath.sep;
      if (
        root !== other &&
        (root.startsWith(other + sep) || other.startsWith(root + sep))
      ) {
        throw new FsError(
          "EINVAL",
          `nested template roots share one real subtree: '${root}' and '${other}'`,
        );
      }
    }
    seenRoots.push(root);
  }

  const scratch = new InMemoryFs();

  const makeVfs = (): MountableFs => {
    const vfs = new MountableFs({ base: scratch });
    for (const { at, root } of mounts) {
      vfs.mount(
        at,
        new OverlayFsImpl({
          root,
          mountPoint: "/",
          ...(options.maxMemoryBytes !== undefined && {
            maxMemoryBytes: options.maxMemoryBytes,
          }),
        }),
      );
    }
    return vfs;
  };

  const fork = (): MountableFs => makeVfs();

  const merge = async (
    sources: Array<MountableFs | OverlayDiff>,
  ): Promise<MountableFs> => {
    type Entry =
      | { kind: "write"; changedAt: number; order: number; write: OverlayWrite }
      | { kind: "delete"; changedAt: number; order: number; path: string };

    const entries: Entry[] = [];
    let order = 0;
    for (const source of sources) {
      const diff =
        source instanceof MountableFs ? source.diff({ space: "vfs" }) : source;
      for (const write of diff.writes) {
        const changedAt = write.changedAt ?? 0;
        entries.push({ kind: "write", changedAt, order: order++, write });
      }
      for (let i = 0; i < diff.deletions.length; i++) {
        const changedAt = diff.deletionChangedAt?.[i] ?? 0;
        entries.push({
          kind: "delete",
          changedAt,
          order: order++,
          path: diff.deletions[i],
        });
      }
    }
    entries.sort((a, b) =>
      a.changedAt !== b.changedAt
        ? a.changedAt - b.changedAt
        : a.order - b.order,
    );

    const target = makeVfs();
    for (const entry of entries) {
      if (
        entry.kind === "write" &&
        entry.write.metadataOnly &&
        entry.write.mode === undefined &&
        entry.write.mtime === undefined
      ) {
        // A content-free metadataOnly entry applies nothing; it must
        // not assert its stamp on the node either.
        continue;
      }
      let applied = false;
      try {
        if (entry.kind === "delete") {
          await target.rm(entry.path, { recursive: true });
        } else {
          const w = entry.write;
          if (w.metadataOnly) {
            if (w.mode !== undefined) await target.chmod(w.path, w.mode);
            if (w.mtime !== undefined) {
              await target.utimes(w.path, w.mtime, w.mtime);
            }
          } else if (w.nodeType === "directory") {
            // mkdir -p: an ensured parent may already exist when a
            // child's write replayed first — the explicit dir entry's
            // metadata must still land (stock idempotent form, not a
            // merge rule).
            await target.mkdir(w.path, { recursive: true });
            if (w.mode !== undefined) await target.chmod(w.path, w.mode);
            if (w.mtime !== undefined) {
              await target.utimes(w.path, w.mtime, w.mtime);
            }
          } else if (w.nodeType === "symlink") {
            // Symlink mode/mtime are not honored by the fs layer.
            await target.symlink(new TextDecoder().decode(w.content), w.path);
          } else {
            await target.writeFile(w.path, w.content);
            if (w.mode !== undefined) await target.chmod(w.path, w.mode);
            if (w.mtime !== undefined) {
              await target.utimes(w.path, w.mtime, w.mtime);
            }
          }
        }
        applied = true;
      } catch {
        // The filesystem refused (ENOTDIR under a file, ENOENT on a
        // missing chmod/rm target, EISDIR on a type collision, EPERM
        // on symlink): conflicting input, refusal contained to this
        // path — skip.
      }
      if (applied) {
        target.restamp(
          entry.kind === "delete" ? entry.path : entry.write.path,
          entry.changedAt,
        );
      } else {
        // A refused op may still have minted parent dirs before
        // failing (e.g. ENOSPC after ensureParentDirs): soften the
        // ancestor chain so no wall-clock stamp reaches the output.
        // The op path itself is untouched — the failed op owns no
        // stamp on a node it did not create.
        target.restamp(
          entry.kind === "delete" ? entry.path : entry.write.path,
          entry.changedAt,
          "ancestors",
        );
      }
    }
    return target;
  };

  const apply = (merged: OverlayDiff): void => {
    // Host-space diffs may carry mixed separators (MountableFs joins
    // with "/" to stay browser-safe); normalize the whole diff up
    // front — applyDiffToRealFs rejects non-normalized paths.
    const normalized: OverlayDiff = {
      writes: merged.writes.map((w) => ({
        ...w,
        path: nodePath.normalize(w.path),
      })),
      deletions: merged.deletions.map((d) => nodePath.normalize(d)),
      ...(merged.deletionChangedAt && {
        deletionChangedAt: merged.deletionChangedAt,
      }),
    };
    for (const write of normalized.writes) {
      if (write.nodeType === "symlink") {
        // Symlink writes are impossible from the supported flow (forks
        // and merge both refuse symlink creation), and a same-diff
        // symlink would redirect LATER entries past the containment
        // check below. Fail loudly.
        throw new FsError(
          "EINVAL",
          `change-set contains a symlink write: '${write.path}'`,
        );
      }
    }
    for (const target of [
      ...normalized.deletions,
      ...normalized.writes.map((w) => w.path),
    ]) {
      const inside = mounts.some(
        ({ root }) => target === root || target.startsWith(root + nodePath.sep),
      );
      if (!inside) {
        throw new FsError(
          "EINVAL",
          `change-set entry outside every template root: '${target}'`,
        );
      }
      if (normalized.deletions.includes(target)) {
        const isRoot = mounts.some(({ root }) => target === root);
        if (isRoot) {
          throw new FsError(
            "EINVAL",
            `change-set deletes a registered root: '${target}'`,
          );
        }
      }
      // Symlink containment: the canonical location of the entry (its
      // deepest existing ancestor, realpath'd, plus the remainder) must
      // also be inside a registered root — otherwise a symlinked
      // directory inside a root would redirect the privileged write
      // outside it.
      const canonicalTarget = canonicalizeDeepest_(target);
      const canonInside = mounts.some(
        ({ root }) =>
          canonicalTarget === root ||
          canonicalTarget.startsWith(root + nodePath.sep),
      );
      if (!canonInside) {
        throw new FsError(
          "EINVAL",
          `change-set entry escapes its root through a symlink: '${target}'`,
        );
      }
    }
    applyDiffToRealFs(normalized);
  };

  return { fork, merge, apply };
}

/** Canonical location of a path: realpath of the deepest existing
 * ancestor plus the not-yet-existing remainder. */
function canonicalizeDeepest_(target: string): string {
  let current = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const canonical = canonicalizeRealPath(current);
      return rest.length === 0
        ? canonical
        : nodePath.join(canonical, ...rest.reverse());
    } catch {
      const parent = nodePath.dirname(current);
      if (parent === current) return target; // unreachable; defensive
      rest.push(nodePath.basename(current));
      current = parent;
    }
  }
}
