import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mergeDiffs } from "./merge.js";
import type { OverlayDiff } from "./overlay-fs.js";

/**
 * Sweep-specific cells and invariants. Sibling keys K+c with c < '/'
 * ('-', '.', space, '!'...) sort BETWEEN K and its descendants — the
 * class that broke the first sort+sweep (stack-of-ranges could not
 * express the gap). These tests pin the ancestor-enumeration fix and
 * the invariants any correct implementation must satisfy.
 */

const file = (path: string, changedAt: number, extra?: object) => ({
  path,
  nodeType: "file" as const,
  content: new Uint8Array([65]),
  mode: 0o644,
  mtime: new Date(0),
  changedAt,
  ...extra,
});

describe("mergeDiffs sibling-key regressions", () => {
  it("a winning leaf does NOT suppress a sibling whose name sorts before '/'", () => {
    const merged = mergeDiffs([
      { writes: [file("/x/a", 2)], deletions: [] },
      { writes: [file("/x/a-b", 1), file("/x/a/b", 1)], deletions: [] },
    ]);
    const paths = merged.writes.map((w) => w.path).sort();
    // /x/a-b is NOT under /x/a: survives. /x/a/b is under a winning
    // file: dropped (files cannot have children).
    expect(paths).toEqual(["/x/a", "/x/a-b"]);
  });

  it("a winning whiteout suppresses earlier descendants despite interleaved siblings", () => {
    const merged = mergeDiffs([
      { writes: [], deletions: ["/x/a"], deletionChangedAt: [5] },
      { writes: [file("/x/a-b", 1), file("/x/a/b", 1)], deletions: [] },
    ]);
    expect(merged.writes.map((w) => w.path)).toEqual(["/x/a-b"]);
    expect(merged.deletions).toEqual(["/x/a"]);
  });

  it("a deletion nested under a surviving deletion is dropped despite interleaved siblings", () => {
    const merged = mergeDiffs([
      {
        writes: [],
        deletions: ["/x/a", "/x/a-b", "/x/a/b"],
        deletionChangedAt: [5, 4, 3],
      },
    ]);
    expect(merged.deletions).toEqual(["/x/a", "/x/a-b"]);
  });

  it("handles names with spaces and unicode through the suppression path", () => {
    const merged = mergeDiffs([
      { writes: [], deletions: ["/x/dír"], deletionChangedAt: [5] },
      {
        writes: [file("/x/dír old/f", 1), file("/x/dír/f", 1)],
        deletions: [],
      },
    ]);
    expect(merged.writes.map((w) => w.path)).toEqual(["/x/dír old/f"]);
  });
});

