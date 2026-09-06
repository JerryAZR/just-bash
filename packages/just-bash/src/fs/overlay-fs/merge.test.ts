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

  it("metadataOnly merges as metadata; a content winner overrides it", () => {
    const meta = file("/f", 2, "", { metadataOnly: true, mode: 0o755 });
    const mergedA = mergeDiffs([diff([file("/f", 1, "v1")]), diff([meta])]);
    expect(mergedA.writes[0].metadataOnly).toBe(true);
    expect(mergedA.writes[0].mode).toBe(0o755);

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
