import { describe, expect, it } from "vitest";
import { mergeDiffs } from "./merge.js";
import type { OverlayDiff, OverlayWrite } from "./overlay-fs.js";

const file = (
  path: string,
  changedAt: number,
  content = "x",
  extra: Partial<OverlayWrite> = {},
): OverlayWrite => ({
  path,
  nodeType: "file",
  content: new TextEncoder().encode(content),
  mode: 0o644,
  mtime: new Date(0),
  changedAt,
  ...extra,
});

const dir = (path: string, changedAt: number): OverlayWrite => ({
  path,
  nodeType: "directory",
  content: new Uint8Array(0),
  mode: 0o755,
  mtime: new Date(0),
  changedAt,
});

const diff = (
  writes: OverlayWrite[] = [],
  deletions: [string, number][] = [],
): OverlayDiff => ({
  writes,
  deletions: deletions.map((d) => d[0]),
  ...(deletions.length > 0 && {
    deletionChangedAt: deletions.map((d) => d[1]),
  }),
});

const text = (w: OverlayWrite | undefined) =>
  w ? new TextDecoder().decode(w.content) : undefined;

describe("mergeDiffs", () => {
  it("later changedAt wins on the same path", () => {
    const merged = mergeDiffs([
      diff([file("/f", 1, "old")]),
      diff([file("/f", 2, "new")]),
    ]);
    expect(merged.writes).toHaveLength(1);
    expect(text(merged.writes[0])).toBe("new");
  });

  it("breaks ties by input order", () => {
    const merged = mergeDiffs([
      diff([file("/f", 5, "first")]),
      diff([file("/f", 5, "second")]),
    ]);
    expect(text(merged.writes[0])).toBe("second");
  });

  it("treats a missing changedAt as 0 (loses to stamped entries)", () => {
    const merged = mergeDiffs([
      diff([file("/f", undefined as unknown as number, "unstamped")]),
      diff([file("/f", 1, "stamped")]),
    ]);
    expect(text(merged.writes[0])).toBe("stamped");
  });

  it("write vs whiteout at the same path: later entry wins", () => {
    // Whiteout later → deleted.
    expect(mergeDiffs([diff([file("/x", 1)]), diff([], [["/x", 2]])])).toEqual({
      writes: [],
      deletions: ["/x"],
      deletionChangedAt: [2],
    });
    // Write later → exists, whiteout discarded.
    const merged = mergeDiffs([diff([], [["/x", 1]]), diff([file("/x", 2)])]);
    expect(merged.deletions).toEqual([]);
    expect(merged.writes).toHaveLength(1);
  });

  it("directory whiteout suppresses earlier subtree entries", () => {
    const merged = mergeDiffs([
      diff([dir("/out", 1), file("/out/f", 1)]),
      diff([], [["/out", 2]]),
    ]);
    expect(merged).toEqual({
      writes: [],
      deletions: ["/out"],
      deletionChangedAt: [2],
    });
  });

  it("later entries under a whiteout resurrect the path (worked example)", () => {
    // Whiteout /out at t2, B writes /out/f at t3, C writes /out/g at t4
    // → /out deleted, then resurrected containing only {f, g}.
    const merged = mergeDiffs([
      diff([], [["/out", 2]]),
      diff([dir("/out", 3), file("/out/f", 3)]),
      diff([dir("/out", 4), file("/out/g", 4)]),
    ]);
    expect(merged.deletions).toEqual(["/out"]);
    // No "/out" dir entry — scaffolding is dropped, and apply ensures
    // parents when writing the files. The merged diff stays minimal.
    expect(merged.writes.map((w) => w.path).sort()).toEqual([
      "/out/f",
      "/out/g",
    ]);
  });

  it("a winning file drops every entry under its path, regardless of time", () => {
    const merged = mergeDiffs([
      diff([dir("/p/sub", 3), file("/p/sub/x", 3)]),
      diff([file("/p", 2)]),
    ]);
    expect(merged.writes.map((w) => w.path)).toEqual(["/p"]);
  });

  it("a winning directory keeps later subtree entries", () => {
    const merged = mergeDiffs([
      diff([file("/p", 1)]),
      diff([dir("/p", 2), dir("/p/sub", 2), file("/p/sub/x", 2)]),
    ]);
    expect(merged.writes.map((w) => w.path).sort()).toEqual([
      "/p",
      "/p/sub",
      "/p/sub/x",
    ]);
  });

  it("metadataOnly contributes mode to a content winner (never discards content)", () => {
    const meta = file("/f", 2, "", { metadataOnly: true, mode: 0o755 });
    const mergedA = mergeDiffs([diff([file("/f", 1, "v1")]), diff([meta])]);
    expect(mergedA.writes[0].metadataOnly).toBeUndefined();
    expect(mergedA.writes[0].mode).toBe(0o755);
    expect(new TextDecoder().decode(mergedA.writes[0].content)).toBe("v1");

    const mergedB = mergeDiffs([
      diff([file("/f", 1, "", { metadataOnly: true, mode: 0o755 })]),
      diff([file("/f", 2, "v2", { mode: 0o600 })]),
    ]);
    expect(mergedB.writes[0].metadataOnly).toBeUndefined();
    expect(mergedB.writes[0].mode).toBe(0o600);
  });

  it("drops deletions nested under a surviving deletion", () => {
    const merged = mergeDiffs([diff([], [["/a", 1]]), diff([], [["/a/b", 2]])]);
    expect(merged.deletions).toEqual(["/a"]);
  });

  it("handles empty inputs without crashing", () => {
    expect(mergeDiffs([])).toEqual({ writes: [], deletions: [] });
    expect(mergeDiffs([diff(), diff()])).toEqual({
      writes: [],
      deletions: [],
    });
  });
});

