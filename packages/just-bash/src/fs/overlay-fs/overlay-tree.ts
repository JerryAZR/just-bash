/**
 * Overlay upper-layer tree.
 *
 * Pure data structure backing OverlayFs's copy-on-write layer: entry nodes
 * (file/directory/symlink) shadow lower-layer paths, whiteout nodes mark
 * deleted lower-layer paths. The tree root is the VFS root ("/").
 *
 * Design notes:
 * - No parent pointers. Every operation starts with descend(), whose
 *   ancestry stack gives mutations all the context they need — the tree
 *   cannot disagree with itself about where a node lives.
 * - Whiteouts are tree nodes, so "is this path hidden?" is answered by the
 *   descent itself ("blocked"), not by a parallel tombstone set.
 * - Type-safe mutation: attach() refuses to replace a directory with a
 *   file/symlink (EISDIR) or an entry with a directory (EEXIST), mirroring
 *   what real bash reports at the syscall boundary. detach()/putWhiteout()
 *   may remove anything (rm semantics).
 * - Byte accounting is centralized here so retainedBytes always equals the
 *   sum of file bytes over the tree (directories, symlinks, whiteouts: 0).
 *
 * All traversals are iterative — no recursion depth limits on deep trees.
 */

import { DEFAULT_DIR_MODE } from "../path-utils.js";

export interface OverlayFileNode {
  type: "file";
  content: Uint8Array;
  /**
   * Metacopy marker (Linux overlayfs metacopy semantics): metadata
   * (mode/mtime) is upper-layer, data is still lower-layer. Created by
   * chmod/utimes copy-up so metadata-only changes cost O(1) instead of a
   * full content copy. Reads fall through to the lower file (or promote
   * to a full node on Windows, where metadata is advisory); the first
   * content write completes the copy-up, preserving the upper mode.
   */
  metacopy?: boolean;
  /** Lower-layer file size recorded at metacopy creation (for stat). */
  lowerSize?: number;
  /** Append segments retained without copying the complete file per append. */
  appendChunks?: Uint8Array[];
  /**
   * Mutation sequence stamp (tree-local, monotonically increasing).
   * Set by in-place mutations (appendChunk, chmod, utimes) so sync()
   * can compare-and-swap: an entry checked against disk is only
   * detached if it has not been mutated since the check began.
   * Node replacement (attach/detach) needs no stamp — object identity
   * already changes. Undefined means never mutated in place.
   */
  seq?: number;
  /**
   * Wall-clock time of the last mutation (attach/touch), stamped by the
   * tree. Distinct from `mtime`: user-visible and utimes-able, whereas
   * changedAt is the untamperable ordering key mergeDiffs relies on.
   */
  changedAt?: number;
  mode: number;
  mtime: Date;
  identity?: string;
}

export interface OverlayDirNode {
  type: "directory";
  /** Child nodes keyed by name segment, in insertion order. */
  children: Map<string, OverlayNode>;
  /** In-place mutation stamp (see OverlayFileNode.seq). */
  seq?: number;
  /** Wall-clock time of the last mutation (see OverlayFileNode.changedAt). */
  changedAt?: number;
  mode: number;
  mtime: Date;
  identity?: string;
}

export interface OverlaySymlinkNode {
  type: "symlink";
  target: string;
  /** In-place mutation stamp (see OverlayFileNode.seq). */
  seq?: number;
  /** Wall-clock time of the last mutation (see OverlayFileNode.changedAt). */
  changedAt?: number;
  mode: number;
  mtime: Date;
}

/** Leaf marker hiding a lower-layer (real-FS) path and everything under it. */
export interface OverlayWhiteoutNode {
  type: "whiteout";
  /** Wall-clock time the whiteout was created (merge ordering). */
  changedAt?: number;
}

export type OverlayEntryNode =
  | OverlayFileNode
  | OverlayDirNode
  | OverlaySymlinkNode;
export type OverlayNode = OverlayEntryNode | OverlayWhiteoutNode;

/**
 * Result of walking a path through the tree.
 *
 * - `found`: an entry or whiteout exists at the exact path. `stack` holds
 *   the ancestry of directory nodes, root first, parent last (empty for "/").
 * - `missing`: nothing shadows the path — the caller may fall through to the
 *   lower layer. `missingAt` is the index of the first absent segment.
 * - `blocked`: a whiteout sits at or above the path — ENOENT, with no
 *   lower-layer fallthrough. `blockedAt` is the whiteout's segment index.
 * - `notdir`: a file/symlink entry blocks descent below it — ENOTDIR.
 *   `notdirAt` is the entry's segment index.
 */
