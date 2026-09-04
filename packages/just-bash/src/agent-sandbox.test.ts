import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSandbox } from "./agent-sandbox.js";

describe("createAgentSandbox", () => {
  let homeDir: string;
  let projectDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-home-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-project-"));
    fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "src/app.ts"), "export {}\n");
    fs.writeFileSync(path.join(projectDir, "README.md"), "# project\n");
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("runs the per-turn loop with real paths and no manual sync", async () => {
    const sandbox = createAgentSandbox({
      home: homeDir,
      project: projectDir,
      abortOnUnresolvedCommands: true,
    });

    const analysis = await sandbox.analyzeCommands("npm run build");
    expect(analysis.unresolved).toEqual(["npm"]);

    const result = await sandbox.exec(
      "echo '// v2' >> src/app.ts && rm README.md && echo done > NOTES.txt",
    );
    expect(result.exitCode).toBe(0);
    // Nothing touched disk.
    expect(fs.existsSync(path.join(projectDir, "NOTES.txt"))).toBe(false);

    const changes = sandbox.diff();
    expect(changes.writes.map((w) => w.path)).toEqual([
      path.join(projectDir, "NOTES.txt"),
      path.join(projectDir, "src"),
      path.join(projectDir, "src/app.ts"),
    ]);
    expect(changes.deletions).toEqual([path.join(projectDir, "README.md")]);

    await sandbox.applyChanges(changes);
    expect(sandbox.diff()).toEqual({ writes: [], deletions: [] });
    expect(fs.readFileSync(path.join(projectDir, "src/app.ts"), "utf8")).toBe(
      "export {}\n// v2\n",
    );
    expect(fs.existsSync(path.join(projectDir, "README.md"))).toBe(false);
  });

  it("rejected changes stay pending after applyChanges(subset)", async () => {
    const sandbox = createAgentSandbox({ project: projectDir });
    await sandbox.exec("echo a > keep.txt; echo b > reject.txt");
    const all = sandbox.diff();
    const accepted = {
      writes: all.writes.filter((w) => !w.path.endsWith("reject.txt")),
      deletions: [],
    };
    await sandbox.applyChanges(accepted);

    expect(fs.existsSync(path.join(projectDir, "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "reject.txt"))).toBe(false);
    const pending = sandbox.diff();
    expect(pending.writes.map((w) => path.basename(w.path))).toEqual([
      "reject.txt",
    ]);
    sandbox.reset();
    expect(sandbox.diff()).toEqual({ writes: [], deletions: [] });
  });

  it("covers a project inside home with a single overlay", async () => {
    const inner = path.join(homeDir, "work");
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, "notes.txt"), "n");
    const sandbox = createAgentSandbox({ home: homeDir, project: inner });
    expect(sandbox.overlays.size).toBe(1);

    await sandbox.exec("echo more >> notes.txt");
    // The dir write is ensured-parent scaffolding (drops on sync).
    expect(sandbox.diff().writes.map((w) => w.path)).toEqual([
      inner,
      path.join(inner, "notes.txt"),
    ]);
  });

  it("sets HOME and defaults cwd to the project mount", async () => {
    const sandbox = createAgentSandbox({
      home: homeDir,
      project: projectDir,
    });
    const result = await sandbox.exec("pwd; echo $HOME");
    expect(result.stdout).toBe(`/project\n/home/user\n`);
  });

  it("aborts on unresolved commands when the option is passed through", async () => {
    const sandbox = createAgentSandbox({
      project: projectDir,
      abortOnUnresolvedCommands: true,
    });
    const result = await sandbox.exec("echo start; nosuchcmd; echo end");
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("start\n");
    expect(result.unresolvedCommands).toEqual(["nosuchcmd"]);
  });

  it("drops applied entries even when a later apply fails", async () => {
    const sandbox = createAgentSandbox({ project: projectDir });
    await sandbox.exec("echo a > one.txt; echo b > two.txt");
    const all = sandbox.diff();
    const one = all.writes.find((w) => w.path.endsWith("one.txt"));
    const two = all.writes.find((w) => w.path.endsWith("two.txt"));
    if (!one || !two) throw new Error("expected writes missing from diff");
    // Sabotage the middle entry: its parent path is an existing FILE.
    const sabotaged = {
      writes: [
        one,
        {
          path: path.join(projectDir, "one.txt", "impossible.txt"),
          nodeType: "file" as const,
          content: new TextEncoder().encode("x"),
          mode: 0o644,
          mtime: new Date(),
        },
        two,
      ],
      deletions: [],
    };
    await expect(sandbox.applyChanges(sabotaged)).rejects.toThrow();
    // one.txt was applied and dropped; two.txt was never reached and
    // stays pending. The sabotage entry left nothing behind.
    const pending = sandbox.diff();
    expect(pending.writes.map((w) => path.basename(w.path))).toEqual([
      "two.txt",
    ]);
    expect(fs.existsSync(path.join(projectDir, "one.txt"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "two.txt"))).toBe(false);
  });

  it("applies metadataOnly writes without touching content", async () => {
    if (process.platform === "win32") return;
    const sandbox = createAgentSandbox({ project: projectDir });
    await sandbox.exec("chmod +x src/app.ts");
    const changes = sandbox.diff();
    expect(changes.writes).toHaveLength(1);
    expect(changes.writes[0].metadataOnly).toBe(true);

    await sandbox.applyChanges(changes);
    expect(sandbox.diff()).toEqual({ writes: [], deletions: [] });
    expect(fs.readFileSync(path.join(projectDir, "src/app.ts"), "utf8")).toBe(
      "export {}\n",
    );
    expect(
      fs.statSync(path.join(projectDir, "src/app.ts")).mode & 0o111,
    ).not.toBe(0);
  });
});
