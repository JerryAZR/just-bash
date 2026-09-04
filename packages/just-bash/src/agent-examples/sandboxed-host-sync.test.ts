import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import { MountableFs } from "../fs/mountable-fs/mountable-fs.js";
import { type OverlayDiff, OverlayFs } from "../fs/overlay-fs/index.js";

/**
 * Agent Sandbox Scenario: sandboxed execution with host-applied change sets
 *
 * The intended harness topology, end to end: an InMemoryFs virtual root,
 * OverlayFs over the user's real home directory (plus a second overlay for
 * the project directory when it lives outside home), and a per-turn loop of
 * analyze -> exec -> diff -> apply-on-host -> sync. The sandbox never writes
 * to disk; the host reviews and applies each change set.
 *
 * Note the two mountPoint layers: MountableFs strips its mount prefix
 * before delegating, so each OverlayFs uses mountPoint "/" (its own root
 * is the real directory), while MountableFs places it at the virtual path.
 */

/** Host-side application of a change set to a real directory. */
function applyDiff(root: string, diff: OverlayDiff): void {
  for (const rel of diff.deletions) {
    fs.rmSync(path.join(root, rel), { recursive: true, force: true });
  }
  for (const write of diff.writes) {
    const target = path.join(root, write.path);
    if (write.nodeType === "directory") {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!write.metadataOnly) {
      fs.writeFileSync(target, write.content);
    }
    if (process.platform !== "win32") {
      fs.chmodSync(target, write.mode);
    }
  }
}

describe("Agent Scenario: Sandboxed Host Sync", () => {
  let homeDir: string;
  let projectDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-home-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-project-"));
    fs.mkdirSync(path.join(homeDir, ".config"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".zshrc"), "# shell config\n");
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "src/app.ts"), "export {}\n");
    fs.writeFileSync(path.join(projectDir, "README.md"), "# project\n");
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("runs the full per-turn loop: analyze, exec, diff, apply, sync", async () => {
    const homeOverlay = new OverlayFs({ root: homeDir, mountPoint: "/" });
    const projectOverlay = new OverlayFs({
      root: projectDir,
      mountPoint: "/",
    });
    const vfs = new MountableFs({
      base: new InMemoryFs(),
      mounts: [
        { mountPoint: "/home/user", filesystem: homeOverlay },
        { mountPoint: "/project", filesystem: projectOverlay },
      ],
    });
    const bash = new Bash({
      fs: vfs,
      cwd: "/project",
      abortOnUnresolvedCommands: true,
    });

    // --- Turn 1: pre-flight passes, agent edits the project.
    const script =
      "echo '// edited' >> src/app.ts && rm README.md && echo done > NOTES.txt";
    const analysis = await bash.analyzeCommands(script);
    expect(analysis.unresolved).toEqual([]);

    const result = await bash.exec(script);
    expect(result.exitCode).toBe(0);
    expect(result.unresolvedCommands).toEqual([]);

    // The sandbox never touched disk.
    expect(fs.readFileSync(path.join(projectDir, "src/app.ts"), "utf8")).toBe(
      "export {}\n",
    );
    expect(fs.existsSync(path.join(projectDir, "NOTES.txt"))).toBe(false);

    // Host reviews the change set, applies it, and syncs. The "/src"
    // directory write is the shadow of an ensured parent directory —
    // harmless to apply (mkdir -p) and dropped by sync as matching disk.
    const diff = projectOverlay.diff();
    expect(diff.writes.map((w) => w.path)).toEqual([
      "/NOTES.txt",
      "/src",
      "/src/app.ts",
    ]);
    expect(diff.deletions).toEqual(["/README.md"]);
    applyDiff(projectDir, diff);
    await projectOverlay.sync();

    expect(projectOverlay.diff()).toEqual({ writes: [], deletions: [] });
    expect(fs.readFileSync(path.join(projectDir, "src/app.ts"), "utf8")).toBe(
      "export {}\n// edited\n",
    );
    expect(fs.existsSync(path.join(projectDir, "README.md"))).toBe(false);
    expect(fs.readFileSync(path.join(projectDir, "NOTES.txt"), "utf8")).toBe(
      "done\n",
    );
    // Home overlay was untouched by all of this.
    expect(homeOverlay.diff()).toEqual({ writes: [], deletions: [] });

    // --- Turn 2: agent writes outside the project; host rejects it.
    await bash.exec("echo token=secret > /home/user/.config/credentials");
    const pending = homeOverlay.diff();
    expect(pending.writes.map((w) => w.path)).toEqual([
      "/.config",
      "/.config/credentials",
    ]);
    // Host does not apply the write; sync keeps it pending...
    await homeOverlay.sync();
    expect(homeOverlay.diff().writes.map((w) => w.path)).toEqual([
      "/.config",
      "/.config/credentials",
    ]);
    // ...until the host discards it explicitly.
    homeOverlay.reset();
    expect(homeOverlay.diff()).toEqual({ writes: [], deletions: [] });
    expect(fs.existsSync(path.join(homeDir, ".config/credentials"))).toBe(
      false,
    );
  });

  it("gates unsupported commands: static analysis, then the runtime backstop", async () => {
    const projectOverlay = new OverlayFs({
      root: projectDir,
      mountPoint: "/",
    });
    const bash = new Bash({
      fs: new MountableFs({
        base: new InMemoryFs(),
        mounts: [{ mountPoint: "/project", filesystem: projectOverlay }],
      }),
      cwd: "/project",
      abortOnUnresolvedCommands: true,
    });

    // Pre-flight: the harness learns ffmpeg is unavailable without running
    // anything, and can decide to prompt or run natively instead.
    const analysis = await bash.analyzeCommands(
      "ffmpeg -i in.mp4 out.gif && echo converted",
    );
    expect(analysis.unresolved).toEqual(["ffmpeg"]);

    // Run anyway: the abort is the fail-fast backstop. Output so far is
    // preserved, the &&-chain does not continue, and the miss is reported
    // exactly once even though analysis already knew.
    const result = await bash.exec("echo start; ffmpeg x; echo end");
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("start\n");
    expect(result.unresolvedCommands).toEqual(["ffmpeg"]);
    // Nothing reached the change set.
    expect(projectOverlay.diff()).toEqual({ writes: [], deletions: [] });
  });
});
