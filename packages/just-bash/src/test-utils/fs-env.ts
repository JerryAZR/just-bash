/**
 * Test-environment capability probes.
 *
 * Some tests depend on host capabilities that are not available on every
 * machine — e.g. creating real symlinks requires elevation or Developer Mode
 * on win32, and tar's xz/zstd codecs need optional native modules that ship
 * no win32 prebuilds. Probing once per process lets a test express an honest
 * skip (`it.skipIf(!canCreateSymlinks())`) instead of failing noisily on a
 * machine that can never satisfy the precondition.
 *
 * Only genuinely environmental preconditions belong here. A probe must never
 * be used to hide a behavioral failure.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

let symlinkSupport: boolean | undefined;

/**
 * Whether this process can create real filesystem symlinks.
 * Probed once in a fresh temp dir and cached.
 */
export function canCreateSymlinks(): boolean {
  if (symlinkSupport === undefined) {
    try {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "just-bash-symlink-probe-"),
      );
      try {
        fs.symlinkSync(path.join(dir, "target.txt"), path.join(dir, "link"));
        symlinkSupport = true;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // EPERM on unprivileged win32; EACCES/EROFS on locked-down hosts;
      // ENOENT/EACCES from a broken TMPDIR. Any probe failure is an
      // honest "no", never a collection-time crash.
      symlinkSupport = false;
    }
  }
  return symlinkSupport;
}

function nativeModuleLoads(name: string): boolean {
  try {
    createRequire(import.meta.url)(name);
    return true;
  } catch {
    return false;
  }
}

let xzSupport: boolean | undefined;

/**
 * Whether tar's xz codec (the optional node-liblzma native module) is
 * loadable in this environment.
 */
export function canUseXzCompression(): boolean {
  xzSupport ??= nativeModuleLoads("node-liblzma");
  return xzSupport;
}

let zstdSupport: boolean | undefined;

/**
 * Whether tar's zstd codec (the optional @mongodb-js/zstd native module) is
 * loadable in this environment.
 */
export function canUseZstdCompression(): boolean {
  zstdSupport ??= nativeModuleLoads("@mongodb-js/zstd");
  return zstdSupport;
}
