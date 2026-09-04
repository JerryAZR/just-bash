import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayFs } from "./overlay-fs.js";

/**
 * Metacopy semantics: chmod/utimes copy-up moves metadata to the upper
 * layer while data stays lower. Reads fall through (POSIX) or promote
 * (Windows); the first content write completes the copy-up.
 */
describe("OverlayFs metacopy", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-metacopy-"));
    fs.writeFileSync(path.join(tempDir, "run.sh"), "#!/bin/sh\necho hi\n");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const makeOverlay = (maxMemoryBytes?: number) =>
    new OverlayFs({
      root: tempDir,
      mountPoint: "/p",
      allowSymlinks: true,
      maxMemoryBytes,
    });

  it("chmod moves metadata up without copying data, reads stay correct", async () => {
    const overlay = makeOverlay();
    await overlay.chmod("/p/run.sh", 0o755);

    const st = await overlay.stat("/p/run.sh");
    expect(st.mode).toBe(0o755);
    expect(st.size).toBe("#!/bin/sh\necho hi\n".length);
    await expect(overlay.readFile("/p/run.sh")).resolves.toBe(
      "#!/bin/sh\necho hi\n",
    );
  });

  it("chmod costs no quota bytes even under a tiny memory limit", async () => {
    // 5-byte quota: a full copy-up of the 17-byte file would throw ENOSPC.
    const overlay = makeOverlay(5);
    await overlay.chmod("/p/run.sh", 0o700);
    expect((await overlay.stat("/p/run.sh")).mode).toBe(0o700);
  });

  it("utimes sets mtime without copying data or changing content", async () => {
    const overlay = makeOverlay();
    const when = new Date("2001-02-03T04:05:06Z");
    await overlay.utimes("/p/run.sh", when, when);

    const st = await overlay.stat("/p/run.sh");
    expect(st.mtime).toEqual(when);
    expect(st.size).toBe(18);
    await expect(overlay.readFile("/p/run.sh")).resolves.toBe(
      "#!/bin/sh\necho hi\n",
    );
  });

  it("chmod on a lower directory records a plain directory write", async () => {
    // Directories have no metacopy: chmod shadows the whole directory
    // node, and diff reports a normal (not metadataOnly) directory write.
    fs.mkdirSync(path.join(tempDir, "srcdir"));
    const overlay = makeOverlay();
    await overlay.chmod("/p/srcdir", 0o700);
    const writes = overlay.diff().writes;
    expect(writes).toEqual([
      expect.objectContaining({
        path: "/srcdir",
        nodeType: "directory",
        mode: 0o700,
      }),
    ]);
    expect(writes[0].metadataOnly).toBeUndefined();
  });

  it("chmod does not touch mtime (POSIX: ctime only)", async () => {
    const overlay = makeOverlay();
    const before = (await overlay.stat("/p/run.sh")).mtime;
    await overlay.chmod("/p/run.sh", 0o755);
    expect((await overlay.stat("/p/run.sh")).mtime).toEqual(before);
  });

  it("writeFile completes the copy-up, preserving the metacopy mode", async () => {
    const overlay = makeOverlay();
    await overlay.chmod("/p/run.sh", 0o755);
    await overlay.writeFile("/p/run.sh", "#!/bin/sh\nexit 0\n");

    const st = await overlay.stat("/p/run.sh");
    expect(st.mode).toBe(0o755);
    expect(st.size).toBe(17);
    await expect(overlay.readFile("/p/run.sh")).resolves.toBe(
      "#!/bin/sh\nexit 0\n",
    );
  });

  it("appendFile completes the copy-up with lower data plus the chunk", async () => {
    const overlay = makeOverlay();
    await overlay.chmod("/p/run.sh", 0o755);
    await overlay.appendFile("/p/run.sh", "echo done\n");

    expect((await overlay.stat("/p/run.sh")).mode).toBe(0o755);
    await expect(overlay.readFile("/p/run.sh")).resolves.toBe(
      "#!/bin/sh\necho hi\necho done\n",
    );
  });

  it("rm of a metacopy node leaves a plain whiteout", async () => {
    const overlay = makeOverlay();
    await overlay.chmod("/p/run.sh", 0o755);
    await overlay.rm("/p/run.sh");
    expect(await overlay.exists("/p/run.sh")).toBe(false);
    await overlay.writeFile("/p/run.sh", "new\n");
    await expect(overlay.readFile("/p/run.sh")).resolves.toBe("new\n");
  });

  it("POSIX: reads fall through without promoting", async () => {
    if (process.platform === "win32") return;
    const overlay = makeOverlay();
    await overlay.chmod("/p/run.sh", 0o755);
    await overlay.readFile("/p/run.sh");
    // Lower file removed out-of-band: the read still falls through and fails.
    fs.rmSync(path.join(tempDir, "run.sh"));
    await expect(overlay.readFile("/p/run.sh")).rejects.toThrow("ENOENT");
  });

  it("Windows: first read promotes to a full upper node", async () => {
    if (process.platform !== "win32") return;
    const overlay = makeOverlay();
    await overlay.chmod("/p/run.sh", 0o755);
    await overlay.readFile("/p/run.sh");
    // Promoted: content is now memory-resident even if the lower file goes away.
    fs.rmSync(path.join(tempDir, "run.sh"));
    await expect(overlay.readFile("/p/run.sh")).resolves.toBe(
      "#!/bin/sh\necho hi\n",
    );
  });
});
