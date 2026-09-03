import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayFs } from "./overlay-fs.js";

/**
 * Pins the whiteout/opacity semantics the tree representation guarantees
 * structurally — the flat map achieved some of these only implicitly, via
 * the "rm -rf tombstones every descendant" invariant.
 */
describe("OverlayFs whiteout semantics", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-walk-"));
    fs.mkdirSync(path.join(tempDir, "a/b"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "a/b/deep.txt"), "deep");
    fs.writeFileSync(path.join(tempDir, "a/top.txt"), "top");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const makeOverlay = () =>
    new OverlayFs({ root: tempDir, mountPoint: "/p", allowSymlinks: true });

  it("hides descendants of a whiteouted directory from every operation", async () => {
    const overlay = makeOverlay();
    await overlay.rm("/p/a", { recursive: true });

    await expect(overlay.stat("/p/a/b/deep.txt")).rejects.toThrow("ENOENT");
    await expect(overlay.lstat("/p/a/b")).rejects.toThrow("ENOENT");
    await expect(overlay.readdir("/p/a")).rejects.toThrow("ENOENT");
    await expect(overlay.readdir("/p/a/b")).rejects.toThrow("ENOENT");
    await expect(overlay.readFile("/p/a/top.txt")).rejects.toThrow("ENOENT");
    await expect(overlay.rm("/p/a/b/deep.txt")).rejects.toThrow("ENOENT");
    await expect(overlay.appendFile("/p/a/new.txt", "x")).rejects.toThrow(
      "ENOENT",
    );
    expect(await overlay.exists("/p/a/b/deep.txt")).toBe(false);
  });

  it("does not re-expose deep real children after resurrection", async () => {
    const overlay = makeOverlay();
    await overlay.rm("/p/a", { recursive: true });
    await overlay.writeFile("/p/a/b/new.txt", "new");

    // /p/a resurrected opaque: the old lower layer stays hidden at any depth.
    expect(await overlay.readdir("/p/a")).toEqual(["b"]);
    expect(await overlay.readdir("/p/a/b")).toEqual(["new.txt"]);
    await expect(overlay.readFile("/p/a/b/deep.txt")).rejects.toThrow("ENOENT");
    await expect(overlay.readFile("/p/a/top.txt")).rejects.toThrow("ENOENT");
    expect(await overlay.readFile("/p/a/b/new.txt")).toBe("new");
  });

  it("mkdir-resurrection is opaque as well", async () => {
    const overlay = makeOverlay();
    await overlay.rm("/p/a", { recursive: true });
    await overlay.mkdir("/p/a");

    expect(await overlay.readdir("/p/a")).toEqual([]);
    await expect(overlay.stat("/p/a/top.txt")).rejects.toThrow("ENOENT");
  });

  it("rm of a memory-only path leaves no whiteout behind", async () => {
    const overlay = makeOverlay();
    await overlay.writeFile("/p/scratch.txt", "x");
    await overlay.rm("/p/scratch.txt");
    // Recreate works and there is nothing hidden to resurrect.
    await overlay.writeFile("/p/scratch.txt", "y");
    expect(await overlay.readFile("/p/scratch.txt")).toBe("y");
  });

  it("rejects writeFile over a directory with EISDIR (no ghost state)", async () => {
    const overlay = makeOverlay();
    await overlay.mkdir("/p/dir");
    await overlay.writeFile("/p/dir/child.txt", "c");

    await expect(overlay.writeFile("/p/dir", "x")).rejects.toThrow("EISDIR");
    // The directory is untouched: no ghost, children intact.
    expect((await overlay.stat("/p/dir")).isDirectory).toBe(true);
    expect(await overlay.readdir("/p/dir")).toEqual(["child.txt"]);
  });

  it("reports ENOTDIR below a file shadow instead of leaking real children", async () => {
    fs.mkdirSync(path.join(tempDir, "shadow"));
    fs.writeFileSync(path.join(tempDir, "shadow/real.txt"), "real");
    const overlay = makeOverlay();
    await overlay.writeFile("/p/shadow", "now-a-file");

    expect((await overlay.stat("/p/shadow")).isFile).toBe(true);
    await expect(overlay.stat("/p/shadow/real.txt")).rejects.toThrow("ENOTDIR");
    await expect(overlay.readdir("/p/shadow")).rejects.toThrow("ENOTDIR");
  });

  it("releases subtree memory on rm -rf (quota accounting)", async () => {
    const overlay = new OverlayFs({
      root: tempDir,
      mountPoint: "/p",
      maxMemoryBytes: 10,
    });
    await overlay.writeFile("/p/big/f.txt", "12345678");
    await overlay.rm("/p/big", { recursive: true });
    // The 8 bytes were released with the subtree, so a new 8-byte file fits.
    await overlay.writeFile("/p/other.txt", "12345678");
    expect(await overlay.readFile("/p/other.txt")).toBe("12345678");
  });
});
