import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayFs } from "./overlay-fs.js";

/**
 * Wall-clock benchmarks for OverlayFs workloads that mirror real agent
 * sessions. Measurement-focused: every workload prints
 *   PERF <workload>: best=<ms>ms runs=[...]
 * and asserts only functional sanity, never timing thresholds (CI-safe).
 *
 * Workloads:
 * - explore: recursive traversal + stat + read over a project tree
 * - edit-churn: copy-up writes and append-heavy logs
 * - delete-heavy: rm -rf of a large tree, then keep working
 * - delete-recreate: repeated rm -rf + rebuild cycles
 * - deep-stat: stat/exists storm on deep paths
 * - get-all-paths: full scan after a mixed session
 */

const BODY = "x".repeat(120);
const ITERS = 3;

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-perf-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const makeOverlay = () =>
  new OverlayFs({ root: tempDir, mountPoint: "/p", allowSymlinks: true });

function diskRelPath(i: number, depth: number): string {
  return Array.from(
    { length: depth },
    (_, d) => `d${(i >> (d * 4)) % 16}`,
  ).join("/");
}

function writeDiskFiles(prefix: string, count: number, depth: number): void {
  for (let i = 0; i < count; i++) {
    const dir = path.join(tempDir, prefix, diskRelPath(i, depth));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `f${i}.txt`), BODY);
  }
}

async function timed(name: string, fn: () => Promise<void>): Promise<void> {
  const runs: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    await fn();
    runs.push(Math.round(performance.now() - t0));
  }
  console.log(`PERF ${name}: best=${Math.min(...runs)}ms runs=[${runs}]`);
}

/** Recursively readdir the overlay, stat every entry found. */
async function walkAndStat(overlay: OverlayFs, dir: string): Promise<number> {
  let count = 0;
  const entries = await overlay.readdirWithFileTypes(dir);
  for (const e of entries) {
    const p = dir === "/" ? `/${e.name}` : `${dir}/${e.name}`;
    count++;
    await overlay.stat(p);
    if (e.isDirectory) count += await walkAndStat(overlay, p);
  }
  return count;
}

describe("OverlayFs performance", () => {
  it(
    "explore: traversal + stat + read over a project tree",
    { timeout: 180_000 },
    async () => {
      writeDiskFiles("src", 1200, 3);
      writeDiskFiles("node_modules", 800, 4);
      const overlay = makeOverlay();
      let seen = 0;
      await timed("explore", async () => {
        seen = await walkAndStat(overlay, "/p");
        for (let i = 0; i < 200; i++) {
          await overlay.readFile(
            `/p/node_modules/${diskRelPath(i, 4)}/f${i}.txt`,
          );
        }
      });
      expect(seen).toBeGreaterThan(2000);
    },
  );

  it(
    "edit-churn: copy-up writes and append-heavy logs",
    { timeout: 180_000 },
    async () => {
      writeDiskFiles("src", 400, 2);
      const overlay = makeOverlay();
      await timed("edit-churn", async () => {
        for (let i = 0; i < 400; i++) {
          await overlay.writeFile(
            `/p/src/${diskRelPath(i, 2)}/f${i}.txt`,
            BODY.repeat(2),
          );
        }
        for (let log = 0; log < 20; log++) {
          for (let line = 0; line < 25; line++) {
            await overlay.appendFile(`/p/src/d0/d0/f${log}.txt`, BODY);
          }
        }
      });
      expect(await overlay.readFile("/p/src/d0/d0/f0.txt")).toHaveLength(
        120 * 27,
      );
    },
  );

  it(
    "delete-heavy: rm -rf of a large tree, then keep working",
    { timeout: 180_000 },
    async () => {
      writeDiskFiles("deps", 5000, 3);
      writeDiskFiles("src", 300, 2);
      const overlay = makeOverlay();
      await overlay.rm("/p/deps", { recursive: true });
      expect(await overlay.exists("/p/deps")).toBe(false);
      await timed("delete-heavy:post-rm-work", async () => {
        for (let i = 0; i < 300; i++) {
          await overlay.readdir("/p/src");
          await overlay.stat(`/p/src/d${i % 16}`);
          await overlay.exists(`/p/deps/d0/f${i}.txt`);
        }
      });
      const overlay2 = makeOverlay();
      await timed("delete-heavy:rm-rf-5k", async () => {
        // Fresh overlay per run: the disk tree persists, so each iteration
        // measures a complete rm -rf of the same 5k-file tree.
        const fresh = makeOverlay();
        await fresh.rm("/p/deps", { recursive: true });
      });
      await overlay2.stat("/p/src");
    },
  );

  it(
    "delete-recreate: repeated rm -rf + rebuild cycles",
    { timeout: 180_000 },
    async () => {
      writeDiskFiles("pkg", 500, 2);
      const overlay = makeOverlay();
      await timed("delete-recreate", async () => {
        for (let cycle = 0; cycle < 10; cycle++) {
          await overlay.rm("/p/pkg", { recursive: true });
          for (let i = 0; i < 500; i++) {
            await overlay.writeFile(
              `/p/pkg/d${i % 16}/d${(i >> 4) % 16}/f${i}.txt`,
              BODY,
            );
          }
          await overlay.readdir("/p/pkg");
        }
      });
      expect(await overlay.readdir("/p/pkg")).toHaveLength(16);
    },
  );

  it(
    "deep-stat: stat/exists storm on deep shadowed paths",
    { timeout: 180_000 },
    async () => {
      const overlay = makeOverlay();
      const deep = `/p/${Array.from({ length: 12 }, (_, d) => `l${d}`).join("/")}`;
      for (let i = 0; i < 100; i++) {
        await overlay.writeFile(`${deep}/f${i}.txt`, BODY);
      }
      await timed("deep-stat", async () => {
        for (let i = 0; i < 3000; i++) {
          await overlay.stat(`${deep}/f${i % 100}.txt`);
          await overlay.exists(`${deep}/f${(i + 1) % 100}.txt`);
        }
      });
      expect((await overlay.stat(`${deep}/f0.txt`)).isFile).toBe(true);
    },
  );

  it(
    "get-all-paths: full scan after a mixed session",
    { timeout: 180_000 },
    async () => {
      writeDiskFiles("src", 1000, 2);
      writeDiskFiles("deps", 2000, 2);
      // Mount at "/": getAllPaths only scans the real FS under the mount
      // point, and "/" keeps the whole tree in scope.
      const overlay = new OverlayFs({
        root: tempDir,
        mountPoint: "/",
        allowSymlinks: true,
      });
      for (let i = 0; i < 300; i++) {
        await overlay.writeFile(`/src/d${i % 16}/d0/edit${i}.txt`, BODY);
      }
      await overlay.rm("/deps", { recursive: true });
      let total = 0;
      await timed("get-all-paths", async () => {
        for (let i = 0; i < 5; i++) {
          total = overlay.getAllPaths().length;
        }
      });
      expect(total).toBeGreaterThan(1000);
    },
  );
});