export type DescentResult =
  | { kind: "found"; stack: OverlayDirNode[]; node: OverlayNode }
  | { kind: "missing"; stack: OverlayDirNode[]; missingAt: number }
  | { kind: "blocked"; stack: OverlayDirNode[]; blockedAt: number }
  | { kind: "notdir"; stack: OverlayDirNode[]; notdirAt: number };

function fileBytes(node: OverlayFileNode): number {
  let bytes = node.content.byteLength;
  for (const chunk of node.appendChunks ?? []) bytes += chunk.byteLength;
  return bytes;
}

/** Byte size of a file node (base content + append chunks). */
export function fileNodeBytes(node: OverlayFileNode): number {
  return fileBytes(node);
}

/**
 * Merge a file node's base content and append chunks into one buffer,
 * compacting the node in place. Total byte accounting is unchanged (the
 * chunk bytes move into content), so the retainedBytes invariant holds.
 */
export function coalesceFileContent(
  node: OverlayFileNode,
  virtualPath: string,
): Uint8Array {
  if (!node.appendChunks || node.appendChunks.length === 0) {
    return node.content;
  }
  const total = node.appendChunks.reduce(
    (sum, chunk) => sum + chunk.byteLength,
    node.content.byteLength,
  );
  if (!Number.isSafeInteger(total)) {
    throw new Error(`EFBIG: file too large, read '${virtualPath}'`);
  }
  const combined = new Uint8Array(total);
  combined.set(node.content);
  let offset = node.content.byteLength;
  for (const chunk of node.appendChunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  node.content = combined;
  node.appendChunks = undefined;
  return combined;
}

/** Byte cost of a single node, excluding any directory children. */
function nodeBytes(node: OverlayNode | undefined): number {
  if (!node || node.type !== "file") return 0;
  return fileBytes(node);
}

function freshDirNode(): OverlayDirNode {
  return {
    type: "directory",
    children: new Map(),
    mode: DEFAULT_DIR_MODE,
    mtime: new Date(),
  };
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export class OverlayTree {
  private rootNode: OverlayDirNode = freshDirNode();
  private bytes = 0;
  private mutationSeq_ = 0;

  constructor(private readonly maxMemoryBytes: number) {}

  /** The root directory node — the VFS root ("/"). */
  get root(): OverlayDirNode {
    return this.rootNode;
  }

  /** Sum of file bytes retained in the tree (whiteouts and metadata: 0). */
  get retainedBytes(): number {
    return this.bytes;
  }

  /**
   * Walk `path` segment by segment from the root. See DescentResult for the
   * four outcomes and their meanings.
   */
  descend(path: string): DescentResult {
    const segments = splitPath(path);
    const stack: OverlayDirNode[] = [this.rootNode];
    let current = this.rootNode;
    for (let i = 0; i < segments.length; i++) {
      const child = current.children.get(segments[i]);
      if (child === undefined) {
        return { kind: "missing", stack, missingAt: i };
      }
      if (i === segments.length - 1) {
        return { kind: "found", stack, node: child };
      }
      if (child.type === "whiteout") {
        return { kind: "blocked", stack, blockedAt: i };
      }
      if (child.type !== "directory") {
        return { kind: "notdir", stack, notdirAt: i };
      }
      stack.push(child);
      current = child;
    }
    // The path is "/" itself: no ancestry, node is the root.
    return { kind: "found", stack: [], node: this.rootNode };
  }

  /**
   * Ensure every segment of `path` exists as a directory, creating missing
   * ones and resurrecting whiteouts into fresh directories
   * (write-under-deleted-dir semantics). Returns the directory at `path`.
   * Throws ENOTDIR when a file/symlink entry blocks the path.
   *
   * Resurrection preserves deletions explicitly: for each resurrected
   * directory the `lowerChildren` callback is invoked with its VFS path,
   * and every returned lower-layer name gets a whiteout child — the old
   * contents stay deleted exactly where they live, at any depth, with no
   * ancestry state in lookups. A null return (lower layer unreadable or
   * gone) populates nothing: lookups then degrade to individual lower-layer
   * errors rather than leaking.
   */
  ensureDirs(
    path: string,
    lowerChildren?: (vfsPath: string) => Iterable<string> | null,
  ): OverlayDirNode {
    let current = this.rootNode;
    let currentPath = "";
    for (const segment of splitPath(path)) {
      currentPath = `${currentPath}/${segment}`;
      let child = current.children.get(segment);
      if (child === undefined) {
        child = freshDirNode();
        current.children.set(segment, child);
      } else if (child.type === "whiteout") {
        child = this.resurrectDir(current, segment, currentPath, lowerChildren);
      } else if (child.type !== "directory") {
        throw new Error(`ENOTDIR: not a directory, mkdir '${path}'`);
      }
      current = child;
    }
    return current;
  }

  /**
   * Replace the whiteout at `parent/name` with a fresh directory, marking
   * each lower-layer child with a whiteout so recreating the directory does
   * not bring its deleted contents back.
   */
  private resurrectDir(
    parent: OverlayDirNode,
    name: string,
    vfsPath: string,
    lowerChildren?: (vfsPath: string) => Iterable<string> | null,
  ): OverlayDirNode {
    const dir = freshDirNode();
    parent.children.set(name, dir);
    const lower = lowerChildren?.(vfsPath);
    if (lower) {
      for (const childName of lower) {
        if (!dir.children.has(childName)) {
          dir.children.set(childName, { type: "whiteout" });
        }
      }
    }
    return dir;
  }

  /**
   * Insert or replace the entry at `path`. The parent must already exist as
   * a directory (callers use ensureDirs first). Type rules mirror real bash
   * at the syscall boundary:
   * - file/symlink replacing a directory → EISDIR
   * - directory replacing any existing node → EEXIST (directory
   *   resurrection after deletion must go through ensureDirs, which
   *   populates lower-layer whiteouts)
   * - file/symlink replacing a whiteout, file, or symlink → legal
   *   (write-over / recreate-after-delete)
   */
  attach(path: string, node: OverlayEntryNode): void {
    node.changedAt = Date.now();
    const segments = splitPath(path);
    if (segments.length === 0) {
      throw new Error(`EINVAL: cannot attach at root, attach '${path}'`);
    }
    const parent = this.parentDirOf(segments, path);
    const current = parent.children.get(segments[segments.length - 1]);
    if (current?.type === "directory" && node.type !== "directory") {
      throw new Error(
        `EISDIR: cannot replace directory with ${node.type}, attach '${path}'`,
      );
    }
    if (current !== undefined && node.type === "directory") {
      throw new Error(
        `EEXIST: cannot replace ${current.type} with directory, attach '${path}'`,
      );
    }
    // The rules above never let attach() replace a non-empty directory, so
    // only single-node byte costs matter here; subtree release is detach().
    const released = nodeBytes(current);
    const added = nodeBytes(node);
    this.assertCapacity(added, released);
    parent.children.set(segments[segments.length - 1], node);
    this.bytes += added - released;
  }

  /**
   * Remove the entry or whiteout at `path`, releasing the byte cost of the
   * whole dropped subtree. Returns the removed node, or undefined when the
   * path is missing, blocked, or the root.
   */
  detach(path: string): OverlayNode | undefined {
    const segments = splitPath(path);
    if (segments.length === 0) return undefined;
    const result = this.descend(path);
    if (result.kind !== "found") return undefined;
    const parent = result.stack[result.stack.length - 1];
    parent.children.delete(segments[segments.length - 1]);
    this.bytes -= OverlayTree.subtreeBytes(result.node);
    return result.node;
  }

  /**
   * Mark `path` as deleted in the lower layer: ensure the parent chain
   * exists, then replace whatever child is there with a whiteout, releasing
   * the dropped subtree's bytes. Idempotent. This is the rm primitive.
   */
  putWhiteout(path: string): void {
    const segments = splitPath(path);
    if (segments.length === 0) {
      throw new Error(`EINVAL: cannot whiteout the root, rm '${path}'`);
    }
    let parent = this.rootNode;
    for (let i = 0; i < segments.length - 1; i++) {
      parent = this.ensureChildDir(parent, segments[i], path);
    }
    const name = segments[segments.length - 1];
    const current = parent.children.get(name);
    if (current?.type === "whiteout") return;
    this.bytes -= OverlayTree.subtreeBytes(current);
    parent.children.set(name, { type: "whiteout", changedAt: Date.now() });
  }

  /**
   * Append a chunk to a file node, accounting its bytes against capacity.
   */
  appendChunk(node: OverlayFileNode, chunk: Uint8Array): void {
    this.assertCapacity(chunk.byteLength);
    if (!node.appendChunks) node.appendChunks = [];
    node.appendChunks.push(chunk);
    this.bytes += chunk.byteLength;
    this.touch(node);
  }

  /** Stamp a node as mutated in place (see OverlayFileNode.seq). */
  touch(node: { seq?: number; changedAt?: number }): void {
    node.seq = ++this.mutationSeq_;
    node.changedAt = Date.now();
  }

  /**
   * Compare-and-swap detach: remove the node at `path` only if it is
   * still the exact same object with the same mutation sequence — i.e.
   * nothing changed it while the caller's (async) verification ran.
   * Also refuses to detach a directory that has gained children.
   * Returns whether the detach happened.
   */
  detachIfUnchanged(path: string, node: OverlayNode, seq?: number): boolean {
    const result = this.descend(path);
    if (result.kind !== "found" || result.node !== node) return false;
    // Strict compare, no undefined guard: an unstamped node (undefined)
    // that receives its first stamp mid-check must NOT match.
    if ((node as { seq?: number }).seq !== seq) return false;
    if (node.type === "directory" && node.children.size > 0) return false;
    this.detach(path);
    return true;
  }

  /**
   * Yield every node, parents before children (pre-order), starting with the
   * root at path "/". Whiteouts are included; callers filter as needed.
   */
  *preOrder(): Generator<{ path: string; node: OverlayNode }> {
    const stack: { path: string; node: OverlayNode }[] = [
      { path: "/", node: this.rootNode },
    ];
    while (stack.length > 0) {
      const item = stack.pop() as { path: string; node: OverlayNode };
      yield item;
      if (item.node.type === "directory") {
        // Push reversed so iteration follows insertion order.
        const children = [...item.node.children.entries()];
        for (let i = children.length - 1; i >= 0; i--) {
          const [name, child] = children[i];
          stack.push({ path: joinPath(item.path, name), node: child });
        }
      }
    }
  }

  /**
   * Yield every node, children before parents (post-order) — the order in
   * which bottom-up drops are safe. Whiteouts are included.
   */
  *postOrder(): Generator<{ path: string; node: OverlayNode }> {
    // Materialized eagerly so callers may detach nodes during iteration
    // (sync() relies on this — do not "optimize" into a lazy generator).
    const out: { path: string; node: OverlayNode }[] = [];
    const stack: { path: string; node: OverlayNode }[] = [
      { path: "/", node: this.rootNode },
    ];
    while (stack.length > 0) {
      const item = stack.pop() as { path: string; node: OverlayNode };
      out.push(item);
      if (item.node.type === "directory") {
        for (const [name, child] of item.node.children) {
          stack.push({ path: joinPath(item.path, name), node: child });
        }
      }
    }
    for (let i = out.length - 1; i >= 0; i--) {
      yield out[i];
    }
  }

  /** Discard the whole tree, resetting byte accounting. */
  clear(): void {
    this.rootNode = freshDirNode();
    this.bytes = 0;
  }

  /** Sum of file bytes over the node's subtree (0 for non-directories). */
  private static subtreeBytes(node: OverlayNode | undefined): number {
    if (node === undefined) return 0;
    if (node.type === "file") return fileBytes(node);
    if (node.type !== "directory") return 0;
    let total = 0;
    const queue: OverlayDirNode[] = [node];
    while (queue.length > 0) {
      const dir = queue.pop() as OverlayDirNode;
      for (const child of dir.children.values()) {
        if (child.type === "file") total += fileBytes(child);
        else if (child.type === "directory") queue.push(child);
      }
    }
    return total;
  }

  /** Descend to the parent of `segments`, which must exist as directories. */
  private parentDirOf(segments: string[], path: string): OverlayDirNode {
    let current = this.rootNode;
    for (let i = 0; i < segments.length - 1; i++) {
      const child = current.children.get(segments[i]);
      if (child?.type !== "directory") {
        throw new Error(`ENOTDIR: not a directory, attach '${path}'`);
      }
      current = child;
    }
    return current;
  }

  /** Descend one level for putWhiteout, creating/resurrecting as needed. */
  private ensureChildDir(
    parent: OverlayDirNode,
    name: string,
    path: string,
  ): OverlayDirNode {
    let child = parent.children.get(name);
    if (child === undefined || child.type === "whiteout") {
      // Callers verify visibility before whiteouting (rm checks existence
      // first), so a whiteout ancestor is not expected here; resurrect
      // plainly if one appears.
      child = freshDirNode();
      parent.children.set(name, child);
    } else if (child.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory, rm '${path}'`);
    }
    return child;
  }

  private assertCapacity(added: number, released = 0): void {
    if (
      !Number.isSafeInteger(added) ||
      added < 0 ||
      added > this.maxMemoryBytes - this.bytes + released
    ) {
      throw new Error(
        `ENOSPC: overlay memory byte limit exceeded (${this.maxMemoryBytes} bytes)`,
      );
    }
  }
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}
