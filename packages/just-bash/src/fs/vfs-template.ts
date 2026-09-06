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
   * the tie-break for equal changedAt stamps.
   */
  merge(sources: Array<MountableFs | OverlayDiff>): Promise<MountableFs>;
  /**
   * Validate a merged host-space diff against the mount map (every
   * entry inside a registered root, symlink containment) and apply it
   * to the real filesystem.
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
  }

  const scratch = new InMemoryFs();

  const makeVfs = (): MountableFs => {
    const vfs = new MountableFs({ base: scratch });
    for (const { at, root } of mounts) {
      vfs.mount(at, new OverlayFsImpl({ root, mountPoint: "/" }));
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
            await target.mkdir(w.path);
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
        target.restamp(
          entry.kind === "delete" ? entry.path : entry.write.path,
          entry.changedAt,
        );
      } catch {
        // The filesystem refused (ENOTDIR under a file, ENOENT on a
        // missing chmod/rm target, EEXIST on mkdir, EPERM on symlink):
        // conflicting input, refusal contained to this path — skip.
      }
    }
    return target;
  };

  const apply = (merged: OverlayDiff): void => {
    for (const target of [
      ...merged.deletions,
      ...merged.writes.map((w) => w.path),
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
    applyDiffToRealFs(merged);
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