describe("mergeDiffs pinned semantics cells", () => {
  it("the LATEST active whiteout (not the deepest) decides suppression", () => {
    const merged = mergeDiffs([
      { writes: [], deletions: ["/a"], deletionChangedAt: [5] },
      { writes: [], deletions: ["/a/b"], deletionChangedAt: [3] },
      { writes: [file("/a/b/f", 4)], deletions: [] },
    ]);
    // f (t=4) is strictly later than /a/b (t=3) but earlier than /a
    // (t=5): the max whiteout /a suppresses it.
    expect(merged.writes).toEqual([]);
  });

  it("metadataOnly later than a whiteout resurrects (chmod-after-delete)", () => {
    const merged = mergeDiffs([
      { writes: [], deletions: ["/f"], deletionChangedAt: [1] },
      {
        writes: [
          {
            path: "/f",
            nodeType: "file",
            content: new Uint8Array(0),
            metadataOnly: true,
            mode: 0o755,
            mtime: new Date(1000),
            changedAt: 2,
          },
        ],
        deletions: [],
      },
    ]);
    expect(merged.deletions).toEqual([]);
    expect(merged.writes.map((w) => [w.path, w.metadataOnly, w.mode])).toEqual([
      ["/f", true, 0o755],
    ]);
  });

  it("a whiteout later than metadataOnly wins (delete-after-chmod)", () => {
    const merged = mergeDiffs([
      {
        writes: [
          {
            path: "/f",
            nodeType: "file",
            content: new Uint8Array(0),
            metadataOnly: true,
            mode: 0o755,
            mtime: new Date(1000),
            changedAt: 1,
          },
        ],
        deletions: [],
      },
      { writes: [], deletions: ["/f"], deletionChangedAt: [2] },
    ]);
    expect(merged.writes).toEqual([]);
    expect(merged.deletions).toEqual(["/f"]);
  });

  it("ragged deletionChangedAt (shorter than deletions) counts as 0", () => {
    const merged = mergeDiffs([
      { writes: [], deletions: ["/a", "/b"], deletionChangedAt: [9] },
      { writes: [file("/b", 1)], deletions: [] },
    ]);
    // /a's stamp is 9 (given); /b's is missing → 0 → /b's write (t=1)
    // is strictly later → resurrects. /a stays deleted.
    expect(merged.deletions).toEqual(["/a"]);
    expect(merged.writes.map((w) => w.path)).toEqual(["/b"]);
  });

  it("a whiteout under a winning file leaf is suppressed with its subtree", () => {
    const merged = mergeDiffs([
      { writes: [file("/a", 3)], deletions: [] },
      { writes: [], deletions: ["/a/b"], deletionChangedAt: [5] },
      { writes: [file("/a/b/c", 9)], deletions: [] },
    ]);
    // The file at /a wins; nothing under it can exist — even a LATER
    // whiteout or write.
    expect(merged.writes.map((w) => w.path)).toEqual(["/a"]);
    expect(merged.deletions).toEqual([]);
  });

  it("a write/whiteout tie at the same path breaks by input order", () => {
    const early = mergeDiffs([
      { writes: [], deletions: ["/f"], deletionChangedAt: [5] },
      { writes: [file("/f", 5)], deletions: [] },
    ]);
    expect(early.writes.map((w) => w.path)).toEqual(["/f"]);
    const late = mergeDiffs([
      { writes: [file("/f", 5)], deletions: [] },
      { writes: [], deletions: ["/f"], deletionChangedAt: [5] },
    ]);
    expect(late.writes).toEqual([]);
    expect(late.deletions).toEqual(["/f"]);
  });
});

describe("mergeDiffs randomized invariants", () => {
  const seg = fc.constantFrom("a", "b", "a-b", "a.bak", "a old", "a!x", "c");
  const keyPath = fc
    .array(seg, { minLength: 1, maxLength: 4 })
    .map((s) => `/${s.join("/")}`);
  const write = fc
    .record({
      path: keyPath,
      nodeType: fc.constantFrom("file", "directory", "symlink"),
      changedAt: fc.nat({ max: 12 }),
    })
    .map((w) => ({
      ...w,
      content: w.nodeType === "file" ? new Uint8Array([65]) : undefined,
      target: w.nodeType === "symlink" ? "/t" : undefined,
      mode: 0o644,
      mtime: new Date(0),
    }));
  const diff = fc
    .record({
      writes: fc.array(write, { minLength: 0, maxLength: 6 }),
      deletions: fc.array(keyPath, { minLength: 0, maxLength: 3 }),
      stamps: fc.array(fc.nat({ max: 12 }), { minLength: 3, maxLength: 3 }),
    })
    .map((d) => ({
      writes: d.writes,
      deletions: d.deletions,
      deletionChangedAt: d.deletions.map((_, i) => d.stamps[i]),
    }));

  it("output satisfies the suppression invariants on every input", () => {
    fc.assert(
      fc.property(fc.array(diff, { minLength: 1, maxLength: 4 }), (ds) => {
        const m = mergeDiffs(ds as OverlayDiff[]);
        const isUnder = (p: string, ancestor: string) =>
          p.startsWith(`${ancestor}/`);
        // 1. No surviving write under a winning file/symlink.
        for (const w of m.writes) {
          if (w.nodeType !== "file" && w.nodeType !== "symlink") continue;
          for (const o of m.writes) {
            expect(isUnder(o.path, w.path)).toBe(false);
          }
        }
        // 2. No deletion strictly under another surviving deletion.
        for (const d of m.deletions) {
          for (const o of m.deletions) {
            if (d !== o) expect(isUnder(d, o)).toBe(false);
          }
        }
        // 3. One winner per path: no duplicate output paths.
        const paths = m.writes.map((w) => w.path);
        expect(new Set(paths).size).toBe(paths.length);
        // 4. Determinism: same input, byte-identical output.
        const again = mergeDiffs(ds as OverlayDiff[]);
        expect(again.writes.map((w) => w.path)).toEqual(paths);
        expect(again.deletions).toEqual(m.deletions);
      }),
      { numRuns: 2000, seed: 0x5eed },
    );
  });
});
