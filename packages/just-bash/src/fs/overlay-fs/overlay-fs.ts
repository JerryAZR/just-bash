/**
 * OverlayFs - Copy-on-write filesystem backed by a real directory
 *
 * Reads come from the real filesystem, writes go to an in-memory layer.
 * Changes don't persist to disk and can't escape the root directory.
 *
 * Security: Symlinks are blocked by default (allowSymlinks: false).
 * All real-FS access goes through resolveRealPath_() / resolveRealPathParent_()
 * gates which detect symlink traversal via path comparison and return the
 * canonical path for I/O (closing the TOCTOU gap). New methods must use these
 * gates — never access the real FS directly.
 *
 * Concurrent modification of the underlying directory is not supported.
 * OverlayFs does not detect changes made to the underlying directory outside
 * the overlay while an instance is live. If such changes occur, behavior is
 * undefined and data loss is a possible outcome — including deletion of
 * files the overlay never saw, when applying a diff() computed against a
 * stale view. After intentional external changes (e.g. a native run
 * between sandbox sessions), call sync() or reset() to re-baseline before
 * continuing.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { type ByteString, unsafeBytesFromLatin1 } from "../../encoding.js";
import {
  type FileContent,
  fromBuffer,
  getEncoding,
  toBuffer,
} from "../encoding.js";
import { FsError, isFsErrorCode } from "../fs-error.js";
import type {
  CpOptions,
  DirentEntry,
  FsStat,
  IFileSystem,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WriteFileOptions,
} from "../interface.js";
import {
  DEFAULT_FILE_MODE,
  dirname,
  MAX_SYMLINK_DEPTH,
  resolveSymlinkTarget,
  resolvePath as resolveVPath,
  SYMLINK_MODE,
} from "../path-utils.js";
import {
  isPathWithinRoot,
  isSameOrDescendantPath,
  lstatReal,
  lstatRealSync,
  normalizePath,
  resolveCanonicalPath,
  resolveCanonicalPathNoSymlinks,
  sanitizeFsError,
  sanitizeSymlinkTarget,
  validatePath,
  validateRootDirectory,
} from "../real-fs-utils.js";
import {
  coalesceFileContent,
  fileNodeBytes,
  type OverlayDirNode,
  type OverlayEntryNode,
  type OverlayFileNode,
  OverlayTree,
} from "./overlay-tree.js";

/** Error patterns that are safe to pass through (contain virtual paths, not real ones). */
const OVERLAY_PASSTHROUGH_ERRORS = ["ELOOP", "EFBIG", "EPERM"] as const;

/** Kind of entry recorded in an {@link OverlayWrite}. */
export type OverlayNodeType = "file" | "directory" | "symlink";

/**
 * A single write captured in the overlay's upper layer.
 */
export interface OverlayWrite {
  /**
   * Path relative to the overlay root, with a leading slash
   * (e.g. `"/src/app.ts"`). Join it with the host-side root directory to
   * materialize the change.
   */
  path: string;
  /** Kind of entry written. */
  nodeType: OverlayNodeType;
  /**
   * File content; the symlink target (as UTF-8 bytes) for symlinks; empty
   * for directories and for metadata-only writes.
   */
  content: Uint8Array;
  /**
   * Unix-style permission mode to apply when materializing on the host.
   * Advisory on Windows (maps at most to the read-only attribute).
   */
  mode: number;
  /** Modification time; hosts may apply it (utimes) for fidelity. */
  mtime: Date;
  /**
   * Wall-clock time the overlay recorded this mutation (attach or last
   * in-place change). Unlike `mtime` this cannot be set from inside the
   * sandbox, which makes it the trustworthy ordering key for merging
   * change sets from independent overlays (see mergeDiffs).
   */
  changedAt?: number;
  /**
   * When true, only metadata changed (chmod/utimes via a metacopy shadow):
   * apply `mode` and `mtime` and never touch file content.
   */
  metadataOnly?: boolean;
}

/**
 * All changes recorded in an overlay relative to its lower directory:
 * the upper-layer write set plus the deletions (whiteouts) of lower paths.
 *
 * Hosts embedding just-bash use this to apply sandboxed writes to the real
 * project directory after execution (or prompt about them) — the overlay
 * itself never modifies disk.
 */
export interface OverlayDiff {
  /** Every entry created or modified under the mount point, sorted by path. */
  writes: OverlayWrite[];
  /**
   * Root-relative paths deleted during execution, sorted. Whiteout nodes
   * never nest, so each entry is a top-most deletion covering its subtree.
   */
  deletions: string[];
  /**
   * Wall-clock creation time of each whiteout, aligned with `deletions`
   * (same order). Overlay-assigned and untamperable — the ordering key
   * for merging deletions against writes from other overlays. Present
   * whenever `deletions` is non-empty; absent otherwise.
   */
  deletionChangedAt?: number[];
}

export interface OverlayFsOptions {
  /**
   * The root directory on the real filesystem.
   * All paths are relative to this root and cannot escape it.
   */
  root: string;

  /**
   * The virtual mount point where the root directory appears.
   * Defaults to "/home/user/project".
   */
  mountPoint?: string;

  /**
   * If true, all write operations will throw an error.
   * Useful for truly read-only access to the filesystem.
   * Defaults to false.
   */
  readOnly?: boolean;

  /**
   * Maximum file size in bytes that can be read from the real filesystem.
   * Files larger than this will throw an EFBIG error.
   * Defaults to 10MB (10485760).
   */
  maxFileReadSize?: number;

  /**
   * Maximum bytes retained by copy-on-write files in the memory layer.
   * Defaults to 1 GiB. Real backing files are not counted until copied.
   */
  maxMemoryBytes?: number;

  /**
   * Whether to allow following and creating symlinks on the real filesystem.
   * When false (default), any real-FS path traversing a symlink is rejected
   * and symlink() throws EPERM.
   */
  allowSymlinks?: boolean;
}

/** Default mount point for OverlayFs */
const DEFAULT_MOUNT_POINT = "/home/user/project";

export class OverlayFs implements IFileSystem {
  private readonly root: string;
  private readonly canonicalRoot: string;
  private readonly mountPoint: string;
  private readonly readOnly: boolean;
  private readonly maxFileReadSize: number;
  private readonly maxMemoryBytes: number;
  private readonly allowSymlinks: boolean;
  private readonly tree: OverlayTree;
  private nextMemoryIdentity = 1;

  private identityFor(entry: OverlayEntryNode): string {
    if (entry.type === "symlink") return "";
    if (!entry.identity) {
      entry.identity = `overlay:${this.nextMemoryIdentity++}`;
    }
    return entry.identity;
  }

