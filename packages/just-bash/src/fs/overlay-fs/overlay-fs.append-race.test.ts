import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayFs } from "./overlay-fs.js";

// Concurrency: the first append to a lower-backed file reads the lower
// content asynchronously before attaching an upper node. Two concurrent
// first-appends used to race: both read the same base, both attached,
// and the second attach silently dropped the first chunk. POSIX
// O_APPEND must not lose data, so appendFile re-descends after the read
// and appends onto an upper node that appeared meanwhile.
describe("appendFile concurrency", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "append-race-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("two concurrent first-appends both survive", async () => {
    fs.writeFileSync(path.join(root, "base.txt"), "base\n");
    const vfs = new OverlayFs({ root, mountPoint: "/" });
    await Promise.all([
      vfs.appendFile("/base.txt", "a\n"),
      vfs.appendFile("/base.txt", "b\n"),
    ]);
    const content = await vfs.readFile("/base.txt");
    expect(content.startsWith("base\n")).toBe(true);
    expect(content).toContain("a\n");
    expect(content).toContain("b\n");
    expect(content.length).toBe("base\na\nb\n".length);
  });

  it("many concurrent first-appends all survive", async () => {
    fs.writeFileSync(path.join(root, "log.txt"), "");
    const vfs = new OverlayFs({ root, mountPoint: "/" });
    const chunks = Array.from({ length: 16 }, (_, i) => `line-${i}\n`);
    await Promise.all(chunks.map((c) => vfs.appendFile("/log.txt", c)));
    const content = await vfs.readFile("/log.txt");
    for (const c of chunks) expect(content).toContain(c);
    expect(content.length).toBe(chunks.join("").length);
  });

  it("concurrent appends to an already-upper file are atomic", async () => {
    const vfs = new OverlayFs({ root, mountPoint: "/" });
    await vfs.writeFile("/up.txt", "start\n");
    await Promise.all([
      vfs.appendFile("/up.txt", "x\n"),
      vfs.appendFile("/up.txt", "y\n"),
    ]);
    const content = await vfs.readFile("/up.txt");
    expect(content.length).toBe("start\nx\ny\n".length);
    expect(content).toContain("x\n");
    expect(content).toContain("y\n");
  });
});

describe("appendFile metacopy race", () => {
  it("two concurrent first-appends to a chmod-shadowed file both survive", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "append-meta-"));
    try {
      fs.writeFileSync(path.join(root, "m.txt"), "base\n");
      const vfs = new OverlayFs({ root, mountPoint: "/" });
      // chmod creates a metacopy shadow (metadata upper, data lower).
      await vfs.chmod("/m.txt", 0o600);
      await Promise.all([
        vfs.appendFile("/m.txt", "a\n"),
        vfs.appendFile("/m.txt", "b\n"),
      ]);
      const content = await vfs.readFile("/m.txt");
      expect(content.startsWith("base\n")).toBe(true);
      expect(content).toContain("a\n");
      expect(content).toContain("b\n");
      expect(content.length).toBe("base\na\nb\n".length);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
