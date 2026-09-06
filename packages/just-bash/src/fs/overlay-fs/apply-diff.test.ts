import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDiffToRealFs } from "./apply.js";
import type { OverlayWrite } from "./overlay-fs.js";

const file = (
  path: string,
  content: string,
  extra: Partial<OverlayWrite> = {},
): OverlayWrite => ({
  path,
  nodeType: "file",
  content: new TextEncoder().encode(content),
  mode: 0o644,
  mtime: new Date("2001-02-03T04:05:06Z"),
  ...extra,
});

const dir = (path: string): OverlayWrite => ({
  path,
  nodeType: "directory",
  content: new Uint8Array(0),
  mode: 0o755,
  mtime: new Date("2001-02-03T04:05:06Z"),
});

describe("applyDiffToRealFs", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-diff-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  const p = (rel: string) => path.join(root, rel);

  it("writes files with ensured parents and restores mtime", () => {
    applyDiffToRealFs({
      writes: [file(p("a/b/c.txt"), "deep")],
      deletions: [],
    });
    expect(fs.readFileSync(p("a/b/c.txt"), "utf8")).toBe("deep");
    expect(fs.statSync(p("a/b/c.txt")).mtime).toEqual(
      new Date("2001-02-03T04:05:06Z"),
    );
  });

  it("applies deletions before writes (resurrection order)", () => {
    fs.mkdirSync(p("out"), { recursive: true });
    fs.writeFileSync(p("out/old.txt"), "old");
    // Merged semantics: /out deleted, then resurrected with only f.
    applyDiffToRealFs({
      writes: [file(p("out/f.txt"), "new")],
      deletions: [p("out")],
    });
    expect(fs.existsSync(p("out/old.txt"))).toBe(false);
    expect(fs.readFileSync(p("out/f.txt"), "utf8")).toBe("new");
  });

  it("handles nested deletions without crashing", () => {
    fs.mkdirSync(p("x/y/z"), { recursive: true });
    fs.writeFileSync(p("x/y/z/f.txt"), "f");
    applyDiffToRealFs({
      writes: [],
      deletions: [p("x"), p("x/y/z/f.txt")],
    });
    expect(fs.existsSync(p("x"))).toBe(false);
  });

  it("metadataOnly applies mode (POSIX) and never touches content", () => {
    fs.writeFileSync(p("run.sh"), "echo hi\n");
    applyDiffToRealFs({
      writes: [file(p("run.sh"), "", { metadataOnly: true, mode: 0o755 })],
      deletions: [],
    });
    expect(fs.readFileSync(p("run.sh"), "utf8")).toBe("echo hi\n");
    if (process.platform !== "win32") {
      expect(fs.statSync(p("run.sh")).mode & 0o777).toBe(0o755);
    }
  });

  it("explicit directory entries apply shallowest-first", () => {
    applyDiffToRealFs({
      writes: [file(p("d/sub/f.txt"), "x"), dir(p("d")), dir(p("d/sub"))],
      deletions: [],
    });
    expect(fs.statSync(p("d/sub")).isDirectory()).toBe(true);
    expect(fs.readFileSync(p("d/sub/f.txt"), "utf8")).toBe("x");
  });
});

describe("directory metadata at apply", () => {
  it("applies mode and mtime to directory entries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-dir-meta-"));
    try {
      const target = path.join(root, "docs");
      const when = new Date("2002-03-04T05:06:07Z");
      applyDiffToRealFs({
        writes: [
          {
            path: target,
            nodeType: "directory",
            content: new Uint8Array(0),
            mode: 0o700,
            mtime: when,
          },
        ],
        deletions: [],
      });
      if (process.platform !== "win32") {
        expect(fs.statSync(target).mode & 0o777).toBe(0o700);
      }
      expect(fs.statSync(target).mtime).toEqual(when);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe("path normalization guard", () => {
  it("rejects non-normalized paths (.. escapes) loudly", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-norm-"));
    try {
      expect(() =>
        applyDiffToRealFs({
          writes: [
            {
              path: `${root}/../escape.txt`,
              nodeType: "file",
              content: new TextEncoder().encode("x"),
              mode: 0o644,
              mtime: new Date(0),
            },
          ],
          deletions: [],
        }),
      ).toThrow(/not normalized/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe("symlink application", () => {
  it.skipIf(process.platform === "win32")(
    "recreates symlinks from the change set",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-link-"));
      try {
        fs.writeFileSync(path.join(root, "real.txt"), "content");
        applyDiffToRealFs({
          writes: [
            {
              path: path.join(root, "link.txt"),
              nodeType: "symlink",
              content: new TextEncoder().encode("real.txt"),
              mode: 0o777,
              mtime: new Date(0),
            },
          ],
          deletions: [],
        });
        expect(fs.readlinkSync(path.join(root, "link.txt"))).toBe("real.txt");
        expect(fs.readFileSync(path.join(root, "link.txt"), "utf8")).toBe(
          "content",
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      }
    },
  );
});
