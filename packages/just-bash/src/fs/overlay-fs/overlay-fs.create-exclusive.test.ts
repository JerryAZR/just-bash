import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayFs } from "./overlay-fs.js";

describe("OverlayFs createExclusive", () => {
  let root: string;
  let overlay: OverlayFs;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-create-excl-"));
    overlay = new OverlayFs({ root, mountPoint: "/" });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates an empty file in the upper layer with the mode applied", async () => {
    await overlay.createExclusive("/fresh.txt", { mode: 0o600 });

    const stat = await overlay.stat("/fresh.txt");
    expect(stat.isFile).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await overlay.readFile("/fresh.txt")).toBe("");
    // Nothing reached the disk: the overlay is copy-on-write.
    expect(fs.existsSync(path.join(root, "fresh.txt"))).toBe(false);
    // And the mutation is reported as a pending write with a stamp.
    const diff = overlay.diff();
    const write = diff.writes.find((w) => w.path === "/fresh.txt");
    expect(write?.nodeType).toBe("file");
    expect(write?.mode).toBe(0o600);
    expect(write?.changedAt).toBeGreaterThan(0);
  });

  it("creates a directory with the mode applied", async () => {
    await overlay.createExclusive("/fresh-dir", {
      mode: 0o700,
      directory: true,
    });

    const stat = await overlay.stat("/fresh-dir");
    expect(stat.isDirectory).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);

    const diff = overlay.diff();
    const write = diff.writes.find((w) => w.path === "/fresh-dir");
    expect(write?.nodeType).toBe("directory");
    expect(write?.mode).toBe(0o700);
    expect(write?.changedAt).toBeGreaterThan(0);
  });

  it("rejects a name held by a live upper-layer entry", async () => {
    await overlay.writeFile("/taken.txt", "upper");

    await expect(
      overlay.createExclusive("/taken.txt", { mode: 0o600 }),
    ).rejects.toThrow("EEXIST");
    expect(await overlay.readFile("/taken.txt")).toBe("upper");
  });

  it("rejects a name present in the lower layer without a covering whiteout", async () => {
    fs.writeFileSync(path.join(root, "lower.txt"), "on-disk");

    await expect(
      overlay.createExclusive("/lower.txt", { mode: 0o600 }),
    ).rejects.toThrow("EEXIST");
    // The lower file must not be shadowed or truncated.
    expect(await overlay.readFile("/lower.txt")).toBe("on-disk");
    expect(overlay.diff().writes).toEqual([]);
  });

  it("treats a whiteout as free: clears it and attaches", async () => {
    fs.writeFileSync(path.join(root, "tomb.txt"), "first");
    await overlay.rm("/tomb.txt");
    expect(await overlay.exists("/tomb.txt")).toBe(false);

    await overlay.createExclusive("/tomb.txt", { mode: 0o600 });

    // Without clearing the whiteout the entry would exist in the upper
    // layer while staying invisible to exists/stat/readdir.
    expect(await overlay.exists("/tomb.txt")).toBe(true);
    const stat = await overlay.stat("/tomb.txt");
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await overlay.readFile("/tomb.txt")).toBe("");
    // Delete-then-recreate is reported as a write, not a deletion.
    const diff = overlay.diff();
    expect(diff.deletions).toEqual([]);
    expect(diff.writes.some((w) => w.path === "/tomb.txt")).toBe(true);
  });

  it("resurrects a whiteouted directory without reviving lower contents", async () => {
    fs.mkdirSync(path.join(root, "gone"));
    fs.writeFileSync(path.join(root, "gone", "old.txt"), "stale");
    await overlay.rm("/gone", { recursive: true });

    await overlay.createExclusive("/gone", { mode: 0o700, directory: true });

    const stat = await overlay.stat("/gone");
    expect(stat.isDirectory).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
    // The deleted lower contents stay deleted.
    expect(await overlay.readdir("/gone")).toEqual([]);
  });

  it("fails with ENOENT when the parent does not exist", async () => {
    await expect(
      overlay.createExclusive("/missing/file.txt", { mode: 0o600 }),
    ).rejects.toThrow("ENOENT");
    expect(overlay.diff().writes).toEqual([]);
  });

  it("fails with ENOTDIR when the parent is a file", async () => {
    await overlay.writeFile("/afile", "data");

    await expect(
      overlay.createExclusive("/afile/child", { mode: 0o600 }),
    ).rejects.toThrow("ENOTDIR");
  });

  it("never follows a symlink occupying the final component", async () => {
    // Symlinks are blocked by default; opt in so a link can exist at all.
    const symlinked = new OverlayFs({
      root,
      mountPoint: "/",
      allowSymlinks: true,
    });
    await symlinked.writeFile("/victim.txt", "untouched");
    await symlinked.symlink("/victim.txt", "/link.txt");

    await expect(
      symlinked.createExclusive("/link.txt", { mode: 0o600 }),
    ).rejects.toThrow("EEXIST");
    // The link target must not have been written through.
    expect(await symlinked.readFile("/victim.txt")).toBe("untouched");
    expect((await symlinked.lstat("/link.txt")).isSymbolicLink).toBe(true);
  });

  it("resolves a symlinked parent instead of creating beside it", async () => {
    const symlinked = new OverlayFs({
      root,
      mountPoint: "/",
      allowSymlinks: true,
    });
    await symlinked.mkdir("/real");
    await symlinked.symlink("/real", "/link");

    await symlinked.createExclusive("/link/file.txt", { mode: 0o600 });

    expect(await symlinked.exists("/real/file.txt")).toBe(true);
    expect(await symlinked.readdir("/real")).toEqual(["file.txt"]);
  });

  it("treats a lower-layer symlink at the name as a collision", async () => {
    fs.writeFileSync(path.join(root, "victim.txt"), "untouched");
    fs.symlinkSync(path.join(root, "victim.txt"), path.join(root, "link.txt"));

    await expect(
      overlay.createExclusive("/link.txt", { mode: 0o600 }),
    ).rejects.toThrow("EEXIST");
    expect(fs.readFileSync(path.join(root, "victim.txt"), "utf8")).toBe(
      "untouched",
    );
  });

  it("is exclusive between interleaved concurrent calls", async () => {
    const results = await Promise.allSettled([
      overlay.createExclusive("/race.txt", { mode: 0o600 }),
      overlay.createExclusive("/race.txt", { mode: 0o600 }),
      overlay.createExclusive("/race.txt", { mode: 0o600 }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
  });

  it("rejects creation on a read-only overlay", async () => {
    const ro = new OverlayFs({ root, mountPoint: "/", readOnly: true });

    await expect(
      ro.createExclusive("/nope.txt", { mode: 0o600 }),
    ).rejects.toThrow("EROFS");
  });
});
