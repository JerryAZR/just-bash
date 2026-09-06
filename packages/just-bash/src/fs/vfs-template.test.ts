import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { createVfsTemplate } from "./vfs-template.js";

describe("createVfsTemplate", () => {
  let projectRoot: string;
  let homeRoot: string;
  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-proj-"));
    homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-home-"));
    fs.writeFileSync(path.join(projectRoot, "app.ts"), "v0\n");
  });
  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(homeRoot, { recursive: true, force: true, maxRetries: 3 });
  });

  const makeTemplate = () =>
    createVfsTemplate({
      mounts: [
        { at: "/project", root: projectRoot },
        { at: "/home/user", root: homeRoot },
      ],
    });

  it("forks share scratch but not overlaid writes", async () => {
    const tpl = makeTemplate();
    const a = tpl.fork();
    const b = tpl.fork();
    await a.writeFile("/project/a.ts", "from-a");
    await a.writeFile("/tmp/scratch.txt", "shared");
    // Overlaid writes are private; scratch is shared.
    expect(await b.exists("/project/a.ts")).toBe(false);
    expect(await b.readFile("/tmp/scratch.txt")).toBe("shared");
    // Both read the base project content.
    expect(await a.readFile("/project/app.ts")).toBe("v0\n");
    expect(await b.readFile("/project/app.ts")).toBe("v0\n");
  });

  it("merges fork diffs into real absolute paths, later write winning", async () => {
    const tpl = makeTemplate();
    const a = tpl.fork();
    const b = tpl.fork();
    await a.writeFile("/project/app.ts", "from-a");
    await new Promise((r) => setTimeout(r, 5));
    await b.writeFile("/project/app.ts", "from-b");
    await b.writeFile("/home/user/notes.txt", "home-b");

    const merged = (await tpl.merge([a, b])).diff({ space: "vfs" });
    const appEntry = merged.writes.find((w) => w.path === "/project/app.ts");
    expect(new TextDecoder().decode(appEntry?.content)).toBe("from-b");
    expect(merged.writes.some((w) => w.path === "/home/user/notes.txt")).toBe(
      true,
    );
    // vfs space: full virtual paths, mount prefix retained.
    for (const w of merged.writes) expect(w.path.startsWith("/")).toBe(true);
  });

  it("applies the merged diff to the real roots and re-baselines", async () => {
    const tpl = makeTemplate();
    const a = tpl.fork();
    const b = tpl.fork();
    await a.writeFile("/project/new.ts", "new-file");
    await b.rm("/project/app.ts");
    tpl.apply((await tpl.merge([a, b])).diff({ space: "host" }));

    expect(fs.readFileSync(path.join(projectRoot, "new.ts"), "utf8")).toBe(
      "new-file",
    );
    expect(fs.existsSync(path.join(projectRoot, "app.ts"))).toBe(false);

    // A fresh fork re-baselines on the applied state.
    const c = tpl.fork();
    expect(await c.readFile("/project/new.ts")).toBe("new-file");
    expect(await c.exists("/project/app.ts")).toBe(false);
  });

  it("drives real Bash processes on fork filesystems end to end", async () => {
    const tpl = makeTemplate();
    const results = await Promise.all(
      ["one", "two", "three"].map(async (name) => {
        const fork = tpl.fork();
        const bash = new Bash({ fs: fork, cwd: "/project" });
        await bash.exec(`echo "${name}" > ${name}.txt`);
        await bash.exec(`echo "shared-${name}" >> /tmp/log.txt`);
        return fork;
      }),
    );
    expect(results).toHaveLength(3);
    tpl.apply((await tpl.merge(results)).diff({ space: "host" }));
    for (const name of ["one", "two", "three"]) {
      expect(
        fs.readFileSync(path.join(projectRoot, `${name}.txt`), "utf8"),
      ).toBe(`${name}\n`);
    }
    // The /tmp contract: shared scratch saw every fork's appends, and
    // all three survive (InMemoryFs appends are atomic). ORDER is the
    // scheduler's, not ours — assert the multiset, not the sequence.
    const fresh = tpl.fork();
    const lines = (await fresh.readFile("/tmp/log.txt")).split("\n");
    expect(lines.sort()).toEqual([
      "",
      "shared-one",
      "shared-three",
      "shared-two",
    ]);
  });

  it("apply rejects entries outside every registered root", () => {
    const tpl = makeTemplate();
    expect(() =>
      tpl.apply({
        writes: [file("/etc/passwd", "x")],
        deletions: [],
      }),
    ).toThrow(/outside every template root/);
  });

  function file(path: string, content: string) {
    return {
      path,
      nodeType: "file" as const,
      content: new TextEncoder().encode(content),
      mode: 0o644,
      mtime: new Date(0),
    };
  }
});

describe("mount validation", () => {
  it("rejects duplicate mount points at construction", () => {
    expect(() =>
      createVfsTemplate({
        mounts: [
          { at: "/project", root: "/" },
          { at: "project/", root: "/" },
        ],
      }),
    ).toThrow(/duplicate mount point/);
  });
});

describe("symlink containment at apply", () => {
  it.skipIf(process.platform === "win32")(
    "rejects entries that escape their root through a symlink",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-link-"));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tpl-out-"));
      try {
        fs.symlinkSync(outside, path.join(root, "link"), "dir");
        const tpl = createVfsTemplate({
          mounts: [{ at: "/project", root }],
        });
        expect(() =>
          tpl.apply({
            writes: [
              {
                path: path.join(root, "link", "escape.txt"),
                nodeType: "file" as const,
                content: new TextEncoder().encode("x"),
                mode: 0o644,
                mtime: new Date(0),
              },
            ],
            deletions: [],
          }),
        ).toThrow(/escapes its root through a symlink/);
        expect(fs.existsSync(path.join(outside, "escape.txt"))).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
        fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3 });
      }
    },
  );
});
