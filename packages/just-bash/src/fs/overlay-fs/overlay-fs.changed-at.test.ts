import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayFs } from "./overlay-fs.js";

// changedAt is the overlay-assigned, untamperable mutation clock that
// mergeDiffs orders by. Distinct from mtime: mtime is content metadata
// the guest can set arbitrarily (touch -d), changedAt is stamped by the
// tree at every mutation and cannot be forged from inside the sandbox.
describe("diff() changedAt stamps", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "changedat-"));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  const makeOverlay = () => new OverlayFs({ root: tempDir, mountPoint: "/" });

  it("stamps writes with the mutation time", async () => {
    const overlay = makeOverlay();
    const before = Date.now();
    await overlay.writeFile("/f.txt", "x");
    const after = Date.now();
    const [w] = overlay.diff().writes;
    expect(w.changedAt).toBeGreaterThanOrEqual(before);
    expect(w.changedAt).toBeLessThanOrEqual(after);
  });

  it("stamps deletions with the whiteout creation time", async () => {
    fs.writeFileSync(path.join(tempDir, "doomed.txt"), "x");
    const overlay = makeOverlay();
    const before = Date.now();
    await overlay.rm("/doomed.txt");
    const after = Date.now();
    const diff = overlay.diff();
    expect(diff.deletions).toEqual(["/doomed.txt"]);
    expect(diff.deletionChangedAt?.[0]).toBeGreaterThanOrEqual(before);
    expect(diff.deletionChangedAt?.[0]).toBeLessThanOrEqual(after);
  });

  it("orders mutations monotonically", async () => {
    const overlay = makeOverlay();
    await overlay.writeFile("/a.txt", "a");
    await new Promise((r) => setTimeout(r, 5));
    await overlay.writeFile("/b.txt", "b");
    const writes = overlay.diff().writes;
    const a = writes.find((w) => w.path === "/a.txt");
    const b = writes.find((w) => w.path === "/b.txt");
    expect(a?.changedAt).toBeDefined();
    expect(b?.changedAt).toBeDefined();
    expect(b?.changedAt ?? 0).toBeGreaterThan(a?.changedAt ?? 0);
  });

  it("utimes updates changedAt (it is a mutation) but never moves mtime's clock", async () => {
    const overlay = makeOverlay();
    await overlay.writeFile("/f.txt", "x");
    const firstWrite = overlay.diff().writes[0];
    await new Promise((r) => setTimeout(r, 5));
    // Forge an ancient mtime from inside the sandbox.
    const ancient = new Date("1999-01-01T00:00:00Z");
    await overlay.utimes("/f.txt", ancient, ancient);
    const metacopy = overlay.diff().writes[0];
    // mtime is whatever the guest asked for (content metadata)...
    expect(metacopy.mtime).toEqual(ancient);
    // ...but changedAt advanced: a merge orders this entry AFTER the
    // original write, which is what actually happened.
    expect(metacopy.changedAt ?? 0).toBeGreaterThan(firstWrite.changedAt ?? 0);
    // An utimes on an upper-layer file updates it in place (metacopy
    // shadows are only for lower files), so this stays a full write.
    expect(metacopy.content.length).toBeGreaterThan(0);
  });
});
