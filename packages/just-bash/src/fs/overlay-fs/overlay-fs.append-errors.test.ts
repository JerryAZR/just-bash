import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayFs } from "./overlay-fs.js";

/**
 * Error propagation on append: reading the lower-layer content can fail
 * (oversized file, ELOOP, EACCES). Those failures must surface — an append
 * that silently starts from an empty buffer would report truncated content
 * in diff() for the host to apply to disk.
 */
describe("OverlayFs append error propagation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-append-"));
    fs.writeFileSync(path.join(tempDir, "big.txt"), "0123456789abcdef");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("surfaces EFBIG when the lower file exceeds maxFileReadSize", async () => {
    const overlay = new OverlayFs({
      root: tempDir,
      mountPoint: "/p",
      maxFileReadSize: 8,
    });

    await expect(overlay.appendFile("/p/big.txt", "more")).rejects.toThrow(
      /EFBIG/,
    );
    // The failed append must not leave a phantom truncated write behind.
    expect(overlay.diff().writes).toEqual([]);
  });

  it("appends normally when the lower file fits", async () => {
    const overlay = new OverlayFs({
      root: tempDir,
      mountPoint: "/p",
      maxFileReadSize: 1024,
    });

    await overlay.appendFile("/p/big.txt", "more");
    await expect(overlay.readFile("/p/big.txt")).resolves.toBe(
      "0123456789abcdefmore",
    );
  });

  it("creates a new file when the target does not exist", async () => {
    const overlay = new OverlayFs({ root: tempDir, mountPoint: "/p" });

    await overlay.appendFile("/p/new.txt", "fresh");
    await expect(overlay.readFile("/p/new.txt")).resolves.toBe("fresh");
  });
});
