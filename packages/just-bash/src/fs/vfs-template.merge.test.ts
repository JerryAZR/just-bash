import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OverlayDiff, OverlayWrite } from "./overlay-fs/overlay-fs.js";
import { createVfsTemplate, type VfsTemplate } from "./vfs-template.js";

/**
 * Merge contract suite — pins PROMISED behavior only (see the merge
 * doc in vfs-template.ts): ordering, deletion semantics, structural
 * invariants, metadataOnly rules, clean unions, determinism,
 * completion, containment. Stamps come from plain-diff sources, so no
 * wall-clock sleeps anywhere.
 */

const file = (
  path: string,
  changedAt: number,
  extra?: Partial<OverlayWrite>,
): OverlayWrite => ({
  path,
  nodeType: "file",
  content: new TextEncoder().encode("x"),
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

const del = (path: string, changedAt: number): OverlayDiff => ({
  writes: [],
  deletions: [path],
  deletionChangedAt: [changedAt],
});

describe("template merge contract", () => {
  let projectRoot: string;
  let tpl: VfsTemplate;
  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-merge-"));
    fs.writeFileSync(path.join(projectRoot, "app.ts"), "v0\n");
    tpl = createVfsTemplate({
      mounts: [{ at: "/project", root: projectRoot }],
    });
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 3 });
  });

  const vfsDiff = (m: Awaited<ReturnType<VfsTemplate["merge"]>>) =>
    m.diff({ space: "vfs" });

  it("latest entry per path wins; ties break by source order", async () => {
    const merged = vfsDiff(
      await tpl.merge([
        {
          writes: [file("/project/f", 1), file("/project/f", 3)],
          deletions: [],
        },
        { writes: [file("/project/g", 2)], deletions: [] },
      ]),
    );
    expect(merged.writes.map((w) => w.path)).toEqual([
      "/project/f",
      "/project/g",
    ]);
    expect(merged.writes[0].changedAt).toBe(3);

    // Ties use a BASE-existing path: a whiteout over a base-missing
    // path is pruned by stock diff() (nothing on disk to delete), which
    // would make the tie invisible in the output.
    const tieAB = vfsDiff(
      await tpl.merge([
        { writes: [file("/project/app.ts", 5)], deletions: [] },
        { writes: [], deletions: ["/project/app.ts"], deletionChangedAt: [5] },
      ]),
    );
    expect(tieAB.writes).toEqual([]);
    expect(tieAB.deletions).toEqual(["/project/app.ts"]);
    const tieBA = vfsDiff(
      await tpl.merge([
        { writes: [], deletions: ["/project/app.ts"], deletionChangedAt: [5] },
        { writes: [file("/project/app.ts", 5)], deletions: [] },
      ]),
    );
    expect(tieBA.writes.map((w) => w.path)).toEqual(["/project/app.ts"]);
    expect(tieBA.deletions).toEqual([]);
  });

  it("deletion removes the subtree as of its stamp; later content resurrects", async () => {
    const merged = vfsDiff(
      await tpl.merge([
        { writes: [file("/project/out/old", 1)], deletions: [] },
        del("/project/out", 2),
        { writes: [file("/project/out/new", 3)], deletions: [] },
      ]),
    );
    const paths = merged.writes.map((w) => w.path).sort();
    expect(paths).toContain("/project/out/new");
    expect(paths).not.toContain("/project/out/old");
    // The merged instance shows the resurrected content.
    const instance = await tpl.merge([
      { writes: [file("/project/out/old", 1)], deletions: [] },
      del("/project/out", 2),
      { writes: [file("/project/out/new", 3)], deletions: [] },
    ]);
    expect(await instance.readFile("/project/out/new")).toBe("x");
    expect(await instance.exists("/project/out/old")).toBe(false);
  });

  it("a file write over another fork's directory is refused, contained", async () => {
    const merged = vfsDiff(
      await tpl.merge([
        {
          writes: [file("/project/x/a-b", 1), file("/project/x/a/b", 1)],
          deletions: [],
        },
        { writes: [file("/project/x/a", 2)], deletions: [] },
      ]),
    );
    const paths = merged.writes.map((w) => w.path).sort();
    // The stock filesystem refuses a file over the directory /x/a
    // (EISDIR) — the conflicting write is skipped, the anomaly is
    // contained to /x/a, and the output trivially has no children
    // under files. /x/a-b (NOT under /x/a) is unaffected.
    expect(paths).toContain("/project/x/a/b");
    expect(paths).toContain("/project/x/a-b");
  });

  it("no nested deletions in the output", async () => {
    fs.mkdirSync(path.join(projectRoot, "x", "a"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "x", "a", "b"), "nested\n");
    fs.writeFileSync(path.join(projectRoot, "x", "a-b"), "sibling\n");
    const merged = vfsDiff(
      await tpl.merge([
        {
          writes: [],
          deletions: ["/project/x/a", "/project/x/a-b", "/project/x/a/b"],
          deletionChangedAt: [5, 4, 3],
        },
      ]),
    );
    expect(merged.deletions.sort()).toEqual(["/project/x/a", "/project/x/a-b"]);
  });

  it("metadataOnly on a base file is kept for apply to resolve", async () => {
    const instance = await tpl.merge([
      {
        writes: [
          file("/project/app.ts", 2, {
            metadataOnly: true,
            mode: 0o755,
            mtime: new Date(1000),
          }),
        ],
        deletions: [],
      },
    ]);
    const merged = instance.diff({ space: "vfs" });
    expect(merged.writes.map((w) => [w.path, w.metadataOnly, w.mode])).toEqual([
      ["/project/app.ts", true, 0o755],
    ]);
    tpl.apply(instance.diff({ space: "host" }));
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(projectRoot, "app.ts")).mode & 0o777).toBe(
        0o755,
      );
    } else {
      expect(fs.existsSync(path.join(projectRoot, "app.ts"))).toBe(true);
    }
  });

  it("metadataOnly after a whiteout is skipped (chmod a deleted file)", async () => {
    fs.writeFileSync(path.join(projectRoot, "f"), "base\n");
    const merged = vfsDiff(
      await tpl.merge([
        del("/project/f", 1),
        {
          writes: [file("/project/f", 2, { metadataOnly: true, mode: 0o755 })],
          deletions: [],
        },
      ]),
    );
    expect(merged.writes).toEqual([]);
    expect(merged.deletions).toEqual(["/project/f"]);
  });

  it("older diff with MORE ops cannot overwrite a newer diff's colliding write", async () => {
    // The replay must be SEQUENTIAL: if forks ran concurrently on the
    // shared cumulative overlay, the older diff's extra ops would let
    // its write land LAST at the colliding path — wrong content under
    // a wrong stamp. Ordering is structural, not scheduling luck.
    const merged = await tpl.merge([
      {
        writes: [
          dir("/project/a", 10),
          dir("/project/b", 10),
          dir("/project/c", 10),
          file("/project/f", 10, {
            content: new TextEncoder().encode("old"),
          }),
        ],
        deletions: [],
      },
      {
        writes: [
          file("/project/f", 20, {
            content: new TextEncoder().encode("new"),
          }),
        ],
        deletions: [],
      },
    ]);
    expect(await merged.readFile("/project/f", "utf8")).toBe("new");
    expect(
      vfsDiff(merged).writes.find((w) => w.path === "/project/f")?.changedAt,
    ).toBe(20);
  });

  it("resurrection whiteouts carry the deleting entry's stamp, never wall clock", async () => {
    // Lower has /project/p/keep; deleting /project/p then writing under
    // it resurrects the dir and mints a whiteout for keep. That whiteout
    // competes in merges against other forks' writes AS the deletion —
    // its stamp must be the deletion's, not Date.now().
    fs.mkdirSync(path.join(projectRoot, "p"));
    fs.writeFileSync(path.join(projectRoot, "p", "keep"), "k");
    const merged = vfsDiff(
      await tpl.merge([
        { writes: [], deletions: ["/project/p"], deletionChangedAt: [1] },
        { writes: [file("/project/p/f", 2)], deletions: [] },
      ]),
    );
    const idx = merged.deletions.indexOf("/project/p/keep");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(merged.deletionChangedAt?.[idx]).toBe(1);
    // Every output stamp comes from the input stamp space.
    for (const w of merged.writes) {
      expect([1, 2]).toContain(w.changedAt);
    }
  });

  it("a content-free metadataOnly entry applies nothing and asserts no stamp", async () => {
    const merged = vfsDiff(
      await tpl.merge([
        { writes: [file("/project/f", 1)], deletions: [] },
        {
          writes: [
            {
              path: "/project/f",
              nodeType: "file" as const,
              content: new Uint8Array(0),
              mode: undefined as unknown as number,
              mtime: undefined as unknown as Date,
              metadataOnly: true,
              changedAt: 9,
            },
          ],
          deletions: [],
        },
      ]),
    );
    // The no-op entry must not move /project/f's stamp to 9.
    expect(merged.writes.find((w) => w.path === "/project/f")?.changedAt).toBe(
      1,
    );
  });

  it("an explicit dir entry's metadata lands over an ensured parent", async () => {
    // A child write replaying first ensures /project/d with default
    // mode; the explicit dir entry (later stamp) must still apply its
    // metadata (mkdir -p semantics), not die EEXIST.
    const merged = vfsDiff(
      await tpl.merge([
        { writes: [file("/project/d/f", 1)], deletions: [] },
        {
          writes: [
            {
              path: "/project/d",
              nodeType: "directory" as const,
              content: new Uint8Array(0),
              mode: 0o700,
              mtime: new Date(0),
              changedAt: 2,
            },
          ],
          deletions: [],
        },
      ]),
    );
    const d = merged.writes.find((w) => w.path === "/project/d");
    expect(d?.mode).toBe(0o700);
    expect(d?.changedAt).toBe(2);
  });

  it("a write refused after minting parents leaves deterministic stamps", async () => {
    // ENOSPC after ensureParentDirs: the parents were minted (they
    // appear in the output) and must carry the failed op's stamp —
    // never wall clock. The failed file itself is absent.
    const tight = createVfsTemplate({
      mounts: [{ at: "/project", root: projectRoot }],
      maxMemoryBytes: 64,
    });
    const source = {
      writes: [
        {
          path: "/project/a/b/big",
          nodeType: "file" as const,
          content: new Uint8Array(1024),
          mode: 0o644,
          mtime: new Date(0),
          changedAt: 7,
        },
      ],
      deletions: [],
    };
    const run = async () => vfsDiff(await tight.merge([source]));
    const merged = await run();
    expect(
      merged.writes.find((w) => w.path === "/project/a/b/big"),
    ).toBeUndefined();
    expect(merged.writes.map((w) => w.path).sort()).toEqual([
      "/project/a",
      "/project/a/b",
    ]);
    for (const w of merged.writes) {
      expect(w.changedAt).toBe(7);
    }
    expect(JSON.stringify(await run())).toBe(JSON.stringify(merged));
  });

  it("symlink write entries are refused by the stock op and skipped, contained", async () => {
    // Template overlays are default-deny (allowSymlinks: false), so a
    // foreign vfs diff's symlink entry EPERMs at replay: skipped like
    // any refusal, and it never reaches the output.
    const merged = vfsDiff(
      await tpl.merge([
        {
          writes: [
            {
              path: "/project/link",
              nodeType: "symlink" as const,
              content: new TextEncoder().encode("/outside"),
              mode: 0o777,
              mtime: new Date(0),
              changedAt: 1,
            },
            file("/project/f", 2),
          ],
          deletions: [],
        },
      ]),
    );
    expect(merged.writes.map((w) => w.path)).toEqual(["/project/f"]);
  });

  it("byte-identical output for identical input", async () => {
    const sources = (): OverlayDiff[] => [
      {
        writes: [file("/project/x/a-b", 1), file("/project/x/a/b", 1)],
        deletions: [],
      },
      del("/project/x/a", 5),
      {
        writes: [file("/project/x/a/c", 6), dir("/project/x/d", 2)],
        deletions: [],
      },
    ];
    const a = vfsDiff(await tpl.merge(sources()));
    const b = vfsDiff(await tpl.merge(sources()));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("containment: a conflicting entry changes output only in its subtree", async () => {
    const base = (): OverlayDiff[] => [
      {
        writes: [file("/project/a/keep", 1), file("/project/b/keep", 1)],
        deletions: [],
      },
    ];
    const m0 = vfsDiff(await tpl.merge(base()));
    const m1 = vfsDiff(await tpl.merge([...base(), del("/project/a", 9)]));
    // /b is untouched by the /a conflict.
    expect(m1.writes.map((w) => w.path)).toContain("/project/b/keep");
    expect(m1.writes.map((w) => w.path)).not.toContain("/project/a/keep");
    expect(m0.writes.map((w) => w.path)).toContain("/project/a/keep");
  });

  it("resurrection whiteouts carry the deleting fork's stamp", async () => {
    // keep lives in the lower (on disk). Fork B modifies it at t1;
    // fork A does a clean rebuild (rm -rf /p && mkdir /p) at t2 > t1.
    fs.mkdirSync(path.join(projectRoot, "p"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "p", "keep"), "original");
    const b = tpl.fork();
    await b.writeFile("/project/p/keep", "modified-by-b");
    await new Promise((r) => setTimeout(r, 5));
    const a = tpl.fork();
    await a.rm("/project/p", { recursive: true });
    await a.mkdir("/project/p");
    const aDiff = await a.diff({ space: "vfs" });
    const aStamp =
      aDiff.deletionChangedAt?.[aDiff.deletions.indexOf("/project/p/keep")];

    const merged = vfsDiff(await tpl.merge([b, a]));
    // A deleted /p/keep after B wrote it: the resurrection whiteout
    // suppresses B's write; the resurrected /p dir survives.
    expect(merged.deletions).toEqual(["/project/p/keep"]);
    expect(merged.writes.map((w) => w.path)).toEqual(["/project/p"]);
    // The whiteout carries A's deletion stamp exactly — never a
    // wall-clock time from the replay.
    expect(aStamp).toBeDefined();
    expect(merged.deletionChangedAt?.[0]).toBe(aStamp);
  });

  it("explicit mkdir after a whiteout resurrects", async () => {
    fs.mkdirSync(path.join(projectRoot, "p"), { recursive: true });
    const a = tpl.fork();
    await a.rm("/project/p", { recursive: true });
    await new Promise((r) => setTimeout(r, 5));
    const b = tpl.fork();
    await b.mkdir("/project/p/x", { recursive: true });

    const merged = vfsDiff(await tpl.merge([a, b]));
    // B's mkdir is LATER than A's whiteout: /p/x must survive.
    expect(merged.writes.map((w) => w.path).sort()).toContain("/project/p/x");
    const instance = await tpl.merge([a, b]);
    expect(await instance.exists("/project/p/x")).toBe(true);
  });
});

