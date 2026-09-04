import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayFs } from "./overlay-fs.js";

/**
 * Harness-flow benchmarks: exec → diff → sync (flow A) and
 * exec → sync → diff → sync (flow B), phase-timed separately. The host
 * "apply" step is intentionally excluded (caller-side). Run on both
 * experiment branches to compare population-at-resurrection against
 * expansion-at-report.
 */

const BODY = "x".repeat(120);

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-flows-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const makeOverlay = () =>
  new OverlayFs({ root: tempDir, mountPoint: "/p", allowSymlinks: true });

function writeDiskFiles(prefix: string, count: number, depth: number): void {
  for (let i = 0; i < count; i++) {
    const rel = Array.from(
      { length: depth },
      (_, d) => `d${(i >> (d * 4)) % 16}`,
    ).join("/");
    const dir = path.join(tempDir, prefix, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `f${i}.txt`), BODY);
  }
}

class Timer {
  exec = 0;
  diff = 0;
  sync1 = 0;
  sync2 = 0;
  async time(
    k: "exec" | "diff" | "sync1" | "sync2",
    fn: () => Promise<unknown>,
  ) {
    const t0 = performance.now();
    await fn();
    this[k] += Math.round(performance.now() - t0);
  }
  report(name: string, note: string): void {
    console.log(
      `PERF ${name}: exec=${this.exec}ms diff=${this.diff}ms sync1=${this.sync1}ms sync2=${this.sync2}ms (${note})`,
    );
  }
}

/** exec → diff → sync */
async function flowA(overlay: OverlayFs, t: Timer): Promise<void> {
  await t.time("diff", async () => overlay.diff());
  await t.time("sync1", async () => overlay.sync());
}

describe("OverlayFs harness flows", () => {
  it(
    "per-turn: delete-recreate cycles with flow A after each",
    { timeout: 300_000 },
    async () => {
      writeDiskFiles("pkg", 300, 2);
      const overlay = makeOverlay();
      const t = new Timer();
      for (let cycle = 0; cycle < 5; cycle++) {
        await t.time("exec", async () => {
          await overlay.rm("/p/pkg", { recursive: true });
          for (let i = 0; i < 300; i++) {
            const rel = `d${i % 16}/d${(i >> 4) % 16}`;
            await overlay.writeFile(
              `/p/pkg/${rel}/f${i}.txt`,
              `${BODY}${cycle}`,
            );
          }
        });
        await flowA(overlay, t);
      }
      t.report("s1-per-turn:flowA", "5 cycles x 300 files");
      // Recreate used the same paths, so net deletions are zero; the
      // pending state is the writes.
      expect(overlay.diff().writes.length).toBeGreaterThan(0);
    },
  );

  it(
    "end-of-session: delete-recreate cycles, flow A once at the end",
    { timeout: 300_000 },
    async () => {
      writeDiskFiles("pkg", 300, 2);
      const overlay = makeOverlay();
      const t = new Timer();
      for (let cycle = 0; cycle < 5; cycle++) {
        await t.time("exec", async () => {
          await overlay.rm("/p/pkg", { recursive: true });
          for (let i = 0; i < 300; i++) {
            const rel = `d${i % 16}/d${(i >> 4) % 16}`;
            await overlay.writeFile(
              `/p/pkg/${rel}/f${i}.txt`,
              `${BODY}${cycle}`,
            );
          }
        });
      }
      await flowA(overlay, t);
      t.report("s2-end-of-session:flowA", "5 cycles x 300 files");
      expect(overlay.diff().writes.length).toBeGreaterThan(0);
    },
  );

  it(
    "node-modules-scale: rm -rf of 10k tree, partial recreate, flow A",
    { timeout: 300_000 },
    async () => {
      writeDiskFiles("deps", 10000, 3);
      const overlay = makeOverlay();
      const t = new Timer();
      await t.time("exec", async () => {
        await overlay.rm("/p/deps", { recursive: true });
        for (let i = 0; i < 500; i++) {
          // Recreate into 5 of the 16 top-level subdirs.
          await overlay.writeFile(`/p/deps/d${i % 5}/d0/d0/new${i}.txt`, BODY);
        }
      });
      await flowA(overlay, t);
      t.report("s3-node-modules:flowA", "10k deleted, 500 recreated");
      expect(overlay.diff().deletions.length).toBeGreaterThan(100);
    },
  );

  it(
    "flow B: out-of-band application, reconcile before reporting",
    { timeout: 300_000 },
    async () => {
      writeDiskFiles("src", 300, 1);
      const overlay = makeOverlay();
      const t = new Timer();
      let pendingBefore = 0;
      await t.time("exec", async () => {
        for (let i = 0; i < 300; i++) {
          await overlay.writeFile(`/p/src/d${i % 16}/f${i}.txt`, `${BODY}v2`);
        }
      });
      // Simulate the host applying half the writes out-of-band.
      for (let i = 0; i < 150; i++) {
        fs.writeFileSync(
          path.join(tempDir, "src", `d${i % 16}`, `f${i}.txt`),
          `${BODY}v2`,
        );
      }
      const fileWrites = () =>
        overlay.diff().writes.filter((w) => w.nodeType === "file").length;
      pendingBefore = fileWrites();
      let reported = 0;
      await t.time("sync1", async () => overlay.sync());
      await t.time("diff", async () => {
        reported = fileWrites();
      });
      await t.time("sync2", async () => overlay.sync());
      t.report("s4-flowB", "300 writes, 150 applied out-of-band");
      expect(pendingBefore).toBe(300);
      expect(reported).toBe(150);
    },
  );
});
