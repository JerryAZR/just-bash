import * as fs from "node:fs";
import * as nodePath from "node:path";
import { FsError } from "../fs-error.js";
import type { OverlayWrite } from "./overlay-fs.js";

/**
 * Host-side application of overlay change sets to the real filesystem.
 *
 * This is the privileged step of the agent-sandbox flow: the sandbox
 * never writes to disk by itself, and applying a reviewed change set is
 * always an explicit host decision. Keeping the raw disk access here —
 * inside the reviewed filesystem area, next to the implementations it
 * mirrors — is what the banned-pattern lint's raw-fs restriction is for.
 */

/** Canonicalize a real directory path (resolves symlinks and casing). */
export function canonicalizeRealPath(path: string): string {
  return fs.realpathSync(path);
}

/** Remove a real path (recursive, force) — applying a change-set deletion. */
export function removeFromRealFs(path: string): void {
  fs.rmSync(path, { recursive: true, force: true });
}

/**
 * Does `path` exist on disk with a type other than the one the
 * change-set wants? Symlinks count as their own type: lstat never
 * follows them, so a symlink where a file/dir is wanted (or vice
 * versa) is a conflict.
 */
function typeConflict_(path: string, wantDirectory: boolean): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(path);
  } catch {
    return false; // ENOENT: nothing to conflict with
  }
  return wantDirectory ? !st.isDirectory() : st.isDirectory();
}

/**
 * A change-set REPLACES whatever was at the path: a fork that did
 * `rm -rf d && write file d` produces a diff carrying only the write
 * (the whiteout is absorbed), and applying it to a base that still has
 * the directory must remove the directory first — not die mid-apply
 * with EISDIR after earlier entries already landed.
 */
function replaceTypeConflict_(path: string, wantDirectory: boolean): void {
  if (typeConflict_(path, wantDirectory)) {
    fs.rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Apply one change-set write to a real path. Directories are mkdir -p;
 * symlinks are recreated with the recorded target; files get the recorded
 * content (unless metadataOnly — a chmod/utimes copy-up), the recorded
 * mode (POSIX only — mode bits are advisory on Windows), and the recorded
 * mtime restored after the content write. A type-conflicting on-disk
 * target is replaced (the change-set supersedes the base).
 */
export function applyWriteToRealFs(
  path: string,
  write: Omit<OverlayWrite, "path">,
): void {
  if (write.nodeType === "directory") {
    replaceTypeConflict_(path, true);
    fs.mkdirSync(path, { recursive: true });
    // Directories carry mode/mtime too (a chmod 700 dir in the sandbox
    // must not vanish at apply). Mode bits are advisory on Windows.
    if (process.platform !== "win32") {
      fs.chmodSync(path, write.mode);
    }
    fs.utimesSync(path, write.mtime, write.mtime);
    return;
  }
  fs.mkdirSync(nodePath.dirname(path), { recursive: true });
  if (write.nodeType === "symlink") {
    fs.rmSync(path, { force: true, recursive: true });
    fs.symlinkSync(new TextDecoder().decode(write.content), path);
    return;
  }
  if (write.metadataOnly && typeConflict_(path, false)) {
    // No content to materialize and the on-disk type diverged from the
    // copy-up lineage — conflicting input, fail loudly.
    throw new FsError(
      "EINVAL",
      `metadata-only entry over a different on-disk type: '${path}'`,
    );
  }
  if (!write.metadataOnly) {
    replaceTypeConflict_(path, false);
    fs.writeFileSync(path, write.content);
  }
  // Mode bits are advisory on Windows; apply them on POSIX only.
  if (process.platform !== "win32") {
    fs.chmodSync(path, write.mode);
  }
  fs.utimesSync(path, write.mtime, write.mtime);
}

/**
 * Apply a change set with real absolute paths to the real filesystem:
 * deletions first (deepest path first, so subtrees go before their
 * parents), then writes (shallowest first, so explicit directory
 * entries land before their children). Standalone counterpart of
 * AgentSandbox.applyChanges for the fork model — no overlay instance
 * is involved and nothing is dropped; the caller owns the overlays'
 * lifecycle (typically: discard after diff()).
 */
export function applyDiffToRealFs(diff: {
  writes: OverlayWrite[];
  deletions: string[];
}): void {
  // Reject non-normalized input: "..", ".", or duplicate separators
  // would silently escape the caller's intent (e.g. "/root/../x"
  // passes every naive prefix check).
  for (const p of [...diff.deletions, ...diff.writes.map((w) => w.path)]) {
    if (nodePath.resolve(p) !== p) {
      throw new FsError("EINVAL", `change-set path is not normalized: '${p}'`);
    }
  }
  const deletions = [...diff.deletions].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const target of deletions) removeFromRealFs(target);
  const writes = [...diff.writes].sort(
    (a, b) =>
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  for (const { path, ...write } of writes) applyWriteToRealFs(path, write);
}
