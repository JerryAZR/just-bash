import * as nodePath from "node:path";
import { Bash, type BashOptions } from "./Bash.js";
import { InMemoryFs } from "./fs/in-memory-fs/index.js";
import { MountableFs } from "./fs/mountable-fs/mountable-fs.js";
import {
  applyWriteToRealFs,
  canonicalizeRealPath,
  removeFromRealFs,
} from "./fs/overlay-fs/apply.js";
import type { OverlayWrite } from "./fs/overlay-fs/index.js";
import { OverlayFs } from "./fs/overlay-fs/index.js";
import type { BashExecResult, CommandAnalysis } from "./types.js";

/**
 * Options for {@link createAgentSandbox}. All BashOptions except `fs` and
 * `cwd` are passed through unchanged.
 */
export interface AgentSandboxOptions
  extends Omit<BashOptions, "fs" | "cwd" | "files"> {
  /**
   * Real directory exposed as the agent's home (virtual `/home/user`),
   * copy-on-write. When omitted, home is plain throwaway memory.
   */
  home?: string;
  /**
   * Real project directory. When inside `home` it is covered by the home
   * overlay (cwd maps to the virtual subpath); otherwise it gets its own
   * overlay mounted at virtual `/project`. When omitted, cwd defaults to
   * `/home/user`.
   */
  project?: string;
  /** Virtual working directory. Defaults to the project mount or home. */
  cwd?: string;
}

/** A single write in a sandbox change set, addressed by real host path. */
export interface SandboxWrite extends Omit<OverlayWrite, "path"> {
  /** Real absolute path on the host, ready for the host to apply. */
  path: string;
}

/** The combined pending change set across all of the sandbox's overlays. */
export interface SandboxChangeSet {
  /** Pending writes, sorted by real path. */
  writes: SandboxWrite[];
  /** Pending deletions (top-most only), as real absolute paths, sorted. */
  deletions: string[];
}

/**
 * A ready-made agent sandbox: InMemoryFs virtual root, copy-on-write
 * OverlayFs over the real home directory (and over the project directory
 * when it lives outside home), and a per-turn change-set workflow with
 * real-absolute paths:
 *
 * ```ts
 * const sandbox = createAgentSandbox({
 *   home: os.homedir(),
 *   project: projectDir,
 *   abortOnUnresolvedCommands: true,
 * });
 * await sandbox.analyzeCommands(script);   // static pre-flight
 * const result = await sandbox.exec(script); // sandboxed; writes in memory
 * const changes = sandbox.diff();            // real paths, reviewable
 * await sandbox.applyChanges(changes);       // host applies + drops applied
 * ```
 *
 * The sandbox never writes to the underlying directories by itself.
 * `applyChanges` is the only disk-writing operation, and it is always an
 * explicit host call. See docs/recipes/agent-sandbox-integration.md,
 * including the out-of-band modification policy.
 */
export class AgentSandbox {
  /** The underlying Bash instance (escape hatch for advanced use). */
  readonly bash: Bash;
  /** The overlays backing this sandbox, keyed by virtual mount point. */
  readonly overlays: ReadonlyMap<string, { root: string; fs: OverlayFs }>;

  constructor(options: AgentSandboxOptions = {}) {
    const { home, project, cwd, env, ...bashOptions } = options;
    const overlays = new Map<string, { root: string; fs: OverlayFs }>();
    const mounts: { mountPoint: string; filesystem: OverlayFs }[] = [];

    const realHome = home ? canonicalizeRealPath(home) : null;
    const realProject = project ? canonicalizeRealPath(project) : null;
    const projectInsideHome =
      realHome &&
      realProject &&
      (() => {
        const rel = nodePath.relative(realHome, realProject);
        // Cross-drive on Windows yields an absolute relative path.
        return (
          rel !== ".." &&
          !rel.startsWith(`..${nodePath.sep}`) &&
          !nodePath.isAbsolute(rel)
        );
      })();

    if (realHome) {
      const overlay = new OverlayFs({ root: realHome, mountPoint: "/" });
      overlays.set("/home/user", { root: realHome, fs: overlay });
      mounts.push({ mountPoint: "/home/user", filesystem: overlay });
    }
    let defaultCwd = "/home/user";
    if (realProject) {
      if (projectInsideHome && realHome) {
        const rel = nodePath.relative(realHome, realProject);
        defaultCwd = rel
          ? `/home/user/${rel.split(nodePath.sep).join("/")}`
          : "/home/user";
      } else {
        const overlay = new OverlayFs({ root: realProject, mountPoint: "/" });
        overlays.set("/project", { root: realProject, fs: overlay });
        mounts.push({ mountPoint: "/project", filesystem: overlay });
        defaultCwd = "/project";
      }
    }

    const vfs = new MountableFs({ base: new InMemoryFs(), mounts });
    this.overlays = overlays;
    this.bash = new Bash({
      ...bashOptions,
      env: { HOME: "/home/user", ...env },
      cwd: cwd ?? defaultCwd,
      fs: vfs,
    });
  }

