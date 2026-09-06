import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/index.js";
import { MountableFs } from "../../fs/mountable-fs/mountable-fs.js";

describe("rm", () => {
  it("should remove file", async () => {
    const env = new Bash({
      files: { "/test.txt": "content" },
    });
    const result = await env.exec("rm /test.txt");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const cat = await env.exec("cat /test.txt");
    expect(cat.exitCode).toBe(1);
  });

  it("should remove multiple files", async () => {
    const env = new Bash({
      files: {
        "/a.txt": "",
        "/b.txt": "",
        "/c.txt": "",
      },
    });
    await env.exec("rm /a.txt /b.txt /c.txt");
    const ls = await env.exec("ls /");
    // /bin, /usr, /dev, /proc always exist
    expect(ls.stdout).toBe("bin\ndev\nproc\nusr\n");
  });

  it("should error on missing file", async () => {
    const env = new Bash();
    const result = await env.exec("rm /missing.txt");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "rm: cannot remove '/missing.txt': No such file or directory\n",
    );
    expect(result.exitCode).toBe(1);
  });

  it("should not error with -f on missing file", async () => {
    const env = new Bash();
    const result = await env.exec("rm -f /missing.txt");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should error when removing directory without -r", async () => {
    const env = new Bash({
      files: { "/dir/file.txt": "content" },
    });
    const result = await env.exec("rm /dir");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("should remove directory with -r", async () => {
    const env = new Bash({
      files: { "/dir/file.txt": "content" },
    });
    const result = await env.exec("rm -r /dir");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const ls = await env.exec("ls /dir");
    expect(ls.exitCode).toBe(2);
  });

  it("should remove directory with -R", async () => {
    const env = new Bash({
      files: { "/dir/file.txt": "content" },
    });
    await env.exec("rm -R /dir");
    const ls = await env.exec("ls /dir");
    expect(ls.exitCode).toBe(2);
  });

  it("should remove nested directories with -r", async () => {
    const env = new Bash({
      files: {
        "/dir/sub1/file1.txt": "",
        "/dir/sub2/file2.txt": "",
        "/dir/root.txt": "",
      },
    });
    await env.exec("rm -r /dir");
    const ls = await env.exec("ls /dir");
    expect(ls.exitCode).toBe(2);
  });

  it("should combine -rf flags", async () => {
    const env = new Bash({
      files: { "/dir/file.txt": "" },
    });
    const result = await env.exec("rm -rf /dir /nonexistent");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should handle --recursive flag", async () => {
    const env = new Bash({
      files: { "/dir/file.txt": "" },
    });
    await env.exec("rm --recursive /dir");
    const ls = await env.exec("ls /dir");
    expect(ls.exitCode).toBe(2);
  });

  it("should handle --force flag", async () => {
    const env = new Bash();
    const result = await env.exec("rm --force /missing");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should not error with -f and no arguments", async () => {
    const env = new Bash();
    const result = await env.exec("rm -f");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should error with no arguments", async () => {
    const env = new Bash();
    const result = await env.exec("rm");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("rm: missing operand\n");
    expect(result.exitCode).toBe(1);
  });

  it("should remove empty directory with -r", async () => {
    const env = new Bash();
    await env.exec("mkdir /emptydir");
    await env.exec("rm -r /emptydir");
    const ls = await env.exec("ls /emptydir");
    expect(ls.exitCode).toBe(2);
  });

  it("should remove file with relative path", async () => {
    const env = new Bash({
      files: { "/home/user/file.txt": "content" },
      cwd: "/home/user",
    });
    await env.exec("rm file.txt");
    const cat = await env.exec("cat /home/user/file.txt");
    expect(cat.exitCode).toBe(1);
  });
});

describe("rm -f with mount points (GNU parity: force suppresses only ENOENT)", () => {
  const createMountedEnv = () => {
    const vfs = new MountableFs({ base: new InMemoryFs() });
    vfs.mount("/mnt/data", new InMemoryFs());
    return new Bash({ fs: vfs, cwd: "/" });
  };

  it("reports EBUSY and fails under -f when removing a mount point", async () => {
    const env = createMountedEnv();
    await env.exec("echo x > /mnt/data/file.txt");
    const result = await env.exec("rm -rf /mnt/data");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("/mnt/data");
    expect(result.stderr).toMatch(/EBUSY|busy/);
    // Nothing was removed.
    const check = await env.exec("cat /mnt/data/file.txt");
    expect(check.stdout).toBe("x\n");
  });

  it("reports EBUSY and fails under -f when removing a mount's parent", async () => {
    const env = createMountedEnv();
    const result = await env.exec("rm -rf /mnt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toBe("");
    const check = await env.exec("ls /mnt/data");
    expect(check.exitCode).toBe(0);
  });

  it("still suppresses ENOENT silently under -f", async () => {
    const env = createMountedEnv();
    const result = await env.exec("rm -f /definitely-not-there.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("rm -f ENOENT anchoring (filenames containing error text)", () => {
  it("does not swallow EACCES for a file named ENOENT-notes", async () => {
    const env = new Bash({
      files: { "/ENOENT-notes": "x" },
      commands: undefined,
    });
    // Simulate a permission failure on a path containing "ENOENT":
    // MountableFs mount points produce EBUSY, which embeds the path.
    const { MountableFs } = await import(
      "../../fs/mountable-fs/mountable-fs.js"
    );
    const { InMemoryFs } = await import("../../fs/in-memory-fs/index.js");
    const vfs = new MountableFs({ base: new InMemoryFs() });
    vfs.mount("/mnt/ENOENT-notes", new InMemoryFs());
    const env2 = new Bash({ fs: vfs, cwd: "/" });
    const result = await env2.exec("rm -rf /mnt/ENOENT-notes");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toBe("");
    expect(env).toBeDefined();
  });
});
