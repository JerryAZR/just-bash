import * as nodePath from "node:path";
import { InMemoryFs } from "./in-memory-fs/index.js";
import { MountableFs } from "./mountable-fs/mountable-fs.js";
import { applyDiffToRealFs, canonicalizeRealPath } from "./overlay-fs/apply.js";
import { mergeDiffs } from "./overlay-fs/merge.js";
import type { OverlayDiff, OverlayFs } from "./overlay-fs/overlay-fs.js";
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
   * in the template's shared in-memory scratch fs and behaves like
   * shared memory: visible to every fork immediately.
   */
  mounts: VfsTemplateMount[];
}

/**
 * A process image for parallel agent tool calls (see
 * docs/design/vfs-template-fork-model.md). The template owns the shared
 * scratch fs and the mount configuration; each fork() stamps out a
 * ready MountableFs with fresh copy-on-write overlays over every
 * mounted real root. Forks are single-use: run, diff via merge(),
 * discard.
 *
 * ```ts
 * const tpl = createVfsTemplate({ mounts: [{ at: "/project", root: projDir }] });
 * const a = tpl.fork();
 * const b = tpl.fork();
 * await Promise.all([runA(a), runB(b)]);
 * const merged = tpl.merge([a, b]);  // completion order = tiebreak
 * tpl.apply(merged);
 * ```
 */
export interface VfsTemplate {
  /** A fresh per-call filesystem: shared scratch + fresh overlays. */
  fork(): MountableFs;
  /**
   * Merge the change sets of the given forks (in completion order —
   * the tiebreak under changedAt) into one diff with real absolute
   * paths. Forks not listed are merged after, in registration order.
   */
  merge(forksInCompletionOrder?: MountableFs[]): OverlayDiff;
  /**
   * Validate a merged diff against the mount map (an entry outside
   * every registered root fails loudly) and apply it to the real
   * roots. Consumes all registered forks.
   */
  apply(merged: OverlayDiff): void;
}

export function createVfsTemplate(options: VfsTemplateOptions): VfsTemplate {
  if (options.mounts.length === 0) {
    throw new Error("EINVAL: createVfsTemplate needs at least one mount");
  }
  const mounts = options.mounts.map(({ at, root }) => {
    const canonical = canonicalizeRealPath(root);
    return { at, root: canonical };
  });

  const scratch = new InMemoryFs();
  const registry = new Map<MountableFs, Map<string, OverlayFs>>();

  const fork = (): MountableFs => {
    const vfs = new MountableFs({ base: scratch });
    const overlays = new Map<string, OverlayFs>();
    for (const { at, root } of mounts) {
      const overlay = new OverlayFsImpl({ root, mountPoint: "/" });
      vfs.mount(at, overlay);
      overlays.set(at, overlay);
    }
    registry.set(vfs, overlays);
    return vfs;
  };

  const toAbsoluteDiff = (overlays: Map<string, OverlayFs>): OverlayDiff => {
    const writes = [];
    const deletions: string[] = [];
    const deletionChangedAt: number[] = [];
    for (const [at, overlay] of overlays) {
      const root = mounts.find((m) => m.at === at)?.root;
      if (!root) continue;
      const diff = overlay.diff();
      for (const { path: rel, ...write } of diff.writes) {
        writes.push({ ...write, path: nodePath.join(root, rel) });
      }
      for (let i = 0; i < diff.deletions.length; i++) {
        deletions.push(nodePath.join(root, diff.deletions[i]));
        deletionChangedAt.push(diff.deletionChangedAt?.[i] ?? 0);
      }
    }
    return {
      writes,
      deletions,
      ...(deletions.length > 0 && { deletionChangedAt }),
    };
  };

  const merge = (forksInCompletionOrder?: MountableFs[]): OverlayDiff => {
    const listed = forksInCompletionOrder ?? [];
    const rest = [...registry.keys()].filter((f) => !listed.includes(f));
    const ordered = [...listed, ...rest];
    return mergeDiffs(
      ordered.map((f) => {
        const overlays = registry.get(f);
        if (!overlays) {
          throw new Error(
            "EINVAL: merge() got a filesystem this template did not fork",
          );
        }
        return toAbsoluteDiff(overlays);
      }),
    );
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
        throw new Error(
          `EINVAL: change-set entry outside every template root: '${target}'`,
        );
      }
    }
    applyDiffToRealFs(merged);
    registry.clear();
  };

  return { fork, merge, apply };
}
