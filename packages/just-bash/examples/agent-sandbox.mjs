/**
 * Agent sandbox integration example: sandboxed bash over real directories
 * with host-reviewed change sets — via the createAgentSandbox entry point.
 *
 * The sandbox never writes to disk by itself. Agents run scripts against
 * copy-on-write overlays of the real home and project directories; the
 * host reviews the combined change set (real paths) and applies what it
 * accepts. applyChanges applies and reconciles in one call.
 *
 * Run in-repo (after `pnpm build`):
 *   node examples/agent-sandbox.mjs
 *
 * In your own project, import from the package instead:
 *   import { createAgentSandbox } from "just-bash";
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSandbox } from "../dist/bundle/index.js";

// --- Stand-in "user machine": a home dir and an unrelated project dir.
const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-home-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-project-"));
fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
fs.writeFileSync(path.join(projectDir, "src/app.ts"), "export {}\n");
fs.writeFileSync(path.join(projectDir, "README.md"), "# project\n");

const sandbox = createAgentSandbox({
  home: homeDir, // real dir -> virtual /home/user, copy-on-write
  project: projectDir, // real dir -> virtual /project, copy-on-write
  abortOnUnresolvedCommands: true,
});

// --- Per-turn loop: analyze -> exec -> diff -> apply.
const script =
  "echo '// edited' >> src/app.ts && rm README.md && echo done > NOTES.txt";

// 1. Static pre-flight: learn what the sandbox can't run, without running.
const analysis = await sandbox.analyzeCommands(script);
if (analysis.unresolved.length > 0) {
  console.log("would prompt/host-run for:", analysis.unresolved);
}

// 2. Execute in the sandbox. Writes land in memory, never on disk.
const result = await sandbox.exec(script);
console.log("exit:", result.exitCode, "misses:", result.unresolvedCommands);

// 3. Review the exact change set (real absolute paths).
const changes = sandbox.diff();
console.log(
  "changes:",
  changes.writes.map((w) => `write ${w.path}`),
  changes.deletions.map((d) => `delete ${d}`),
);

// 4. Apply on the host. Applied changes drop out of the pending set
//    automatically; anything omitted from the passed set stays pending.
await sandbox.applyChanges(changes);
console.log("after apply, pending:", sandbox.diff());

console.log(
  "real project now:",
  fs.readdirSync(projectDir).sort(),
  "| app.ts:",
  JSON.stringify(fs.readFileSync(path.join(projectDir, "src/app.ts"), "utf8")),
);

fs.rmSync(homeDir, { recursive: true, force: true });
fs.rmSync(projectDir, { recursive: true, force: true });
