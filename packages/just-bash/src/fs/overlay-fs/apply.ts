import * as fs from "node:fs";
import * as nodePath from "node:path";
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
 * Apply one change-set write to a real path. Directories are mkdir -p;
 * symlinks are recreated with the recorded target; files get the recorded
 * content (unless metadataOnly — a chmod/utimes copy-up), the recorded
 * mode (POSIX only — mode bits are advisory on Windows), and the recorded
 * mtime restored after the content write.
 */
export function applyWriteToRealFs(
  path: string,
  write: Omit<OverlayWrite, "path">,
): void {
  if (write.nodeType === "directory") {
    fs.mkdirSync(path, { recursive: true });
    return;
  }
  fs.mkdirSync(nodePath.dirname(path), { recursive: true });
  if (write.nodeType === "symlink") {
    fs.rmSync(path, { force: true });
    fs.symlinkSync(new TextDecoder().decode(write.content), path);
    return;
  }
  if (!write.metadataOnly) {
    fs.writeFileSync(path, write.content);
  }
  // Mode bits are advisory on Windows; apply them on POSIX only.
  if (process.platform !== "win32") {
    fs.chmodSync(path, write.mode);
  }
  fs.utimesSync(path, write.mtime, write.mtime);
}