describe("separator normalization (Windows-style paths)", () => {
  const bs = (p: string) => p.replace(/\//g, "\\");

  it("whiteout suppression works with backslash paths", () => {
    const merged = mergeDiffs([
      diff([file(bs("/out/f"), 1), dir(bs("/out"), 1)]),
      diff([], [[bs("/out"), 2]]),
    ]);
    expect(merged.writes).toEqual([]);
    expect(merged.deletions).toEqual([bs("/out")]);
  });

  it("later entries under a backslash whiteout resurrect", () => {
    const merged = mergeDiffs([
      diff([], [[bs("/out"), 2]]),
      diff([file(bs("/out/f"), 3)]),
    ]);
    expect(merged.deletions).toEqual([bs("/out")]);
    expect(merged.writes.map((w) => w.path)).toEqual([bs("/out/f")]);
  });

  it("scaffolding detection works with backslash paths", () => {
    // Ensured-parent dir (has descendant) must not outvote the whiteout.
    const merged = mergeDiffs([
      diff([], [[bs("/out"), 2]]),
      diff([dir(bs("/out"), 3), file(bs("/out/f"), 3)]),
    ]);
    expect(merged.deletions).toEqual([bs("/out")]);
    expect(merged.writes.map((w) => w.path)).toEqual([bs("/out/f")]);
  });

  it("nested deletions collapse with backslash paths", () => {
    const merged = mergeDiffs([
      diff([], [[bs("/a"), 1]]),
      diff([], [[bs("/a/b"), 2]]),
    ]);
    expect(merged.deletions).toEqual([bs("/a")]);
  });
});

describe("metadataOnly contributes to content winners (M5)", () => {
  it("content write + later metadataOnly merge into one entry", () => {
    const merged = mergeDiffs([
      diff([file("/f", 1, "content-v1", { mode: 0o644 })]),
      diff([file("/f", 2, "", { metadataOnly: true, mode: 0o755 })]),
    ]);
    expect(merged.writes).toHaveLength(1);
    const w = merged.writes[0];
    // Content survives; the later metadata (mode) is absorbed.
    expect(new TextDecoder().decode(w.content)).toBe("content-v1");
    expect(w.mode).toBe(0o755);
    expect(w.metadataOnly).toBeUndefined();
    expect(w.changedAt).toBe(2);
  });

  it("metadataOnly with no content write stands alone", () => {
    const merged = mergeDiffs([
      diff([file("/f", 2, "", { metadataOnly: true, mode: 0o755 })]),
    ]);
    expect(merged.writes[0].metadataOnly).toBe(true);
  });
});

describe("remaining merge-matrix cases", () => {
  const link = (path: string, changedAt: number): OverlayWrite => ({
    path,
    nodeType: "symlink",
    content: new TextEncoder().encode("/target"),
    mode: 0o777,
    mtime: new Date(0),
    changedAt,
  });

  it("a winning symlink drops every entry under its path", () => {
    const merged = mergeDiffs([
      diff([dir("/p/sub", 3), file("/p/sub/x", 3)]),
      diff([link("/p", 2)]),
    ]);
    expect(merged.writes.map((w) => w.path)).toEqual(["/p"]);
    expect(merged.writes[0].nodeType).toBe("symlink");
  });

  it("scaffolding with no surviving content never overrides a whiteout", () => {
    // B's ensured-parent /out (t3) is scaffolding for /out/f (t1),
    // which the whiteout (t2) suppresses — /out must stay deleted.
    const merged = mergeDiffs([
      diff([], [["/out", 2]]),
      diff([dir("/out", 3), file("/out/f", 1)]),
    ]);
    expect(merged.deletions).toEqual(["/out"]);
    expect(merged.writes).toEqual([]);
  });

  it("rejects a filesystem the template did not fork (foreign)", async () => {
    const { createVfsTemplate } = await import("../vfs-template.js");
    const { MountableFs } = await import("../mountable-fs/mountable-fs.js");
    const { InMemoryFs } = await import("../in-memory-fs/index.js");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-foreign-"));
    try {
      const tpl = createVfsTemplate({ mounts: [{ at: "/project", root }] });
      const foreign = new MountableFs({ base: new InMemoryFs() });
      expect(() => tpl.merge([foreign])).toThrow(/did not fork/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
