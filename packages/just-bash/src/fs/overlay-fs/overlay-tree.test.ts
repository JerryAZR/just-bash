import { describe, expect, it } from "vitest";
import {
  type OverlayDirNode,
  type OverlayFileNode,
  OverlayTree,
} from "./overlay-tree.js";

const fileNode = (content: string): OverlayFileNode => ({
  type: "file",
  content: new TextEncoder().encode(content),
  mode: 0o644,
  mtime: new Date(),
});

const dirNode = (): OverlayDirNode => ({
  type: "directory",
  children: new Map(),
  mode: 0o755,
  mtime: new Date(),
});

describe("OverlayTree", () => {
  it("reports missing on an empty tree", () => {
    const tree = new OverlayTree(1024);
    expect(tree.descend("/a/b")).toMatchObject({
      kind: "missing",
      missingAt: 0,
    });
  });

  it("finds the root at /", () => {
    const tree = new OverlayTree(1024);
    const result = tree.descend("/");
    expect(result).toMatchObject({ kind: "found" });
    if (result.kind === "found") {
      expect(result.node.type).toBe("directory");
      expect(result.stack).toHaveLength(0);
    }
  });

  it("creates directory chains with ensureDirs and finds them", () => {
    const tree = new OverlayTree(1024);
    tree.ensureDirs("/a/b/c");
    const result = tree.descend("/a/b/c");
    expect(result.kind).toBe("found");
    expect(tree.descend("/a/b/d")).toMatchObject({
      kind: "missing",
      missingAt: 2,
    });
  });

  it("attaches files, tracks bytes, and replaces with byte adjustment", () => {
    const tree = new OverlayTree(1024);
    tree.ensureDirs("/a");
    tree.attach("/a/f.txt", fileNode("hello"));
    expect(tree.retainedBytes).toBe(5);
    expect(tree.descend("/a/f.txt")).toMatchObject({ kind: "found" });
    tree.attach("/a/f.txt", fileNode("hi"));
    expect(tree.retainedBytes).toBe(2);
  });

  it("rejects file-over-directory with EISDIR", () => {
    const tree = new OverlayTree(1024);
    tree.ensureDirs("/a");
    expect(() => tree.attach("/a", fileNode("x"))).toThrow("EISDIR");
  });

  it("rejects directory-over-entry with EEXIST", () => {
    const tree = new OverlayTree(1024);
    tree.attach("/f", fileNode("x"));
    expect(() => tree.attach("/f", dirNode())).toThrow("EEXIST");
    tree.ensureDirs("/d");
    expect(() => tree.attach("/d", dirNode())).toThrow("EEXIST");
  });

  it("distinguishes blocked (whiteout above) from missing", () => {
    const tree = new OverlayTree(1024);
    tree.ensureDirs("/a");
    tree.attach("/a/f", fileNode("x"));
    tree.putWhiteout("/a");
    expect(tree.descend("/a/b")).toMatchObject({
      kind: "blocked",
      blockedAt: 0,
    });
    expect(tree.descend("/x/y")).toMatchObject({ kind: "missing" });
    // The whiteout itself is found at the exact path.
    const exact = tree.descend("/a");
    expect(exact).toMatchObject({ kind: "found" });
    if (exact.kind === "found") expect(exact.node.type).toBe("whiteout");
  });

  it("releases subtree bytes when whiteouting", () => {
    const tree = new OverlayTree(1024);
    tree.ensureDirs("/a/b");
    tree.attach("/a/b/f1", fileNode("12345"));
    tree.attach("/a/f2", fileNode("678"));
    expect(tree.retainedBytes).toBe(8);
    tree.putWhiteout("/a");
    expect(tree.retainedBytes).toBe(0);
  });

  it("detaches subtrees and releases their bytes", () => {
    const tree = new OverlayTree(1024);
    tree.ensureDirs("/a/b");
    tree.attach("/a/b/f", fileNode("data"));
    const removed = tree.detach("/a");
    expect(removed?.type).toBe("directory");
    expect(tree.retainedBytes).toBe(0);
    expect(tree.descend("/a/b/f")).toMatchObject({ kind: "missing" });
    expect(tree.detach("/a")).toBeUndefined();
    expect(tree.detach("/")).toBeUndefined();
  });

  it("resurrects whiteouts as directories in ensureDirs", () => {
    const tree = new OverlayTree(1024);
    tree.putWhiteout("/a");
    tree.ensureDirs("/a/b");
    expect(tree.descend("/a/b")).toMatchObject({ kind: "found" });
    const a = tree.descend("/a");
    if (a.kind === "found") expect(a.node.type).toBe("directory");
  });

  it("allows attach over a whiteout (recreate-after-delete)", () => {
    const tree = new OverlayTree(1024);
    tree.putWhiteout("/f");
    tree.attach("/f", fileNode("back"));
    const result = tree.descend("/f");
    if (result.kind === "found") expect(result.node.type).toBe("file");
    expect(tree.retainedBytes).toBe(4);
  });

  it("reports notdir when descending through a file", () => {
    const tree = new OverlayTree(1024);
    tree.attach("/f", fileNode("x"));
    expect(tree.descend("/f/child")).toMatchObject({
      kind: "notdir",
      notdirAt: 0,
    });
    expect(() => tree.ensureDirs("/f/child")).toThrow("ENOTDIR");
  });

  it("enforces capacity on attach, replace, and append", () => {
    const tree = new OverlayTree(5);
    tree.attach("/f", fileNode("abc"));
    const f = tree.root.children.get("f");
    if (f?.type !== "file") throw new Error("unreachable");
    expect(() => tree.appendChunk(f, new Uint8Array(3))).toThrow(
      "overlay memory byte limit exceeded (5 bytes)",
    );
    // Replace counts the released bytes: 5 -> 5 fits.
    tree.attach("/f", fileNode("abcde"));
    expect(tree.retainedBytes).toBe(5);
    expect(() => tree.attach("/g", fileNode("x"))).toThrow("ENOSPC");
  });

  it("accounts append chunks and releases them with the file", () => {
    const tree = new OverlayTree(1024);
    const f = fileNode("ab");
    tree.attach("/f", f);
    tree.appendChunk(f, new TextEncoder().encode("cd"));
    expect(tree.retainedBytes).toBe(4);
    tree.detach("/f");
    expect(tree.retainedBytes).toBe(0);
  });

  it("walks pre-order parents-first and post-order children-first", () => {
    const tree = new OverlayTree(1024);
    tree.ensureDirs("/a/b");
    tree.attach("/a/b/f", fileNode("x"));
    tree.attach("/top", fileNode("y"));
    tree.putWhiteout("/gone");
    const pre = [...tree.preOrder()].map((i) => `${i.path}:${i.node.type}`);
    expect(pre).toEqual([
      "/:directory",
      "/a:directory",
      "/a/b:directory",
      "/a/b/f:file",
      "/top:file",
      "/gone:whiteout",
    ]);
    const post = [...tree.postOrder()].map((i) => i.path);
    expect(post.indexOf("/a/b/f")).toBeLessThan(post.indexOf("/a/b"));
    expect(post.indexOf("/a/b")).toBeLessThan(post.indexOf("/a"));
    expect(post.indexOf("/a")).toBeLessThan(post.indexOf("/"));
  });

  it("clears the tree and resets accounting", () => {
    const tree = new OverlayTree(1024);
    tree.attach("/f", fileNode("data"));
    tree.putWhiteout("/g");
    tree.clear();
    expect(tree.retainedBytes).toBe(0);
    expect(tree.root.children.size).toBe(0);
    expect(tree.descend("/f")).toMatchObject({ kind: "missing" });
  });

  describe("opaque directories", () => {
    it("blocks missing descendants of resurrected directories", () => {
      const tree = new OverlayTree(1024);
      tree.putWhiteout("/a");
      tree.ensureDirs("/a");
      // Resurrected /a is opaque: lower-layer children stay hidden.
      expect(tree.descend("/a/old.txt")).toMatchObject({ kind: "blocked" });
      expect(tree.descend("/a/deep/nested")).toMatchObject({
        kind: "blocked",
      });
      // But upper-layer children are found normally.
      tree.attach("/a/new.txt", fileNode("n"));
      expect(tree.descend("/a/new.txt")).toMatchObject({ kind: "found" });
    });

    it("marks directories attached over a whiteout as opaque", () => {
      const tree = new OverlayTree(1024);
      tree.putWhiteout("/d");
      tree.attach("/d", dirNode());
      const d = tree.descend("/d");
      if (d.kind === "found" && d.node.type === "directory") {
        expect(d.node.opaque).toBe(true);
      } else {
        throw new Error("unreachable");
      }
      expect(tree.descend("/d/old")).toMatchObject({ kind: "blocked" });
    });

    it("hides lower content below dirs created under an opaque parent", () => {
      const tree = new OverlayTree(1024);
      tree.putWhiteout("/a");
      tree.ensureDirs("/a/b");
      // /a/b was created fresh, but its lower-layer namesakes stay hidden
      // because the opaque parent already hides all of /a/*.
      expect(tree.descend("/a/b/lower.txt")).toMatchObject({
        kind: "blocked",
      });
    });

    it("does not affect never-deleted directories", () => {
      const tree = new OverlayTree(1024);
      tree.ensureDirs("/plain");
      expect(tree.descend("/plain/anything")).toMatchObject({
        kind: "missing",
      });
    });
  });
});
