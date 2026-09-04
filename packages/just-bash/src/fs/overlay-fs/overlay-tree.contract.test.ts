import { describe, expect, it } from "vitest";
import {
  type OverlayDirNode,
  type OverlayFileNode,
  OverlayTree,
} from "./overlay-tree.js";

/**
 * Contract pins for OverlayTree's mutation and descent rules that the
 * happy-path suite doesn't cover: root protection, whiteout idempotency,
 * detach semantics, ancestry stacks, and the exact capacity boundary.
 */

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

describe("OverlayTree contract", () => {
  it("rejects attach and putWhiteout at the root", () => {
    const tree = new OverlayTree(1024);
    expect(() => tree.attach("/", fileNode("x"))).toThrow(/EINVAL/);
    expect(() => tree.putWhiteout("/")).toThrow(/EINVAL/);
  });

  it("rejects putWhiteout through a file with ENOTDIR", () => {
    const tree = new OverlayTree(1024);
    tree.attach("/file", fileNode("x"));
    expect(() => tree.putWhiteout("/file/child")).toThrow(/ENOTDIR/);
  });

  it("putWhiteout on an already-whiteouted path is a byte-neutral no-op", () => {
    const tree = new OverlayTree(1024);
    tree.ensureDirs("/a/b", () => null);
    tree.putWhiteout("/a/b");
    const before = tree.retainedBytes;
    tree.putWhiteout("/a/b");
    expect(tree.retainedBytes).toBe(before);
    const d = tree.descend("/a/b");
    expect(d.kind).toBe("found");
    expect(d.kind === "found" && d.node.type).toBe("whiteout");
  });

  it("detach returns a whiteout node and releases nothing", () => {
    const tree = new OverlayTree(1024);
    tree.ensureDirs("/a", () => null);
    tree.putWhiteout("/a");
    const detached = tree.detach("/a");
    expect(detached?.type).toBe("whiteout");
    expect(tree.retainedBytes).toBe(0);
  });

  it("detach below a whiteout returns undefined", () => {
    const tree = new OverlayTree(1024);
    tree.ensureDirs("/a", () => null);
    tree.putWhiteout("/a");
    expect(tree.detach("/a/child")).toBeUndefined();
  });

  it("descend returns the full ancestry stack, root first, parent last", () => {
    const tree = new OverlayTree(1024);
    tree.ensureDirs("/a/b", () => null);
    tree.attach("/a/b/f.txt", fileNode("x"));
    const result = tree.descend("/a/b/f.txt");
    expect(result.kind).toBe("found");
    // Ancestry of directories, root first, parent (/a/b) last.
    expect(result.stack.length).toBe(3);
    expect(result.stack[0]).toBe(tree.root);
    expect(result.stack[1].children.has("b")).toBe(true);
    expect(result.stack[2].children.has("f.txt")).toBe(true);
  });

  it("capacity boundary: exact fit succeeds, one byte over fails", () => {
    const tree = new OverlayTree(8);
    tree.attach("/exact", fileNode("12345678"));
    expect(tree.retainedBytes).toBe(8);
    expect(() => tree.attach("/over", fileNode("x"))).toThrow(/ENOSPC/);
    // Replacing same bytes for same bytes still fits.
    tree.attach("/exact", fileNode("abcdefgh"));
    expect(tree.retainedBytes).toBe(8);
  });

  it("symlink attach follows the same shadow rules as files", () => {
    const tree = new OverlayTree(1024);
    const link = {
      type: "symlink" as const,
      target: "/t",
      mode: 0o777,
      mtime: new Date(),
    };
    tree.ensureDirs("/dir", () => null);
    tree.attach("/file", fileNode("x"));
    tree.ensureDirs("/gone", () => null);
    tree.putWhiteout("/gone");
    // Over a file and over a whiteout: legal replace.
    tree.attach("/file", link);
    tree.attach("/gone", link);
    // Over a directory: EISDIR.
    expect(() => tree.attach("/dir", link)).toThrow(/EISDIR/);
  });
});