  constructor(options: OverlayFsOptions) {
    // Resolve to absolute path
    this.root = nodePath.resolve(options.root);

    // Normalize mount point (ensure it starts with / and has no trailing /)
    const mp = options.mountPoint ?? DEFAULT_MOUNT_POINT;
    this.mountPoint = mp === "/" ? "/" : mp.replace(/\/+$/, "");
    if (!this.mountPoint.startsWith("/")) {
      throw new Error(`Mount point must be an absolute path: ${mp}`);
    }

    // Set read-only mode
    this.readOnly = options.readOnly ?? false;

    // Set max file read size (default 10MB)
    this.maxFileReadSize = options.maxFileReadSize ?? 10485760;

    this.maxMemoryBytes = options.maxMemoryBytes ?? 1024 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxMemoryBytes) || this.maxMemoryBytes < 0) {
      throw new Error("OverlayFs: invalid maxMemoryBytes");
    }

    // Set symlink policy
    this.allowSymlinks = options.allowSymlinks ?? false;

    // Verify root exists and is a directory
    validateRootDirectory(this.root, "OverlayFs");

    // Compute canonical root (resolves symlinks like /var -> /private/var on macOS)
    this.canonicalRoot = fs.realpathSync(this.root);

    // Upper layer: entry nodes shadow lower paths, whiteouts mark deletions.
    this.tree = new OverlayTree(this.maxMemoryBytes);

    // Create mount point directory structure in memory layer
    this.createMountPointDirs();
  }

  /**
   * Throws an error if the filesystem is in read-only mode.
   */
  private assertWritable(operation: string): void {
    if (this.readOnly) {
      throw new FsError("EROFS", `read-only file system, ${operation}`);
    }
  }

  /**
   * Create directory entries for the mount point path
   */
  private createMountPointDirs(): void {
    this.tree.ensureDirs(this.mountPoint);
  }

  /**
   * Get the mount point for this overlay
   */
  getMountPoint(): string {
    return this.mountPoint;
  }

  /**
   * Return all changes recorded in this overlay since construction (or the
   * last {@link reset}): every write captured in the upper layer and every
   * deletion of a lower-layer path.
   *
   * Paths are reported relative to the overlay root with a leading slash
   * (e.g. `"/README.md"`), ready to join with the host-side root directory.
   * The mount root itself is never reported, and writes outside the mount
   * point (e.g. `/tmp` scratch files) are excluded: they have no disk
   * counterpart to apply against.
   *
   * Semantics worth relying on:
   * - **Modify** — an internal copy-up shadows the disk file; the diff
   *   shows one write with the new content.
   * - **Metadata-only change (chmod/utimes)** — one write with
   *   `metadataOnly: true` and empty content; apply mode/mtime only.
   * - **Create** — one write, including parent directories created on
   *   demand.
   * - **Delete then recreate** — reported as a write, not a deletion.
   * - **`rm -rf dir`** — one deletion for `dir`, not one per child
   *   (whiteouts never nest, so every reported deletion is top-most).
   * - **Create then delete (never on disk)** — appears in neither list.
   *
   * Pure tree walk plus a synchronous existence check per whiteout and
   * metacopy node. See the class-level policy on concurrent modification
   * of the underlying directory.
   */
  diff(): OverlayDiff {
    const writes: OverlayWrite[] = [];
    const deletions: string[] = [];
    const deletionChangedAt: number[] = [];
    for (const { path, node } of this.tree.preOrder()) {
      const relative = this.getRelativeToMount(path);
      if (relative === null || relative === "/") continue;
      if (node.type === "whiteout") {
        // Skip stale markers whose disk path is already gone.
        if (this.existsOnRealFs(path)) {
          deletions.push(relative);
          deletionChangedAt.push(node.changedAt ?? 0);
        }
        continue;
      }
      if (node.type === "file") {
        if (node.metacopy) {
          // A metacopy node whose lower file vanished (out-of-band) has
          // no meaningful content to report — skip rather than emit a
          // phantom empty write.
          if (!this.existsOnRealFs(path)) continue;
          writes.push({
            path: relative,
            nodeType: "file",
            content: new Uint8Array(0),
            mode: node.mode,
            mtime: node.mtime,
            changedAt: node.changedAt ?? 0,
            metadataOnly: true,
          });
        } else {
          writes.push({
            path: relative,
            nodeType: "file",
            content: coalesceFileContent(node, path),
            mode: node.mode,
            mtime: node.mtime,
            changedAt: node.changedAt ?? 0,
          });
        }
      } else if (node.type === "directory") {
        writes.push({
          path: relative,
          nodeType: "directory",
          content: new Uint8Array(0),
          mode: node.mode,
          mtime: node.mtime,
          changedAt: node.changedAt ?? 0,
        });
      } else {
        writes.push({
          path: relative,
          nodeType: "symlink",
          content: new TextEncoder().encode(node.target),
          mode: node.mode,
          mtime: node.mtime,
          changedAt: node.changedAt ?? 0,
        });
      }
    }
    writes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // Sort deletions together with their stamps to keep the parallel
    // arrays aligned.
    const zipped = deletions.map((d, i) => ({
      path: d,
      changedAt: deletionChangedAt[i],
    }));
    zipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      writes,
      deletions: zipped.map((z) => z.path),
      // Present only when there are deletions, so empty-diff consumers
      // see the shape they have always seen.
      ...(zipped.length > 0 && {
        deletionChangedAt: zipped.map((z) => z.changedAt),
      }),
    };
  }

  /**
   * Reconcile the overlay with current disk state: drop every upper-layer
   * shadow that now matches the lower directory, and clear whiteouts whose
   * disk paths no longer exist. Entries that still differ remain pending
   * and keep appearing in {@link diff}.
   *
   * After the host applies writes (or a native run rewrites files),
   * `sync()` leaves the overlay holding "exactly the differences from disk
   * right now": applied writes and deletions disappear, failed or
   * conflicting ones stay visible — no per-path bookkeeping needed.
   * Matching rules: content nodes compare bytes; metacopy nodes compare
   * mtime everywhere and mode on POSIX (mode is advisory on Windows);
   * directories match on existence and drop only once every child was
   * dropped (post-order guarantees children reconcile first).
   */
  async sync(): Promise<void> {
    for (const { path, node } of this.tree.postOrder()) {
      const relative = this.getRelativeToMount(path);
      if (relative === null || relative === "/") continue;
      if (node.type === "whiteout") {
        // Stale marker (deletion applied, or disk changed out-of-band):
        // nothing left to hide.
        if (!this.existsOnRealFs(path)) this.tree.detach(path);
        continue;
      }
      if (node.type === "directory" && node.children.size > 0) {
        // Still the container of pending children.
        continue;
      }
      // Capture the mutation stamp BEFORE the async disk check: the
      // compare-and-swap below is only meaningful against a pre-check value.
      const seq = node.seq;
      if (await this.nodeMatchesDisk(path, node)) {
        // Compare-and-swap: a concurrent exec may have mutated (or
        // replaced) this entry while the disk check was in flight —
        // detaching then would silently drop a write that never
        // reached disk. Mutated entries stay pending for the next sync.
        this.tree.detachIfUnchanged(path, node, seq);
      }
    }
  }

  /**
   * Discard all pending state: clear the upper layer so the overlay
   * re-baselines on current disk state (trust-disk switch after native
   * runs). Unlike {@link sync}, which keeps entries that genuinely differ
   * from disk, `reset()` deliberately forgets them.
   */
  reset(): void {
    this.tree.clear();
    this.createMountPointDirs();
  }

  /**
   * Drop pending upper-layer state at the given paths (root-relative with
   * a leading slash, exactly as {@link diff} emits them). Pure tree
   * operation — no disk I/O, no match verification: the caller asserts
   * these entries are done with, for whatever reason (applied to disk,
   * rejected, superseded); the overlay does not care which.
   *
   * Per path: file/symlink nodes detach; whiteouts detach (dropping a
   * pending deletion resurrects the lower-layer view of the path);
   * directory nodes detach only when childless of pending children (same
   * structural rule as {@link sync}), so a listed directory with
   * still-pending children is kept until they drain. Unknown paths are a
   * no-op. Nested paths in one call are handled deepest-first, so
   * children drain before their parents are evaluated.
   *
   * {@link reset} is drop-everything; {@link sync} is drop-what-matches-
   * disk. `drop()` is for callers that already know which entries are
   * done — e.g. a host that just applied a change set.
   */
  drop(paths: string[]): void {
    // diff() emits mount-relative paths; map them back to tree paths.
    const normalized = paths.map((p) => {
      const rel = normalizePath(p);
      if (rel === "/") {
        throw new FsError("EINVAL", `invalid argument, drop '${p}'`);
      }
      return this.mountPoint === "/" ? rel : `${this.mountPoint}${rel}`;
    });
    // Deepest-first: an ancestor is always a strict prefix (hence
    // shorter), so length sorting drains children before their parents.
    normalized.sort((a, b) => b.length - a.length);
    for (const p of normalized) {
      const result = this.tree.descend(p);
      if (result.kind !== "found") continue;
      const node = result.node;
      if (node.type === "directory" && node.children.size > 0) continue;
      this.tree.detach(p);
    }
  }

  /**
   * True when the disk entry at `path` matches the upper-layer shadow:
   * byte-identical content for full file nodes, metadata for metacopy
   * nodes (mtime everywhere, mode on POSIX), existence for directories,
   * same target for symlinks.
   */
  /**
   * lstat the lower-layer counterpart of a virtual path via parent-based
   * canonical resolution (the path itself may not exist as a real file,
   * e.g. an upper symlink shadow). Returns null when the path has no
   * real-FS counterpart or the lstat fails.
   */
  private async lstatLower(
    path: string,
  ): Promise<{ canonical: string; stat: fs.Stats } | null> {
    const canonical = this.resolveRealPathParent_(this.toRealPath(path));
    if (!canonical) return null;
    try {
      return { canonical, stat: await lstatReal(canonical) };
    } catch {
      return null;
    }
  }

  private async nodeMatchesDisk(
    path: string,
    node: OverlayEntryNode,
  ): Promise<boolean> {
    if (node.type === "directory") {
      const lower = await this.lstatLower(path);
      return lower?.stat.isDirectory() ?? false;
    }

    if (node.type === "symlink") {
      if (!this.allowSymlinks) return false;
      const lower = await this.lstatLower(path);
      if (!lower?.stat.isSymbolicLink()) return false;
      try {
        const rawTarget = await fs.promises.readlink(lower.canonical);
        return this.realTargetToVirtual(rawTarget) === node.target;
      } catch {
        return false;
      }
    }

    if (node.metacopy) {
      const lower = await this.lstatLower(path);
      if (!lower?.stat.isFile()) return false;
      const { stat } = lower;
      if (stat.mtime.getTime() !== node.mtime.getTime()) return false;
      if (
        process.platform !== "win32" &&
        (stat.mode & 0o7777) !== (node.mode & 0o7777)
      ) {
        return false;
      }
      return true;
    }

    // Full file node: byte-for-byte comparison. Use the canonical path and
    // O_NOFOLLOW for I/O, same TOCTOU discipline as readFileBuffer.
    const canonical = this.resolveRealPath_(this.toRealPath(path));
    if (!canonical) return false;
    try {
      const stat = await lstatReal(canonical);
      if (!stat.isFile()) return false;
      const upper = coalesceFileContent(node, path);
      // Cheap reject: sizes must match before any content is read.
      if (stat.size !== upper.byteLength) return false;
      const flags = this.allowSymlinks
        ? fs.constants.O_RDONLY
        : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
      const fh = await fs.promises.open(canonical, flags);
      let disk: Uint8Array;
      try {
        disk = new Uint8Array(await fh.readFile());
      } finally {
        await fh.close();
      }
      for (let i = 0; i < disk.byteLength; i++) {
        if (disk[i] !== upper[i]) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a virtual directory in memory (sync, for initialization)
   */
  mkdirSync(path: string, _options?: MkdirOptions): void {
    this.tree.ensureDirs(normalizePath(path), (p) => this.lowerChildren(p));
  }

  /**
   * Create a virtual file in memory (sync, for initialization)
   */
  writeFileSync(path: string, content: string | Uint8Array): void {
    const normalized = normalizePath(path);
    this.ensureParentDirs(normalized);
    const buffer =
      content instanceof Uint8Array
        ? content
        : new TextEncoder().encode(content);
    this.tree.attach(normalized, {
      type: "file",
      content: buffer,
      mode: DEFAULT_FILE_MODE,
      mtime: new Date(),
    });
  }

  /**
   * Check if a normalized virtual path is under the mount point.
   * Returns the relative path within the mount point, or null if not under it.
   */
  private getRelativeToMount(normalizedPath: string): string | null {
    if (this.mountPoint === "/") {
      // Mount at root - all paths are relative to mount
      return normalizedPath;
    }

    if (normalizedPath === this.mountPoint) {
      return "/";
    }

    if (normalizedPath.startsWith(`${this.mountPoint}/`)) {
      return normalizedPath.slice(this.mountPoint.length);
    }

    return null;
  }

  /**
   * Convert a virtual path to a real filesystem path.
   * Returns null if the path is not under the mount point or would escape the root.
   */
  private toRealPath(virtualPath: string): string | null {
    const normalized = normalizePath(virtualPath);

    // Check if path is under the mount point
    const relativePath = this.getRelativeToMount(normalized);
    if (relativePath === null) {
      return null;
    }

    const realPath = nodePath.join(this.root, relativePath);

    // Security check: ensure path doesn't escape root
    const resolvedReal = nodePath.resolve(realPath);
    if (!isPathWithinRoot(resolvedReal, this.root)) {
      return null;
    }

    return resolvedReal;
  }

  /**
   * Resolve a real-FS path to its canonical form and validate it stays
   * within the sandbox.  Returns the canonical path for I/O, or null if
   * the path escapes the root or traverses a symlink (when !allowSymlinks).
   *
   * Callers MUST use the returned canonical path for subsequent I/O to
   * close the TOCTOU gap between validation and use.
   */
  private resolveRealPath_(realPath: string | null): string | null {
    if (!realPath) return null;
    if (!this.allowSymlinks) {
      return resolveCanonicalPathNoSymlinks(
        realPath,
        this.root,
        this.canonicalRoot,
      );
    }
    return resolveCanonicalPath(realPath, this.canonicalRoot);
  }

  /**
   * Resolve only the parent directory of a real-FS path, then join with
   * the original basename.  Used by lstat/readlink/existsInOverlay where
   * the final component may itself be a symlink we want to inspect (not
   * follow).  Returns the canonical parent + basename for I/O, or null.
   */
  private resolveRealPathParent_(realPath: string | null): string | null {
    if (!realPath) return null;
    const parent = nodePath.dirname(realPath);
    const canonicalParent = this.resolveRealPath_(parent);
    if (canonicalParent === null) return null;
    return nodePath.join(canonicalParent, nodePath.basename(realPath));
  }

  private sanitizeError(
    e: unknown,
    virtualPath: string,
    operation: string,
  ): never {
    sanitizeFsError(e, virtualPath, operation, OVERLAY_PASSTHROUGH_ERRORS);
  }

  private ensureParentDirs(path: string): void {
    const dir = dirname(path);
    if (dir === "/") return;
    // Creates missing ancestors and resurrects whiteouted ones, marking
    // their deleted lower-layer children with fresh whiteouts.
    this.tree.ensureDirs(dir, (p) => this.lowerChildren(p));
  }

  /**
   * List the lower-layer (real-FS) child names of a directory, for
   * whiteout population during resurrection. Returns null when the path
   * has no readable lower directory — lookups then degrade to individual
   * lower-layer errors rather than leaking.
   */
  private lowerChildren(virtualPath: string): string[] | null {
    const canonical = this.resolveRealPath_(this.toRealPath(virtualPath));
    if (!canonical) return null;
    try {
      return fs.readdirSync(canonical);
    } catch {
      return null;
    }
  }

  /**
   * Check if a path exists in the overlay (tree + real fs - whiteouts)
   */
  private async existsInOverlay(virtualPath: string): Promise<boolean> {
    const normalized = normalizePath(virtualPath);

    const result = this.tree.descend(normalized);
    if (result.kind === "found") {
      return result.node.type !== "whiteout";
    }
    if (result.kind === "blocked" || result.kind === "notdir") {
      // Hidden by a whiteout at or above the path, or unreachable below a
      // non-directory shadow.
      return false;
    }

    // Check real filesystem using lstat to avoid following OS-level symlinks.
    // Using access() or stat() would follow symlinks and could leak existence
    // of files outside the sandbox.
    // Validate only the parent directory since lstat doesn't follow the final component.
    // Use the canonical path for I/O to close the TOCTOU gap.
    const canonical = this.resolveRealPathParent_(this.toRealPath(normalized));
    if (!canonical) {
      return false;
    }

    try {
      await lstatReal(canonical);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    const buffer = await this.readFileBuffer(path);
    const encoding = getEncoding(options);
    return fromBuffer(buffer, encoding);
  }

  async readFileBytes(path: string): Promise<ByteString> {
    const buffer = await this.readFileBuffer(path);
    return unsafeBytesFromLatin1(fromBuffer(buffer, "binary"));
  }

  async readFileBuffer(
    path: string,
    seen: Set<string> = new Set(),
  ): Promise<Uint8Array> {
    validatePath(path, "open");
    const normalized = normalizePath(path);

    // Detect symlink loops
    if (seen.has(normalized)) {
      throw new FsError(
        "ELOOP",
        `too many levels of symbolic links, open '${path}'`,
      );
    }
    seen.add(normalized);

    const result = this.tree.descend(normalized);
    if (result.kind === "blocked") {
      throw new FsError("ENOENT", `no such file or directory, open '${path}'`);
    }
    if (result.kind === "notdir") {
      throw new FsError("ENOTDIR", `not a directory, open '${path}'`);
    }
    if (result.kind === "found") {
      const memEntry = result.node;
      if (memEntry.type === "whiteout") {
        throw new FsError(
          "ENOENT",
          `no such file or directory, open '${path}'`,
        );
      }
      if (memEntry.type === "symlink") {
        const target = this.resolveSymlink(normalized, memEntry.target);
        return this.readFileBuffer(target, seen);
      }
      if (memEntry.type !== "file") {
        throw new FsError(
          "EISDIR",
          `illegal operation on a directory, read '${path}'`,
        );
      }
      if (!memEntry.metacopy) {
        return coalesceFileContent(memEntry, path);
      }
      // Metacopy: data still lives in the lower layer. POSIX serves
      // fall-through reads (metadata is worth the laziness); Windows
      // promotes on first read (metadata is advisory there, so data
      // residency is the only value worth paying for).
      const data = await this.readLowerFileBytes(normalized, path, seen);
      if (process.platform === "win32") {
        try {
          this.tree.attach(normalized, {
            type: "file",
            content: data,
            mode: memEntry.mode,
            mtime: memEntry.mtime,
          });
        } catch (e) {
          // The memory quota (ENOSPC) must not break a read: promotion is
          // an optimization and fall-through stays correct. Anything else
          // is a tree invariant violation — fail loud.
          if (!(e instanceof Error) || !e.message.startsWith("ENOSPC")) {
            throw e;
          }
        }
      }
      return data;
    }

    return this.readLowerFileBytes(normalized, path, seen);
  }

  /**
   * Read a path from the lower layer (real filesystem), following lower
   * symlinks through the virtual layer. Shared by clean-miss reads and
   * metacopy fall-through.
   */
  private async readLowerFileBytes(
    normalized: string,
    path: string,
    seen: Set<string>,
  ): Promise<Uint8Array> {
    // Use the canonical path for I/O to close the TOCTOU gap between
    // validation and use.
    const canonical = this.resolveRealPath_(this.toRealPath(normalized));
    if (!canonical) {
      throw new FsError("ENOENT", `no such file or directory, open '${path}'`);
    }

    try {
      const stat = await lstatReal(canonical);
      if (stat.isSymbolicLink()) {
        if (!this.allowSymlinks) {
          throw new FsError(
            "ENOENT",
            `no such file or directory, open '${path}'`,
          );
        }
        const rawTarget = await fs.promises.readlink(canonical);
        const virtualTarget = this.realTargetToVirtual(rawTarget);
        const resolvedTarget = this.resolveSymlink(normalized, virtualTarget);
        return this.readFileBuffer(resolvedTarget, seen);
      }
      if (stat.isDirectory()) {
        throw new FsError(
          "EISDIR",
          `illegal operation on a directory, read '${path}'`,
        );
      }
      if (this.maxFileReadSize > 0 && stat.size > this.maxFileReadSize) {
        throw new FsError(
          "EFBIG",
          `file too large, read '${path}' (${stat.size} bytes, max ${this.maxFileReadSize})`,
        );
      }
      // Use O_NOFOLLOW (when symlinks disabled) to prevent TOCTOU: if the
      // file at `canonical` is swapped for a symlink between lstat and read,
      // O_NOFOLLOW makes the open fail instead of following the symlink.
      const flags = this.allowSymlinks
        ? fs.constants.O_RDONLY
        : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
      const fh = await fs.promises.open(canonical, flags);
      try {
        const content = await fh.readFile();
        return new Uint8Array(content);
      } finally {
        await fh.close();
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new FsError(
          "ENOENT",
          `no such file or directory, open '${path}'`,
        );
      }
      if (code === "ELOOP") {
        // O_NOFOLLOW caught a symlink swap (TOCTOU defense)
        throw new FsError(
          "ENOENT",
          `no such file or directory, open '${path}'`,
        );
      }
      this.sanitizeError(e, path, "open");
    }
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    validatePath(path, "write");
    this.assertWritable(`write '${path}'`);
    const normalized = normalizePath(path);
    this.ensureParentDirs(normalized);

    const encoding = getEncoding(options);
    const buffer = toBuffer(content, encoding);

    this.tree.attach(normalized, {
      type: "file",
      content: buffer,
      mode: await this.inheritedMode(normalized),
      mtime: new Date(),
    });
  }

  /**
   * Mode for a newly attached file shadow: the current entry's mode when
   * overwriting an upper-layer file, the lower file's mode when shadowing
   * a lower-layer file (POSIX O_TRUNC preserves mode), DEFAULT_FILE_MODE
   * for genuinely new files (including recreate-after-delete).
   *
   * The lower-layer stat is POSIX-only: Windows modes are synthesized
   * (0o666/0o444 from the read-only attribute, exec bits from the file
   * extension) and nothing in the overlay enforces them, so the syscall
   * would buy fiction.
   */
  private async inheritedMode(normalized: string): Promise<number> {
    const existing = this.entryAt(normalized);
    if (existing?.type === "file") {
      return existing.mode;
    }
    if (existing?.type === "directory") {
      return DEFAULT_FILE_MODE; // attach() will reject with EISDIR
    }
    if (process.platform === "win32") {
      return DEFAULT_FILE_MODE;
    }
    try {
      const st = await this.stat(normalized);
      if (st.isFile) return st.mode;
    } catch {
      // New file, or hidden by a whiteout (recreate-after-delete).
    }
    return DEFAULT_FILE_MODE;
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    validatePath(path, "append");
    this.assertWritable(`append '${path}'`);
    const normalized = normalizePath(path);
    const encoding = getEncoding(options);
    const newBuffer = toBuffer(content, encoding);

    const result = this.tree.descend(normalized);
    if (result.kind === "found" && result.node.type === "file") {
      await this.appendToExisting_(normalized, result.node, newBuffer, path);
      return;
    }
    if (result.kind === "blocked") {
      throw new FsError(
        "ENOENT",
        `no such file or directory, append '${path}'`,
      );
    }
    if (result.kind === "notdir") {
      throw new FsError("ENOTDIR", `not a directory, append '${path}'`);
    }

    // Read through for the current content — this resolves symlinks and
    // reads lower-layer content. A whiteout at the exact path surfaces as
    // ENOENT here (recreate-after-delete starts empty), as does a plain
    // missing file (append creates it). Every other read failure (EFBIG
    // on an oversized lower file, ELOOP, EACCES) must propagate: starting
    // from an empty buffer would silently truncate the file, and diff()
    // would report that truncated content for the host to apply to disk.
    let existingBuffer: Uint8Array;
    try {
      existingBuffer = await this.readFileBuffer(normalized);
    } catch (e) {
      if (!isFsErrorCode(e, "ENOENT")) {
        throw e;
      }
      existingBuffer = new Uint8Array(0);
    }

    // Resolve the mode BEFORE the final gate: every remaining await must
    // happen here, because any yield between the re-descend and the
    // attach reopens the race this gate exists to close.
    const mode = await this.inheritedMode(normalized);

    // Re-descend after the async work: a concurrent exec may have
    // created an upper node for this path while our read was in flight.
    // Appending onto it is mandatory — attaching over it would silently
    // drop the other exec's chunk (POSIX O_APPEND must not lose data).
    const raced = this.tree.descend(normalized);
    if (raced.kind === "found" && raced.node.type === "file") {
      await this.appendToExisting_(normalized, raced.node, newBuffer, path);
      return;
    }

    // Sync from here to the attach — atomic with the gate above.
    this.ensureParentDirs(normalized);
    this.tree.attach(normalized, {
      type: "file",
      content: existingBuffer,
      appendChunks: [newBuffer],
      mode,
      mtime: new Date(),
    });
  }

  /** Append to an existing upper file node, completing a metacopy
   * copy-up first when needed (preserving the node's upper mode). */
  private async appendToExisting_(
    normalized: string,
    node: OverlayFileNode,
    newBuffer: Uint8Array,
    originalPath: string,
  ): Promise<void> {
    if (node.metacopy) {
      const base = await this.readLowerFileBytes(
        normalized,
        originalPath,
        new Set(),
      );
      // Re-descend after the copy-up read: a concurrent exec may have
      // completed its own copy-up or appended meanwhile.
      const raced = this.tree.descend(normalized);
      if (
        raced.kind === "found" &&
        raced.node.type === "file" &&
        !raced.node.metacopy
      ) {
        this.tree.appendChunk(raced.node, newBuffer);
        raced.node.mtime = new Date();
        return;
      }
      this.tree.attach(normalized, {
        type: "file",
        content: base,
        appendChunks: [newBuffer],
        mode: node.mode,
        mtime: new Date(),
      });
      return;
    }
    this.tree.appendChunk(node, newBuffer);
    node.mtime = new Date();
  }

  async exists(path: string): Promise<boolean> {
    if (path.includes("\0")) {
      return false;
    }
    return this.existsInOverlay(path);
  }

  async stat(path: string, seen: Set<string> = new Set()): Promise<FsStat> {
    validatePath(path, "stat");
    const normalized = normalizePath(path);

    // Detect symlink loops
    if (seen.has(normalized)) {
      throw new FsError(
        "ELOOP",
        `too many levels of symbolic links, stat '${path}'`,
      );
    }
    seen.add(normalized);

    const result = this.tree.descend(normalized);
    if (result.kind === "blocked") {
      throw new FsError("ENOENT", `no such file or directory, stat '${path}'`);
    }
    if (result.kind === "notdir") {
      throw new FsError("ENOTDIR", `not a directory, stat '${path}'`);
    }
    if (result.kind === "found") {
      const entry = result.node;
      if (entry.type === "whiteout") {
        throw new FsError(
          "ENOENT",
          `no such file or directory, stat '${path}'`,
        );
      }
      // Follow symlinks
      if (entry.type === "symlink") {
        const target = this.resolveSymlink(normalized, entry.target);
        return this.stat(target, seen);
      }
      return this.memoryEntryStat(entry);
    }

    // Fall back to real filesystem.  Use the canonical path for I/O to
    // close the TOCTOU gap between validation and use.
    const canonical = this.resolveRealPath_(this.toRealPath(normalized));
    if (!canonical) {
      throw new FsError("ENOENT", `no such file or directory, stat '${path}'`);
    }

    try {
      // Use lstat to avoid following OS-level symlinks directly.
      // If it's a symlink, resolve through the virtual layer to prevent
      // leaking metadata about files outside the sandbox.
      const lstatResult = await lstatReal(canonical);
      if (lstatResult.isSymbolicLink()) {
        if (!this.allowSymlinks) {
          throw new FsError(
            "ENOENT",
            `no such file or directory, stat '${path}'`,
          );
        }
        const rawTarget = await fs.promises.readlink(canonical);
        const virtualTarget = this.realTargetToVirtual(rawTarget);
        const resolvedTarget = this.resolveSymlink(normalized, virtualTarget);
        return this.stat(resolvedTarget, seen);
      }
      return {
        isFile: lstatResult.isFile(),
        isDirectory: lstatResult.isDirectory(),
        isSymbolicLink: false,
        mode: lstatResult.mode,
        size: lstatResult.size,
        mtime: lstatResult.mtime,
        dev: lstatResult.dev,
        ino: lstatResult.ino,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FsError(
          "ENOENT",
          `no such file or directory, stat '${path}'`,
        );
      }
      this.sanitizeError(e, path, "stat");
    }
  }

  async lstat(path: string): Promise<FsStat> {
    validatePath(path, "lstat");
    const normalized = normalizePath(path);

    const result = this.tree.descend(normalized);
    if (result.kind === "blocked") {
      throw new FsError("ENOENT", `no such file or directory, lstat '${path}'`);
    }
    if (result.kind === "notdir") {
      throw new FsError("ENOTDIR", `not a directory, lstat '${path}'`);
    }
    if (result.kind === "found") {
      const entry = result.node;
      if (entry.type === "whiteout") {
        throw new FsError(
          "ENOENT",
          `no such file or directory, lstat '${path}'`,
        );
      }
      return this.memoryEntryStat(entry);
    }

    // Fall back to real filesystem
    // For lstat, validate only the parent directory (lstat should not follow
    // the final component, so we only need the parent to be within sandbox).
    // Use the canonical path for I/O to close the TOCTOU gap.
    const canonical = this.resolveRealPathParent_(this.toRealPath(normalized));
    if (!canonical) {
      throw new FsError("ENOENT", `no such file or directory, lstat '${path}'`);
    }

    try {
      const stat = await lstatReal(canonical);
      return {
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: stat.isSymbolicLink(),
        mode: stat.mode,
        size: stat.size,
        mtime: stat.mtime,
        dev: stat.dev,
        ino: stat.ino,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FsError(
          "ENOENT",
          `no such file or directory, lstat '${path}'`,
        );
      }
      this.sanitizeError(e, path, "lstat");
    }
  }

  /**
   * Build an FsStat for an upper-layer entry node (lstat semantics:
   * symlinks are reported, not followed).
   */
  private memoryEntryStat(entry: OverlayEntryNode): FsStat {
    if (entry.type === "symlink") {
      return {
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
        mode: entry.mode,
        size: entry.target.length,
        mtime: entry.mtime,
      };
    }

    let size = 0;
    if (entry.type === "file") {
      size = entry.metacopy ? (entry.lowerSize ?? 0) : fileNodeBytes(entry);
    }

    return {
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: false,
      mode: entry.mode,
      size,
      mtime: entry.mtime,
      identity: this.identityFor(entry),
    };
  }

  private resolveSymlink(symlinkPath: string, target: string): string {
    return resolveSymlinkTarget(symlinkPath, target);
  }

  /**
   * Convert a real-fs symlink target to a virtual target suitable for resolveSymlink.
   * Handles absolute real-fs paths that point within the root by converting them
   * to virtual paths relative to the mount point.
   */
  private realTargetToVirtual(rawTarget: string): string {
    const result = sanitizeSymlinkTarget(rawTarget, this.canonicalRoot);

    if (result.withinRoot) {
      if (!nodePath.isAbsolute(rawTarget)) {
        // Relative targets work the same way in both real and virtual fs
        return rawTarget;
      }
      // Target is within root - convert to virtual path under mount point
      const relativePath = result.relativePath;
      if (this.mountPoint === "/") {
        return relativePath;
      }
      return `${this.mountPoint}${relativePath}`;
    }

    // Target is outside root - return sanitized basename
    return result.safeName;
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    validatePath(path, "mkdir");
    this.assertWritable(`mkdir '${path}'`);
    const normalized = normalizePath(path);

    // Check if it exists (in memory or real fs)
    const exists = await this.existsInOverlay(normalized);
    if (exists) {
      if (!options?.recursive) {
        throw new FsError("EEXIST", `file already exists, mkdir '${path}'`);
      }
      return;
    }

    // Check parent exists
    const parent = dirname(normalized);
    if (parent !== "/") {
      const parentExists = await this.existsInOverlay(parent);
      if (!parentExists) {
        if (options?.recursive) {
          await this.mkdir(parent, { recursive: true });
        } else {
          throw new FsError(
            "ENOENT",
            `no such file or directory, mkdir '${path}'`,
          );
        }
      }
    }

    // ensureDirs creates the directory and any (already validated) parent
    // shadows, and resurrects a whiteout at this path with lower-layer
    // whiteouts populated — a plain attach would lose the deletion records.
    this.tree.ensureDirs(normalized, (p) => this.lowerChildren(p));
  }

  /**
   * Core readdir implementation that returns entries with file types.
   * Both readdir and readdirWithFileTypes use this shared implementation.
   */
  private async readdirCore(
    path: string,
    normalized: string,
  ): Promise<Map<string, DirentEntry>> {
    const entriesMap = new Map<string, DirentEntry>();
    const hiddenChildren = new Set<string>();

    const result = this.tree.descend(normalized);
    if (result.kind === "blocked") {
      throw new FsError(
        "ENOENT",
        `no such file or directory, scandir '${path}'`,
      );
    }
    if (result.kind === "notdir") {
      throw new FsError("ENOTDIR", `not a directory, scandir '${path}'`);
    }
    let dirNode: OverlayDirNode | undefined;
    if (result.kind === "found") {
      const node = result.node;
      if (node.type === "whiteout") {
        throw new FsError(
          "ENOENT",
          `no such file or directory, scandir '${path}'`,
        );
      }
      if (node.type !== "directory") {
        throw new FsError("ENOTDIR", `not a directory, scandir '${path}'`);
      }
      dirNode = node;
      // Add entries from the upper layer (with type info); whiteout
      // children hide same-named lower-layer entries below.
      for (const [name, child] of node.children) {
        if (child.type === "whiteout") {
          hiddenChildren.add(name);
          continue;
        }
        entriesMap.set(name, {
          name,
          isFile: child.type === "file",
          isDirectory: child.type === "directory",
          isSymbolicLink: child.type === "symlink",
        });
      }
    }

    // Add entries from real filesystem with file types.
    // Use the canonical path for I/O to close the TOCTOU gap.
    const canonical = this.resolveRealPath_(this.toRealPath(normalized));
    if (canonical) {
      try {
        // Defense-in-depth lstat check: if the directory at `canonical` was
        // replaced with a symlink between resolveRealPath_() and readdir,
        // lstat detects it.  Node.js has no fd-based readdir, so a tiny
        // TOCTOU window remains between this lstat and the readdir below.
        if (!this.allowSymlinks) {
          const dirStat = await lstatReal(canonical);
          if (dirStat.isSymbolicLink()) {
            // Treat as non-existent — don't leak real-FS entries. The
            // error must carry the code: the catch below classifies by
            // .code, and a plain Error would be mislabeled as EIO.
            if (!dirNode) {
              const err = new FsError(
                "ENOENT",
                `no such file or directory, scandir '${path}'`,
              ) as NodeJS.ErrnoException;
              err.code = "ENOENT";
              throw err;
            }
            return entriesMap;
          }
        }
        const realEntries = await fs.promises.readdir(canonical, {
          withFileTypes: true,
        });
        for (const dirent of realEntries) {
          if (
            !hiddenChildren.has(dirent.name) &&
            !entriesMap.has(dirent.name)
          ) {
            entriesMap.set(dirent.name, {
              name: dirent.name,
              isFile: dirent.isFile(),
              isDirectory: dirent.isDirectory(),
              isSymbolicLink: dirent.isSymbolicLink(),
            });
          }
        }
      } catch (e) {
        // If it's ENOENT and we don't have it in memory, throw
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          if (!dirNode) {
            throw new FsError(
              "ENOENT",
              `no such file or directory, scandir '${path}'`,
            );
          }
        } else if ((e as NodeJS.ErrnoException).code !== "ENOTDIR") {
          this.sanitizeError(e, path, "scandir");
        }
      }
    }

    return entriesMap;
  }

  /**
   * Follow symlinks to resolve the final directory path.
   * Returns outsideOverlay: true if the symlink points outside the overlay or
   * the resolved target doesn't exist (security - broken symlinks return []).
   */
  private async resolveForReaddir(
    path: string,
    followedSymlink = false,
  ): Promise<{ normalized: string; outsideOverlay: boolean }> {
    let normalized = normalizePath(path);
    const seen = new Set<string>();
    let didFollowSymlink = followedSymlink;

    // Check the upper layer first, following symlinks
    for (;;) {
      const result = this.tree.descend(normalized);
      if (result.kind !== "found") break;
      const entry = result.node;
      if (entry.type !== "symlink") {
        // Entry or whiteout: virtually present — readdirCore reports
        // ENOENT for whiteouts and ENOTDIR for non-directories.
        return { normalized, outsideOverlay: false };
      }
      if (seen.has(normalized)) {
        throw new FsError(
          "ELOOP",
          `too many levels of symbolic links, scandir '${path}'`,
        );
      }
      seen.add(normalized);
      didFollowSymlink = true;
      normalized = this.resolveSymlink(normalized, entry.target);
    }

    // Check if the resolved path is within the overlay's mount point
    const relativePath = this.getRelativeToMount(normalized);
    if (relativePath === null) {
      // Path is outside the overlay - return indicator for secure handling
      return { normalized, outsideOverlay: true };
    }

    // Check real filesystem.  Use the canonical path for I/O to close the
    // TOCTOU gap between validation and use.
    const canonical = this.resolveRealPath_(this.toRealPath(normalized));
    if (!canonical) {
      // Path doesn't map to real filesystem (security check failed)
      return { normalized, outsideOverlay: true };
    }

    try {
      const stat = await lstatReal(canonical);
      if (stat.isSymbolicLink()) {
        if (!this.allowSymlinks) {
          return { normalized, outsideOverlay: true };
        }
        const rawTarget = await fs.promises.readlink(canonical);
        const virtualTarget = this.realTargetToVirtual(rawTarget);
        const resolvedTarget = this.resolveSymlink(normalized, virtualTarget);
        return this.resolveForReaddir(resolvedTarget, true);
      }
      // Path exists on real filesystem
      return { normalized, outsideOverlay: false };
    } catch {
      // Path doesn't exist on real fs
      if (didFollowSymlink) {
        // Followed a symlink but target doesn't exist - broken symlink, return []
        return { normalized, outsideOverlay: true };
      }
      // No symlink was followed, let readdirCore handle the ENOENT
      return { normalized, outsideOverlay: false };
    }
  }

  async readdir(path: string): Promise<string[]> {
    validatePath(path, "scandir");
    const { normalized, outsideOverlay } = await this.resolveForReaddir(path);
    if (outsideOverlay) {
      // Security: symlink points outside overlay, return empty
      return [];
    }
    const entriesMap = await this.readdirCore(path, normalized);
    // Sort using case-sensitive comparison to match native behavior
    return Array.from(entriesMap.keys()).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    validatePath(path, "scandir");
    const { normalized, outsideOverlay } = await this.resolveForReaddir(path);
    if (outsideOverlay) {
      // Security: symlink points outside overlay, return empty
      return [];
    }
    const entriesMap = await this.readdirCore(path, normalized);
    // Sort using case-sensitive comparison to match native behavior
    return Array.from(entriesMap.values()).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    validatePath(path, "rm");
    this.assertWritable(`rm '${path}'`);
    const normalized = normalizePath(path);

    const exists = await this.existsInOverlay(normalized);
    if (!exists) {
      if (options?.force) return;
      throw new FsError("ENOENT", `no such file or directory, rm '${path}'`);
    }

    // Check if it's a directory
    // Inspect for the not-empty check. A path we cannot inspect (already
    // gone, unreadable lower layer) is treated as deletable and simply
    // gets whiteouted below.
    let nonEmptyDir = false;
    try {
      const stat = await this.stat(normalized);
      if (stat.isDirectory) {
        nonEmptyDir = (await this.readdir(normalized)).length > 0;
      }
    } catch {
      // Uninspectable — proceed to the whiteout.
    }
    if (nonEmptyDir && !options?.recursive) {
      throw new FsError("ENOTEMPTY", `directory not empty, rm '${path}'`);
    }

    // Drop any upper-layer state and, when hiding a real-FS path, leave a
    // whiteout in its place. The tree releases the dropped subtree's byte
    // accounting, and the whiteout hides all lower-layer descendants — no
    // per-child recursion or per-child whiteouts are needed.
    if (this.existsOnRealFs(normalized)) {
      this.tree.putWhiteout(normalized);
    } else {
      this.tree.detach(normalized);
    }
  }

  /**
   * Check (synchronously) whether a path exists on the real filesystem.
   * Used to decide whether a whiteout is needed after deletion.
   */
  private existsOnRealFs(virtualPath: string): boolean {
    const realPath = this.toRealPath(virtualPath);
    const canonical = this.resolveRealPathParent_(realPath);
    if (!canonical) return false;
    try {
      lstatRealSync(canonical);
      return true;
    } catch {
      return false;
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    validatePath(src, "cp");
    validatePath(dest, "cp");
    this.assertWritable(`cp '${dest}'`);
    const srcNorm = normalizePath(src);
    const destNorm = normalizePath(dest);

    const srcExists = await this.existsInOverlay(srcNorm);
    if (!srcExists) {
      throw new FsError("ENOENT", `no such file or directory, cp '${src}'`);
    }

    const srcStat = await this.stat(srcNorm);

    if (srcStat.isFile) {
      const content = await this.readFileBuffer(srcNorm);
      await this.writeFile(destNorm, content);
    } else if (srcStat.isDirectory) {
      if (!options?.recursive) {
        throw new FsError("EISDIR", `is a directory, cp '${src}'`);
      }
      if (isSameOrDescendantPath(srcNorm, destNorm)) {
        throw new FsError(
          "EINVAL",
          `cannot copy '${src}' into itself, '${dest}'`,
        );
      }
      await this.mkdir(destNorm, { recursive: true });
      const children = await this.readdir(srcNorm);
      for (const child of children) {
        const srcChild = srcNorm === "/" ? `/${child}` : `${srcNorm}/${child}`;
        const destChild =
          destNorm === "/" ? `/${child}` : `${destNorm}/${child}`;
        await this.cp(srcChild, destChild, options);
      }
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    this.assertWritable(`mv '${dest}'`);
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  resolvePath(base: string, rel: string): string {
    return resolveVPath(base, rel);
  }

  getAllPaths(): string[] {
    // This is expensive for overlay fs, but we can return what's in the
    // upper layer plus scan the real filesystem. The scan starts at the
    // mount point: paths outside it have no real-FS counterpart (and
    // scanning from "/" would find nothing at all on non-root mounts).
    const paths = new Set<string>();
    for (const { path, node } of this.tree.preOrder()) {
      if (node.type !== "whiteout") {
        paths.add(path);
      }
    }

    // Add paths from real filesystem (this is a sync operation, be careful)
    this.scanRealFs(this.mountPoint, paths);

    return Array.from(paths);
  }

  private scanRealFs(virtualDir: string, paths: Set<string>): void {
    // Skip directories whose lower layer is hidden: a whiteout at or
    // above them, or a non-directory shadow in the way.
    if (this.lowerHidden(virtualDir)) return;

    // Use the canonical path for I/O to close the TOCTOU gap.
    const canonical = this.resolveRealPath_(this.toRealPath(virtualDir));
    if (!canonical) return;

    try {
      const entries = fs.readdirSync(canonical);
      for (const entry of entries) {
        const virtualPath =
          virtualDir === "/" ? `/${entry}` : `${virtualDir}/${entry}`;
        if (this.lowerHidden(virtualPath)) continue;
        paths.add(virtualPath);

        const entryPath = nodePath.join(canonical, entry);
        // Use lstatSync to avoid following OS symlinks that could point
        // outside the sandbox root. Symlinks are listed but not traversed.
        const stat = lstatRealSync(entryPath);
        if (stat.isDirectory()) {
          this.scanRealFs(virtualPath, paths);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * True when the lower layer at `virtualPath` is invisible: a whiteout at
   * or above the path, or a non-directory shadow in the way. Missing paths
   * (clean fall-through) return false.
   */
  private lowerHidden(virtualPath: string): boolean {
    const result = this.tree.descend(virtualPath);
    switch (result.kind) {
      case "blocked":
      case "notdir":
        return true;
      case "found":
        // Whiteouts mark deletions; file/symlink shadows are total.
        return result.node.type !== "directory";
      default:
        return false;
    }
  }

  /** The upper-layer entry at `virtualPath`, or undefined. */
  private entryAt(virtualPath: string): OverlayEntryNode | undefined {
    const result = this.tree.descend(virtualPath);
    if (result.kind === "found" && result.node.type !== "whiteout") {
      return result.node;
    }
    return undefined;
  }

  async chmod(path: string, mode: number): Promise<void> {
    validatePath(path, "chmod");
    this.assertWritable(`chmod '${path}'`);
    const normalized = normalizePath(path);

    const exists = await this.existsInOverlay(normalized);
    if (!exists) {
      throw new FsError("ENOENT", `no such file or directory, chmod '${path}'`);
    }

    // If in the upper layer, update there
    const entry = this.entryAt(normalized);
    if (entry) {
      entry.mode = mode;
      this.tree.touch(entry);
      return;
    }

    // If from real fs, attach a metacopy shadow: metadata moves to the
    // upper layer, data stays lower. chmod changes ctime, not mtime —
    // preserve the lower mtime on file shadows.
    const stat = await this.stat(normalized);
    this.attachMetacopyShadow(
      normalized,
      stat,
      mode,
      stat.isFile ? stat.mtime : new Date(),
    );
  }

  /**
   * Attach a metadata-only shadow for a lower-layer path: metadata moves
   * to the upper layer, data stays lower (copied lazily on first content
   * write for files). Callers pass the mode/mtime the shadow should carry
   * (the operation's argument or the lower stat, depending on which
   * metadata the operation changes).
   */
  private attachMetacopyShadow(
    normalized: string,
    stat: FsStat,
    mode: number,
    mtime: Date,
  ): void {
    this.ensureParentDirs(normalized);
    if (stat.isFile) {
      this.tree.attach(normalized, {
        type: "file",
        content: new Uint8Array(0),
        metacopy: true,
        lowerSize: stat.size,
        mode,
        mtime,
      });
    } else if (stat.isDirectory) {
      this.tree.attach(normalized, {
        type: "directory",
        children: new Map(),
        mode,
        mtime,
      });
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    if (!this.allowSymlinks) {
      throw new FsError(
        "EPERM",
        `operation not permitted, symlink '${linkPath}'`,
      );
    }
    validatePath(linkPath, "symlink");
    this.assertWritable(`symlink '${linkPath}'`);
    const normalized = normalizePath(linkPath);

    const exists = await this.existsInOverlay(normalized);
    if (exists) {
      throw new FsError("EEXIST", `file already exists, symlink '${linkPath}'`);
    }

    this.ensureParentDirs(normalized);
    this.tree.attach(normalized, {
      type: "symlink",
      target,
      mode: SYMLINK_MODE,
      mtime: new Date(),
    });
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    validatePath(existingPath, "link");
    validatePath(newPath, "link");
    this.assertWritable(`link '${newPath}'`);
    const existingNorm = normalizePath(existingPath);
    const newNorm = normalizePath(newPath);

    const existingExists = await this.existsInOverlay(existingNorm);
    if (!existingExists) {
      throw new FsError(
        "ENOENT",
        `no such file or directory, link '${existingPath}'`,
      );
    }

    const existingStat = await this.stat(existingNorm);
    if (!existingStat.isFile) {
      throw new FsError(
        "EPERM",
        `operation not permitted, link '${existingPath}'`,
      );
    }

    const newExists = await this.existsInOverlay(newNorm);
    if (newExists) {
      throw new FsError("EEXIST", `file already exists, link '${newPath}'`);
    }

    // Copy content to new location
    const content = await this.readFileBuffer(existingNorm);
    this.ensureParentDirs(newNorm);
    this.tree.attach(newNorm, {
      type: "file",
      content,
      mode: existingStat.mode,
      mtime: new Date(),
      identity: existingStat.identity ?? `overlay:${this.nextMemoryIdentity++}`,
    });
  }

  async readlink(path: string): Promise<string> {
    validatePath(path, "readlink");
    const normalized = normalizePath(path);

    const result = this.tree.descend(normalized);
    if (result.kind === "blocked") {
      throw new FsError(
        "ENOENT",
        `no such file or directory, readlink '${path}'`,
      );
    }
    if (result.kind === "notdir") {
      throw new FsError("ENOTDIR", `not a directory, readlink '${path}'`);
    }
    if (result.kind === "found") {
      const entry = result.node;
      if (entry.type === "whiteout") {
        throw new FsError(
          "ENOENT",
          `no such file or directory, readlink '${path}'`,
        );
      }
      if (entry.type !== "symlink") {
        throw new FsError("EINVAL", `invalid argument, readlink '${path}'`);
      }
      return entry.target;
    }

    // Fall back to real filesystem
    // For readlink, validate only the parent directory (readlink reads the
    // symlink itself, it doesn't follow it - same pattern as lstat).
    // Use the canonical path for I/O to close the TOCTOU gap.
    const canonical = this.resolveRealPathParent_(this.toRealPath(normalized));
    if (!canonical) {
      throw new FsError(
        "ENOENT",
        `no such file or directory, readlink '${path}'`,
      );
    }

    try {
      const rawTarget = await fs.promises.readlink(canonical);

      // For relative targets, verify the resolved target stays within root.
      // sanitizeSymlinkTarget treats all relative targets as "within root"
      // without resolving them, so a target like "../../../etc/passwd" would
      // be returned as-is, leaking sandbox structure information.
      if (!nodePath.isAbsolute(rawTarget)) {
        const resolvedReal = nodePath.resolve(
          nodePath.dirname(canonical),
          rawTarget,
        );
        let canonicalTarget: string;
        try {
          canonicalTarget = fs.realpathSync(resolvedReal);
        } catch {
          canonicalTarget = resolvedReal;
        }
        if (!isPathWithinRoot(canonicalTarget, this.canonicalRoot)) {
          return nodePath.basename(rawTarget);
        }
      }

      return this.realTargetToVirtual(rawTarget);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FsError(
          "ENOENT",
          `no such file or directory, readlink '${path}'`,
        );
      }
      if ((e as NodeJS.ErrnoException).code === "EINVAL") {
        throw new FsError("EINVAL", `invalid argument, readlink '${path}'`);
      }
      this.sanitizeError(e, path, "readlink");
    }
  }

  /**
   * Resolve all symlinks in a path to get the canonical physical path.
   * This is equivalent to POSIX realpath().
   */
  async realpath(path: string): Promise<string> {
    validatePath(path, "realpath");
    const normalized = normalizePath(path);
    const seen = new Set<string>();

    // Helper to resolve symlinks iteratively. One descent per component
    // answers both questions the tree can answer: hidden-by-whiteout
    // (blocked, or an exact whiteout) and the upper-layer entry.
    const upperEntry = (p: string): OverlayEntryNode | undefined => {
      const d = this.tree.descend(p);
      if (
        d.kind === "blocked" ||
        (d.kind === "found" && d.node.type === "whiteout")
      ) {
        throw new FsError(
          "ENOENT",
          `no such file or directory, realpath '${path}'`,
        );
      }
      return d.kind === "found" ? (d.node as OverlayEntryNode) : undefined;
    };

    const resolveAll = async (p: string): Promise<string> => {
      const parts = p === "/" ? [] : p.slice(1).split("/");
      let resolved = "";

      for (const part of parts) {
        resolved = `${resolved}/${part}`;

        // Check for loops
        if (seen.has(resolved)) {
          throw new FsError(
            "ELOOP",
            `too many levels of symbolic links, realpath '${path}'`,
          );
        }

        // Check the upper layer first (throws ENOENT if whiteout-hidden)
        let entry = upperEntry(resolved);
        let loopCount = 0;
        const maxLoops = MAX_SYMLINK_DEPTH;

        while (entry && entry.type === "symlink" && loopCount < maxLoops) {
          seen.add(resolved);
          resolved = this.resolveSymlink(resolved, entry.target);
          loopCount++;

          if (seen.has(resolved)) {
            throw new FsError(
              "ELOOP",
              `too many levels of symbolic links, realpath '${path}'`,
            );
          }

          entry = upperEntry(resolved);
        }

        if (loopCount >= maxLoops) {
          throw new FsError(
            "ELOOP",
            `too many levels of symbolic links, realpath '${path}'`,
          );
        }

        // If not in memory, check real filesystem.
        // Use canonical paths for I/O to close the TOCTOU gap.
        if (!entry) {
          const realPath = this.toRealPath(resolved);
          const canonical = this.resolveRealPath_(realPath);
          if (canonical) {
            try {
              const stat = await lstatReal(canonical);
              if (stat.isSymbolicLink()) {
                if (!this.allowSymlinks) {
                  throw new FsError(
                    "ENOENT",
                    `no such file or directory, realpath '${path}'`,
                  );
                }
                const rawTarget = await fs.promises.readlink(canonical);
                const virtualTarget = this.realTargetToVirtual(rawTarget);
                seen.add(resolved);
                resolved = this.resolveSymlink(resolved, virtualTarget);

                // Continue resolving from the new path
                // We need to restart from this point to handle nested symlinks
                return resolveAll(resolved);
              }
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "ENOENT") {
                throw new FsError(
                  "ENOENT",
                  `no such file or directory, realpath '${path}'`,
                );
              }
              this.sanitizeError(e, path, "realpath");
            }
          } else if (!this.allowSymlinks) {
            // resolveRealPath_ rejected this path (symlink traversal
            // detected). Use parent validation + lstat to check whether
            // this specific component is a symlink and throw ENOENT.
            const canonicalWithBase = this.resolveRealPathParent_(realPath);
            if (canonicalWithBase) {
              try {
                const stat = await lstatReal(canonicalWithBase);
                if (stat.isSymbolicLink()) {
                  throw new FsError(
                    "ENOENT",
                    `no such file or directory, realpath '${path}'`,
                  );
                }
              } catch (e) {
                if (isFsErrorCode(e, "ENOENT") || isFsErrorCode(e, "ELOOP")) {
                  throw new FsError(
                    "ENOENT",
                    `no such file or directory, realpath '${path}'`,
                  );
                }
                this.sanitizeError(e, path, "realpath");
              }
            }
          }
        }
      }

      return resolved || "/";
    };

    const result = await resolveAll(normalized);

    // Verify the final path exists
    const exists = await this.existsInOverlay(result);
    if (!exists) {
      throw new FsError(
        "ENOENT",
        `no such file or directory, realpath '${path}'`,
      );
    }

    return result;
  }

  /**
   * Set access and modification times of a file
   * @param path - The file path
   * @param _atime - Access time (ignored, kept for API compatibility)
   * @param mtime - Modification time
   */
  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    validatePath(path, "utimes");
    this.assertWritable(`utimes '${path}'`);
    const normalized = normalizePath(path);

    const exists = await this.existsInOverlay(normalized);
    if (!exists) {
      throw new FsError(
        "ENOENT",
        `no such file or directory, utimes '${path}'`,
      );
    }

    // If in the upper layer, update there
    const entry = this.entryAt(normalized);
    if (entry) {
      entry.mtime = mtime;
      this.tree.touch(entry);
      return;
    }

    // If from real fs, attach a metacopy shadow: metadata moves up,
    // data stays lower until the first content write.
    const stat = await this.stat(normalized);
    this.attachMetacopyShadow(normalized, stat, stat.mode, mtime);
  }
}
