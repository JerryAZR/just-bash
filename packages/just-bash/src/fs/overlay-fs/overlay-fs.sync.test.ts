import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayFs } from "./overlay-fs.js";

describe("OverlayFs sync() and reset()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-sync-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const makeOverlay = () =>
    new OverlayFs({
      root: tempDir,
      mountPoint: "/project",
      allowSymlinks: true,
    });

  describe("sync()", () => {
    it("drops file shadows the host applied and keeps differing ones", async () => {
      const overlay = makeOverlay();
      await overlay.writeFile("/project/applied.txt", "on disk now");
      await overlay.writeFile("/project/pending.txt", "not applied");
      fs.writeFileSync(path.join(tempDir, "applied.txt"), "on disk now");
      await overlay.sync();
      expect(overlay.diff().writes.map((w) => w.path)).toEqual([
        "/pending.txt",
      ]);
      await expect(overlay.readFile("/project/applied.txt")).resolves.toBe(
        "on disk now",
      );
    });

    it("keeps a directory while children are pending, drops it when applied", async () => {
      const overlay = makeOverlay();
      await overlay.writeFile("/project/d/a.txt", "a");
      await overlay.writeFile("/project/d/b.txt", "b");
      fs.mkdirSync(path.join(tempDir, "d"));
      fs.writeFileSync(path.join(tempDir, "d/a.txt"), "a");
      await overlay.sync();
      expect(overlay.diff().writes.map((w) => w.path)).toEqual([
        "/d",
        "/d/b.txt",
      ]);
      fs.writeFileSync(path.join(tempDir, "d/b.txt"), "b");
      await overlay.sync();
      expect(overlay.diff()).toEqual({ writes: [], deletions: [] });
    });

    it("clears stale whiteouts after the host deletes the disk path", async () => {
      fs.mkdirSync(path.join(tempDir, "sub"));
      fs.writeFileSync(path.join(tempDir, "sub/f.txt"), "f");
      fs.writeFileSync(path.join(tempDir, "top.txt"), "t");
      const overlay = makeOverlay();
      await overlay.rm("/project/sub", { recursive: true });
      await overlay.rm("/project/top.txt");
      fs.rmSync(path.join(tempDir, "sub"), { recursive: true });
      await overlay.sync();
      expect(overlay.diff()).toEqual({ writes: [], deletions: ["/top.txt"] });
    });

    it("coalesces append chunks before comparing against disk", async () => {
      const overlay = makeOverlay();
      await overlay.appendFile("/project/log.txt", "a");
      await overlay.appendFile("/project/log.txt", "b");
      fs.writeFileSync(path.join(tempDir, "log.txt"), "ab");
      await overlay.sync();
      expect(overlay.diff()).toEqual({ writes: [], deletions: [] });
    });

    it("reconciles a resurrection diff fully after the host applies it", async () => {
      fs.mkdirSync(path.join(tempDir, "a/b"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "a/top.txt"), "top");
      fs.writeFileSync(path.join(tempDir, "a/b/deep.txt"), "deep");
      const overlay = makeOverlay();
      await overlay.rm("/project/a", { recursive: true });
      await overlay.writeFile("/project/a/b/new.txt", "new");

      // Host applies the diff: delete old children, write new file.
      fs.rmSync(path.join(tempDir, "a/top.txt"));
      fs.rmSync(path.join(tempDir, "a/b/deep.txt"));
      fs.writeFileSync(path.join(tempDir, "a/b/new.txt"), "new");
      await overlay.sync();

      expect(overlay.diff()).toEqual({ writes: [], deletions: [] });
      await expect(overlay.readdir("/project/a/b")).resolves.toEqual([
        "new.txt",
      ]);
    });

    it("POSIX: chmod-only shadow stays pending until the host applies it", async () => {
      if (process.platform === "win32") return;
      fs.writeFileSync(path.join(tempDir, "run.sh"), "#!/bin/sh\n");
      const overlay = makeOverlay();
      await overlay.chmod("/project/run.sh", 0o755);
      await overlay.sync();
      // Not applied: mode still differs, the change is not silently lost.
      expect(overlay.diff().writes).toHaveLength(1);
      fs.chmodSync(path.join(tempDir, "run.sh"), 0o755);
      await overlay.sync();
      expect(overlay.diff()).toEqual({ writes: [], deletions: [] });
    });

    it("Windows: chmod-only shadow drops on mtime match (mode advisory)", async () => {
      if (process.platform !== "win32") return;
      fs.writeFileSync(path.join(tempDir, "run.sh"), "#!/bin/sh\n");
      const overlay = makeOverlay();
      await overlay.chmod("/project/run.sh", 0o755);
      await overlay.sync();
      expect(overlay.diff()).toEqual({ writes: [], deletions: [] });
    });

    it("drops utimes shadows once the host applies the mtime", async () => {
      fs.writeFileSync(path.join(tempDir, "data.txt"), "data");
      const overlay = makeOverlay();
      const when = new Date("2001-02-03T04:05:06Z");
      await overlay.utimes("/project/data.txt", when, when);
      await overlay.sync();
      expect(overlay.diff().writes).toHaveLength(1);
      const now = new Date();
      fs.utimesSync(path.join(tempDir, "data.txt"), now, when);
      await overlay.sync();
      expect(overlay.diff()).toEqual({ writes: [], deletions: [] });
    });
  });

  describe("reset()", () => {
    it("clears all pending state and re-baselines on disk", async () => {
      fs.writeFileSync(path.join(tempDir, "disk.txt"), "disk");
      const overlay = makeOverlay();
      await overlay.writeFile("/project/pending.txt", "p");
      await overlay.rm("/project/disk.txt");
      overlay.reset();
      expect(overlay.diff()).toEqual({ writes: [], deletions: [] });
      await expect(overlay.readFile("/project/disk.txt")).resolves.toBe("disk");
      await overlay.writeFile("/project/after.txt", "a");
      expect(overlay.diff().writes.map((w) => w.path)).toEqual(["/after.txt"]);
    });
  });
});
