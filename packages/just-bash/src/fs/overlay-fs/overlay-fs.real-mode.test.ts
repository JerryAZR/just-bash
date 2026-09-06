import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OverlayFs } from "./index.js";

// libuv reports no execute bits on Windows: real directories stat as
// 0o40666. POSIX runtimes behind the fs bridge (the python worker's
// Emscripten VFS masks mode & 0o777) enforce those bits — a 0o666 dir is
// untraversable (chdir/listdir/open EACCES). The overlay normalizes real
// directory modes to 0o755 on Windows, matching DEFAULT_DIR_MODE so
// lower and upper directories present uniformly.
describe("real-dir mode normalization (win32)", () => {
  const roots: string[] = [];
  const makeRoot = () => {
    const root = mkdtempSync(path.join(tmpdir(), "overlay-mode-"));
    roots.push(root);
    mkdirSync(path.join(root, "sub"));
    writeFileSync(path.join(root, "sub", "f.txt"), "data");
    return root;
  };
  afterAll(() => {
    for (const r of roots)
      rmSync(r, { recursive: true, force: true, maxRetries: 3 });
  });

  it.skipIf(process.platform !== "win32")(
    "reports 0o755 permission bits for real-backed directories",
    async () => {
      const fs = new OverlayFs({ root: makeRoot(), mountPoint: "/" });
      const st = await fs.stat("/sub");
      expect(st.isDirectory).toBe(true);
      expect(st.mode & 0o777).toBe(0o755);
      const lst = await fs.lstat("/sub");
      expect(lst.mode & 0o777).toBe(0o755);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "leaves real file modes as reported",
    async () => {
      const root = makeRoot();
      const fs = new OverlayFs({ root, mountPoint: "/" });
      const st = await fs.stat("/sub/f.txt");
      expect(st.isFile).toBe(true);
      // Files are NOT normalized: the overlay reports exactly what the
      // real lstat reported.
      const raw = lstatSync(path.join(root, "sub", "f.txt")).mode;
      expect(st.mode).toBe(raw);
    },
  );

  it("upper-layer directories stay 0o755 on every platform", async () => {
    const fs = new OverlayFs({ root: makeRoot(), mountPoint: "/" });
    await fs.mkdir("/upper");
    const st = await fs.stat("/upper");
    expect(st.mode & 0o777).toBe(0o755);
  });
});
