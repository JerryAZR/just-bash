/**
 * Agent sandbox integration example: sandboxed bash over real directories
 * with host-reviewed change sets.
 *
 * Topology: an InMemoryFs virtual root, an OverlayFs over the user's real
 * home directory, and a second OverlayFs for the project directory when it
 * lives outside home. Agents run scripts in the sandbox (writes stay in
 * memory); the host reviews each overlay's diff() and applies what it
 * accepts; sync() then drops applied changes, leaving only still-pending
 * ones.
 *
 * Run in-repo (after `pnpm build`):
 *   node examples/agent-sandbox.mjs
 *
 * In your own project, import from the package instead:
 *   import { Bash, InMemoryFs, MountableFs, OverlayFs } from "just-bash";
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Bash,
  InMemoryFs,
  MountableFs,
  OverlayFs,
} from "../dist/bundle/index.js";

/** Host-side application of a change set to a real directory. */
function applyDiff(root, diff) {
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
    // Mode bits are advisory on Windows; apply them on POSIX.
    if (process.platform !== "win32") {
      fs.chmodSync(target, write.mode);
    }
  }
}

// --- Stand-in "user machine": a home dir and an unrelated project dir.
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-home-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-project-"));
fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
fs.writeFileSync(path.join(projectDir, "src/app.ts"), "export {}\n");
fs.writeFileSync(path.join(projectDir, "README.md"), "# project\n");

// MountableFs strips its mount prefix before delegating, so each overlay's
// own mountPoint is "/" — its root is the real directory.
const homeOverlay = new OverlayFs({ root: homeDir, mountPoint: "/" });
const projectOverlay = new OverlayFs({ root: projectDir, mountPoint: "/" });
const vfs = new MountableFs({
  base: new InMemoryFs(),
  mounts: [
    { mountPoint: "/home/user", filesystem: homeOverlay },
    { mountPoint: "/project", filesystem: projectOverlay },
  ],
});

// abortOnUnresolvedCommands: fail fast on the first command the sandbox
// can't resolve instead of plowing through a broken script.
const bash = new Bash({
  fs: vfs,
  cwd: "/project",
  abortOnUnresolvedCommands: true,
});

// --- Per-turn loop: analyze -> exec -> diff -> apply -> sync.
const script =
  "echo '// edited' >> src/app.ts && rm README.md && echo done > NOTES.txt";

// 1. Static pre-flight: learn what the sandbox can't run, without running.
const analysis = await bash.analyzeCommands(script);
if (analysis.unresolved.length > 0) {
  console.log("would prompt/host-run for:", analysis.unresolved);
}

// 2. Execute in the sandbox. Writes land in memory, never on disk.
const result = await bash.exec(script);
console.log("exit:", result.exitCode, "misses:", result.unresolvedCommands);

// 3. Review the exact change set.
const diff = projectOverlay.diff();
console.log(
  "changes:",
  diff.writes.map((w) => `write ${w.path}`),
  diff.deletions.map((d) => `delete ${d}`),
);

// 4. Apply it on the host, then 5. sync so applied changes drop out of the
// pending set (anything the host skipped stays pending for review/reset).
applyDiff(projectDir, diff);
await projectOverlay.sync();
console.log("after sync, pending:", projectOverlay.diff());

console.log(
  "real project now:",
  fs.readdirSync(projectDir).sort(),
  "| app.ts:",
  JSON.stringify(fs.readFileSync(path.join(projectDir, "src/app.ts"), "utf8")),
);

fs.rmSync(homeDir, { recursive: true, force: true });
fs.rmSync(projectDir, { recursive: true, force: true });