  /** Statically analyze a script's command usage (see Bash.analyzeCommands). */
  analyzeCommands(script: string): Promise<CommandAnalysis> {
    return this.bash.analyzeCommands(script);
  }

  /** Execute a script in the sandbox. Writes stay in memory. */
  exec(script: string): Promise<BashExecResult> {
    return this.bash.exec(script);
  }

  /**
   * The combined pending change set across all overlays, with real
   * absolute host paths (each overlay's root-relative paths joined onto
   * its real root). Sorted by path for deterministic review.
   */
  diff(): SandboxChangeSet {
    const writes: SandboxWrite[] = [];
    const deletions: string[] = [];
    for (const { root, fs: overlay } of this.overlays.values()) {
      const diff = overlay.diff();
      for (const { path: rel, ...write } of diff.writes) {
        writes.push({ ...write, path: nodePath.join(root, rel) });
      }
      for (const rel of diff.deletions) {
        deletions.push(nodePath.join(root, rel));
      }
    }
    writes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    deletions.sort();
    return { writes, deletions };
  }

  /**
   * Apply a change set to the real directories, dropping each applied
   * entry from the pending set as it goes — no separate sync step in the
   * per-turn loop.
   *
   * Pass a filtered subset to reject changes — anything not applied stays
   * pending (review again or discard with reset()). Fails hard on the
   * first apply error: entries applied so far are dropped (their work is
   * done), the rest stay pending, and a retry is safe.
   */
  async applyChanges(changes: SandboxChangeSet = this.diff()): Promise<void> {
    const applied = new Map<OverlayFs, string[]>();
    const record = (realPath: string) => {
      const found = this.findOverlay(realPath);
      if (!found) return;
      const rel = `/${nodePath
        .relative(found.root, realPath)
        .split(nodePath.sep)
        .join("/")}`;
      const list = applied.get(found.fs);
      if (list) list.push(rel);
      else applied.set(found.fs, [rel]);
    };
    try {
      for (const target of changes.deletions) {
        removeFromRealFs(target);
        record(target);
      }
      for (const write of changes.writes) {
        applyWriteToRealFs(write.path, write);
        record(write.path);
      }
    } finally {
      // Drop whatever was applied (all of it on success, the successful
      // prefix on failure) — work done is work done.
      for (const [overlay, relPaths] of applied) {
        overlay.drop(relPaths);
      }
    }
  }

  /** Longest-prefix match of a real path onto a mounted overlay. */
  private findOverlay(
    realPath: string,
  ): { root: string; fs: OverlayFs } | null {
    let best: { root: string; fs: OverlayFs } | null = null;
    for (const entry of this.overlays.values()) {
      if (
        realPath === entry.root ||
        realPath.startsWith(entry.root + nodePath.sep)
      ) {
        if (!best || entry.root.length > best.root.length) best = entry;
      }
    }
    return best;
  }

  /**
   * Reconcile all overlays with disk: drop pending entries that now match,
   * keep the rest. Also the supported re-baseline after intentional
   * out-of-band changes to the underlying directories.
   */
  async sync(): Promise<void> {
    for (const { fs: overlay } of this.overlays.values()) {
      await overlay.sync();
    }
  }

  /** Discard all pending changes in every overlay (trust-disk re-baseline). */
  reset(): void {
    for (const { fs: overlay } of this.overlays.values()) {
      overlay.reset();
    }
  }
}

/**
 * Create a ready-made agent sandbox. See {@link AgentSandbox}.
 */
export function createAgentSandbox(
  options: AgentSandboxOptions = {},
): AgentSandbox {
  return new AgentSandbox(options);
}
