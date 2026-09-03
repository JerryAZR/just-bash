import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayFs, type OverlayWrite } from "./overlay-fs.js";

const text = (s: string) => new TextEncoder().encode(s);

/** Drop per-write mtime for deterministic comparisons. */
const stripMtime = (ws: OverlayWrite[]) =>
  ws.map(({ mtime: _, ...rest }) => rest);

describe("OverlayFs diff()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-diff-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const makeOverlay = (mountPoint = "/project") =>
    new OverlayFs({ root: tempDir, mountPoint, allowSymlinks: true });

  it("is empty on a fresh overlay", () => {
    expect(makeOverlay().diff()).toEqual({ writes: [], deletions: [] });
  });

  it("reports created files with root-relative paths, content, and mode", async () => {
    const overlay = makeOverlay();
    await overlay.writeFile("/project/src/app.ts", "code");
    expect(stripMtime(overlay.diff().writes)).toEqual([
      {
        path: "/src",
        nodeType: "directory",
        content: new Uint8Array(0),
        mode: 0o755,
      },
      {
        path: "/src/app.ts",
        nodeType: "file",
        content: text("code"),
        mode: 0o644,
      },
    ]);
  });

  it("reports one write with full content when a disk file is modified", async () => {
    fs.writeFileSync(path.join(tempDir, "README.md"), "old\n");
    const overlay = makeOverlay();
    await overlay.appendFile("/project/README.md", "new\n");
    const diff = overlay.diff();
    expect(diff.writes).toHaveLength(1);
    expect(diff.writes[0].path).toBe("/README.md");
    expect(new TextDecoder().decode(diff.writes[0].content)).toBe("old\nnew\n");
  });

  it("reports top-most deletions only for removed subtrees", async () => {
    fs.mkdirSync(path.join(tempDir, "src/nested"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src/nested/a.ts"), "a");
    fs.writeFileSync(path.join(tempDir, "src/b.ts"), "b");
    const overlay = makeOverlay();
    await overlay.rm("/project/src", { recursive: true });
    expect(overlay.diff()).toEqual({ writes: [], deletions: ["/src"] });
  });

  it("reports neither list for create-then-delete that never touched disk", async () => {
    const overlay = makeOverlay();
    await overlay.writeFile("/project/scratch.txt", "x");
    await overlay.rm("/project/scratch.txt");
    expect(overlay.diff()).toEqual({ writes: [], deletions: [] });
  });

  it("reports delete-then-recreate as a write, not a deletion", async () => {
    fs.writeFileSync(path.join(tempDir, "config.yml"), "v1");
    const overlay = makeOverlay();
    await overlay.rm("/project/config.yml");
    await overlay.writeFile("/project/config.yml", "v2");
    const diff = overlay.diff();
    expect(diff.deletions).toEqual([]);
    expect(diff.writes).toHaveLength(1);
    expect(new TextDecoder().decode(diff.writes[0].content)).toBe("v2");
  });

  it("excludes writes outside the mount point", async () => {
    const overlay = makeOverlay();
    await overlay.writeFile("/tmp/scratch.txt", "x");
    expect(overlay.diff()).toEqual({ writes: [], deletions: [] });
  });

  it("drops whiteouts whose disk path is already gone", async () => {
    fs.writeFileSync(path.join(tempDir, "gone.txt"), "x");
    const overlay = makeOverlay();
    await overlay.rm("/project/gone.txt");
    fs.rmSync(path.join(tempDir, "gone.txt"));
    expect(overlay.diff()).toEqual({ writes: [], deletions: [] });
  });

  it("reports symlink writes with the target as content", async () => {
    const overlay = makeOverlay();
    await overlay.writeFile("/project/target.txt", "x");
    await overlay.symlink("/project/target.txt", "/project/link.txt");
    const link = overlay.diff().writes.find((w) => w.path === "/link.txt");
    expect(link?.nodeType).toBe("symlink");
    expect(new TextDecoder().decode(link?.content)).toBe("/project/target.txt");
  });

  it("sorts writes and deletions by path", async () => {
    fs.writeFileSync(path.join(tempDir, "z.txt"), "z");
    fs.writeFileSync(path.join(tempDir, "a.txt"), "a");
    const overlay = makeOverlay();
    await overlay.writeFile("/project/m.txt", "m");
    await overlay.rm("/project/z.txt");
    await overlay.rm("/project/a.txt");
    const diff = overlay.diff();
    expect(diff.writes.map((w) => w.path)).toEqual(["/m.txt"]);
    expect(diff.deletions).toEqual(["/a.txt", "/z.txt"]);
  });

  it("reports the minimal change set after rm -rf plus recreate", async () => {
    fs.mkdirSync(path.join(tempDir, "a/b"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "a/top.txt"), "top");
    fs.writeFileSync(path.join(tempDir, "a/b/deep.txt"), "deep");
    const overlay = makeOverlay();
    await overlay.rm("/project/a", { recursive: true });
    await overlay.writeFile("/project/a/b/new.txt", "new");

    const diff = overlay.diff();
    expect(diff.deletions).toEqual(["/a/b/deep.txt", "/a/top.txt"]);
    expect(diff.writes.map((w) => w.path)).toEqual([
      "/a",
      "/a/b",
      "/a/b/new.txt",
    ]);
  });

  it("collapses large removed trees into one deletion", async () => {
    fs.mkdirSync(path.join(tempDir, "big"));
    for (let i = 0; i < 1000; i++) {
      fs.writeFileSync(path.join(tempDir, `big/f${i}.txt`), "x");
    }
    const overlay = makeOverlay();
    await overlay.rm("/project/big", { recursive: true });
    expect(overlay.diff().deletions).toEqual(["/big"]);
  });

  describe("metadata-only writes", () => {
    it("reports chmod as a metadataOnly write with empty content", async () => {
      fs.writeFileSync(path.join(tempDir, "run.sh"), "#!/bin/sh\n");
      const overlay = makeOverlay();
      await overlay.chmod("/project/run.sh", 0o755);
      const writes = overlay.diff().writes;
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        path: "/run.sh",
        nodeType: "file",
        mode: 0o755,
        metadataOnly: true,
      });
      expect(writes[0].content.byteLength).toBe(0);
    });

    it("carries the new mtime on utimes writes", async () => {
      fs.writeFileSync(path.join(tempDir, "data.txt"), "data");
      const overlay = makeOverlay();
      const when = new Date("2001-02-03T04:05:06Z");
      await overlay.utimes("/project/data.txt", when, when);
      const writes = overlay.diff().writes;
      expect(writes).toHaveLength(1);
      expect(writes[0].metadataOnly).toBe(true);
      expect(writes[0].mtime).toEqual(when);
    });

    it("reports an ordinary write once content is written after chmod", async () => {
      fs.writeFileSync(path.join(tempDir, "run.sh"), "v1");
      const overlay = makeOverlay();
      await overlay.chmod("/project/run.sh", 0o755);
      await overlay.writeFile("/project/run.sh", "v2");
      const writes = overlay.diff().writes;
      expect(writes).toHaveLength(1);
      expect(writes[0].metadataOnly).toBeUndefined();
      expect(writes[0].mode).toBe(0o755);
      expect(new TextDecoder().decode(writes[0].content)).toBe("v2");
    });
  });
});
