import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayFs } from "./overlay-fs.js";

/**
 * drop(): intent-neutral removal of pending upper-layer entries. The
 * caller asserts the listed entries are done with (applied, rejected,
 * superseded) — the overlay neither knows nor checks which.
 */
describe("OverlayFs drop()", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-drop-"));
    fs.mkdirSync(path.join(tempDir, "src/nested"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src/nested/deep.txt"), "d");
    fs.writeFileSync(path.join(tempDir, "README.md"), "r");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const makeOverlay = () =>
    new OverlayFs({ root: tempDir, mountPoint: "/p", allowSymlinks: true });

  it("drops a pending write and removes it from the view", async () => {
    const overlay = makeOverlay();
    await overlay.writeFile("/p/new.txt", "hello");
    overlay.drop(["/new.txt"]);
    expect(overlay.diff()).toEqual({ writes: [], deletions: [] });
    expect(await overlay.exists("/p/new.txt")).toBe(false);
  });

  it("dropping a pending deletion resurrects the lower view", async () => {
    const overlay = makeOverlay();
    await overlay.rm("/p/README.md");
    overlay.drop(["/README.md"]);
    expect(overlay.diff()).toEqual({ writes: [], deletions: [] });
    await expect(overlay.readFile("/p/README.md")).resolves.toBe("r");
  });

  it("keeps a listed directory that still has pending children", async () => {
    const overlay = makeOverlay();
    await overlay.rm("/p/src", { recursive: true });
    await overlay.writeFile("/p/src/nested/new.txt", "n");
    // Both listed dirs still have pending children (the new file and the
    // deep.txt whiteout), so neither drops.
    overlay.drop(["/src", "/src/nested"]);
    const diff = overlay.diff();
    expect(diff.writes.map((w) => w.path)).toEqual([
      "/src",
      "/src/nested",
      "/src/nested/new.txt",
    ]);
    expect(diff.deletions).toEqual(["/src/nested/deep.txt"]);
  });

  it("drains nested paths deepest-first in one call", async () => {
    const overlay = makeOverlay();
    await overlay.rm("/p/src", { recursive: true });
    await overlay.writeFile("/p/src/nested/new.txt", "n");
    overlay.drop([
      "/src",
      "/src/nested",
      "/src/nested/new.txt",
      "/src/nested/deep.txt",
    ]);
    expect(overlay.diff()).toEqual({ writes: [], deletions: [] });
  });

  it("is a no-op for unknown paths and throws on root", async () => {
    const overlay = makeOverlay();
    await overlay.writeFile("/p/keep.txt", "k");
    overlay.drop(["/nonexistent", "/src/nested/deep.txt/child"]);
    expect(overlay.diff().writes.map((w) => w.path)).toEqual(["/keep.txt"]);
    expect(() => overlay.drop(["/"])).toThrow(/EINVAL/);
  });

  it("drops a whiteout child under a resurrected directory", async () => {
    const overlay = makeOverlay();
    await overlay.rm("/p/src", { recursive: true });
    // Resurrect two levels: /src (populates the nested whiteout), then
    // /src/nested (populates the deep.txt whiteout).
    await overlay.writeFile("/p/src/other.txt", "o");
    await overlay.writeFile("/p/src/nested/new2.txt", "n2");
    // deep.txt is hidden by its populated whiteout; dropping it brings
    // the lower file back without touching the new writes.
    overlay.drop(["/src/nested/deep.txt"]);
    await expect(overlay.readFile("/p/src/nested/deep.txt")).resolves.toBe("d");
    const writes = overlay.diff().writes.map((w) => w.path);
    expect(writes).toContain("/src/other.txt");
    expect(writes).toContain("/src/nested/new2.txt");
  });
});