describe("template merge properties", () => {
  let projectRoot: string;
  let tpl: VfsTemplate;
  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-prop-"));
    tpl = createVfsTemplate({
      mounts: [{ at: "/project", root: projectRoot }],
    });
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 3 });
  });

  const seg = fc.constantFrom("a", "b", "a-b", "a.bak", "a old", "a!x", "c");
  const keyPath = fc
    .array(seg, { minLength: 1, maxLength: 4 })
    .map((s) => `/project/${s.join("/")}`);
  const write = fc
    .record({
      path: keyPath,
      nodeType: fc.constantFrom("file", "directory", "symlink"),
      changedAt: fc.nat({ max: 12 }),
    })
    .map((w) => ({
      ...w,
      content:
        w.nodeType === "symlink"
          ? new TextEncoder().encode("/t")
          : w.nodeType === "file"
            ? new Uint8Array([65])
            : new Uint8Array(0),
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

  it("completes on adversarial input and preserves invariants", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(diff, { minLength: 1, maxLength: 4 }),
        async (ds) => {
          const merged = await tpl.merge(ds as OverlayDiff[]);
          const out = merged.diff({ space: "vfs" });
          const isUnder = (p: string, anc: string) => p.startsWith(`${anc}/`);
          // No surviving write under a winning file/symlink.
          for (const w of out.writes) {
            if (w.nodeType !== "file" && w.nodeType !== "symlink") continue;
            for (const o of out.writes) {
              expect(isUnder(o.path, w.path)).toBe(false);
            }
          }
          // No deletion strictly under another surviving deletion.
          for (const d of out.deletions) {
            for (const o of out.deletions) {
              if (d !== o) expect(isUnder(d, o)).toBe(false);
            }
          }
          // One winner per path; determinism.
          const paths = out.writes.map((w) => w.path);
          expect(new Set(paths).size).toBe(paths.length);
          const again = (await tpl.merge(ds as OverlayDiff[])).diff({
            space: "vfs",
          });
          expect(JSON.stringify(again)).toBe(JSON.stringify(out));
        },
      ),
      { numRuns: 200, seed: 0xc0ffee },
    );
    // 200 async property runs with double merges legitimately exceed the
    // default 5s timeout under full-suite parallel load.
  }, 60_000);
});
