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

describe("changedAt integration with mergeDiffs (stamping gaps)", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "changedat-merge-"));
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("explicit mkdir after a whiteout resurrects (dir entries are stamped)", async () => {
    // Fork A deletes /p at t1; fork B mkdir /p/x later — the design
    // doc's core promise: later entries survive and the path resurrects.
    fs.mkdirSync(path.join(tempDir, "p"), { recursive: true });
    const { mergeDiffs } = await import("./merge.js");
    const a = new OverlayFs({ root: tempDir, mountPoint: "/" });
    await a.rm("/p", { recursive: true });
    await new Promise((r) => setTimeout(r, 5));
    const b = new OverlayFs({ root: tempDir, mountPoint: "/" });
    await b.mkdir("/p/x", { recursive: true });

    const merged = mergeDiffs([a.diff(), b.diff()]);
    // B's mkdir is LATER than A's whiteout: /p/x must survive. The /p
    // whiteout wins at its own path (scaffolding can't override it), so
    // the merged diff deletes /p and recreates only /p/x beneath it.
    expect(merged.writes.map((w) => w.path)).toEqual(["/p/x"]);
    expect(merged.deletions).toEqual(["/p"]);
  });

  it("rm -rf && mkdir whiteouts children with the deletion's time, not 0", async () => {
    // keep lives in the shared lower (on disk). Fork B modifies it at
    // t1; fork A does a clean rebuild (rm -rf /p && mkdir /p) at t2.
    // A's resurrection whiteout for keep must carry A's deletion time
    // so it suppresses B's earlier write.
    fs.mkdirSync(path.join(tempDir, "p"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "p", "keep"), "original");
    const { mergeDiffs } = await import("./merge.js");
    const b = new OverlayFs({ root: tempDir, mountPoint: "/" });
    await b.writeFile("/p/keep", "modified-by-b");
    await new Promise((r) => setTimeout(r, 5));
    const a = new OverlayFs({ root: tempDir, mountPoint: "/" });
    await a.rm("/p", { recursive: true });
    await new Promise((r) => setTimeout(r, 5));
    await a.mkdir("/p");

    const merged = mergeDiffs([b.diff(), a.diff()]);
    // A deleted /p/keep AFTER B wrote it: the resurrection whiteout
    // suppresses B's earlier write. The resurrected /p dir wins at its
    // own path (it is newer than the /p whiteout), so the top-most
    // surviving deletion is /p/keep itself.
    expect(merged.deletions).toEqual(["/p/keep"]);
    expect(merged.writes.map((w) => w.path)).toEqual(["/p"]);
  });
});
