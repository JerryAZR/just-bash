import { describe, it } from "vitest";
import { Bash } from "../../Bash.js";
import { expectExecResult } from "../../test-utils/exec-result.js";

describe("diff -r (recursive)", () => {
  it("reports identical directories", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a/sub /b/sub");
    await env.exec("echo hello > /a/file.txt");
    await env.exec("echo hello > /b/file.txt");
    await env.exec("echo world > /a/sub/nested.txt");
    await env.exec("echo world > /b/sub/nested.txt");
    const result = await env.exec("diff -r /a /b");
    expectExecResult(result, { stdout: "", stderr: "", exitCode: 0 });
  });

  it("shows diff for differing files", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a /b");
    await env.exec("echo old > /a/file.txt");
    await env.exec("echo new > /b/file.txt");
    const result = await env.exec("diff -r /a /b");
    expectExecResult(result, {
      stdout: "diff -r /a/file.txt /b/file.txt\n1c1\n< old\n---\n> new\n",
      stderr: "",
      exitCode: 1,
    });
  });

  it("reports Only in for unique entries", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a/sub /b");
    await env.exec("echo shared > /a/file.txt");
    await env.exec("echo shared > /b/file.txt");
    await env.exec("echo extra > /a/only-a.txt");
    await env.exec("echo extra > /b/only-b.txt");
    await env.exec("echo nested > /a/sub/deep.txt");
    const result = await env.exec("diff -r /a /b");
    expectExecResult(result, {
      stdout:
        "Only in /a: only-a.txt\nOnly in /b: only-b.txt\nOnly in /a: sub\n",
      stderr: "",
      exitCode: 1,
    });
  });

  it("reports type mismatch (file vs directory)", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a /b/thing");
    await env.exec("echo file > /a/thing");
    const result = await env.exec("diff -r /a /b");
    expectExecResult(result, {
      stdout:
        "File /a/thing is a regular file while file /b/thing is a directory\n",
      stderr: "",
      exitCode: 1,
    });
  });
});

describe("diff -rq (brief recursive)", () => {
  it("reports only which files differ", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a /b");
    await env.exec("echo same > /a/same.txt");
    await env.exec("echo same > /b/same.txt");
    await env.exec("echo old > /a/diff.txt");
    await env.exec("echo new > /b/diff.txt");
    await env.exec("echo extra > /a/unique.txt");
    const result = await env.exec("diff -rq /a /b");
    expectExecResult(result, {
      stdout:
        "Files /a/diff.txt and /b/diff.txt differ\nOnly in /a: unique.txt\n",
      stderr: "",
      exitCode: 1,
    });
  });
});

describe("diff -rN (treat absent as empty)", () => {
  it("shows full diff for files only in one tree", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a /b");
    await env.exec("echo shared > /a/file.txt");
    await env.exec("echo shared > /b/file.txt");
    await env.exec("printf 'line1\nline2\n' > /a/extra.txt");
    const result = await env.exec("diff -rN /a /b");
    expectExecResult(result, {
      stdout: "diff -rN /a/extra.txt /b/extra.txt\n1,2d0\n< line1\n< line2\n",
      stderr: "",
      exitCode: 1,
    });
  });

  it("shows full diff for files only in second tree", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a /b");
    await env.exec("printf 'hello\n' > /b/new.txt");
    const result = await env.exec("diff -rN /a /b");
    expectExecResult(result, {
      stdout: "diff -rN /a/new.txt /b/new.txt\n0a1\n> hello\n",
      stderr: "",
      exitCode: 1,
    });
  });
});

describe("diff -r with mixed file/dir args", () => {
  it("compares file against dir/basename", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a /b");
    await env.exec("echo hello > /a/file.txt");
    await env.exec("echo hello > /b/file.txt");
    const result = await env.exec("diff -r /a/file.txt /b");
    expectExecResult(result, { stdout: "", stderr: "", exitCode: 0 });
  });
});

describe("diff -N two-file mode", () => {
  it("treats missing file as empty", async () => {
    const env = new Bash();
    await env.exec("printf 'line1\nline2\n' > /a.txt");
    const result = await env.exec("diff -N /a.txt /b.txt");
    expectExecResult(result, {
      stdout: "1,2d0\n< line1\n< line2\n",
      stderr: "",
      exitCode: 1,
    });
  });
});

describe("diff -rN with directories only in one tree (diffTreeVsEmpty)", () => {
  it("shows all files in a unique directory as deletions", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a/sub/deep /b");
    await env.exec("printf 'one\n' > /a/sub/first.txt");
    await env.exec("printf 'two\n' > /a/sub/deep/second.txt");
    const result = await env.exec("diff -rN /a /b");
    expectExecResult(result, {
      stdout:
        "diff -rN /a/sub/deep/second.txt /b/sub/deep/second.txt\n1d0\n< two\n" +
        "diff -rN /a/sub/first.txt /b/sub/first.txt\n1d0\n< one\n",
      stderr: "",
      exitCode: 1,
    });
  });

  it("shows all files in a unique directory as additions", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a /b/sub");
    await env.exec("printf 'new\n' > /b/sub/file.txt");
    const result = await env.exec("diff -rN /a /b");
    expectExecResult(result, {
      stdout: "diff -rN /a/sub/file.txt /b/sub/file.txt\n0a1\n> new\n",
      stderr: "",
      exitCode: 1,
    });
  });

  it("empty tree vs empty tree exits 0 with -N", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a/sub /b");
    await env.exec("touch /a/sub/empty.txt");
    const result = await env.exec("diff -rN /a /b");
    expectExecResult(result, { stdout: "", stderr: "", exitCode: 0 });
  });
});

describe("diff -r with output format flags", () => {
  it("-ru shows unified format with header", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a /b");
    await env.exec("printf 'old\n' > /a/f.txt");
    await env.exec("printf 'new\n' > /b/f.txt");
    const result = await env.exec("diff -ru /a /b");
    expectExecResult(result, {
      stdout:
        "diff -ru /a/f.txt /b/f.txt\n" +
        "--- /a/f.txt\n" +
        "+++ /b/f.txt\n" +
        "@@ -1 +1 @@\n" +
        "-old\n" +
        "+new\n",
      stderr: "",
      exitCode: 1,
    });
  });

  it("-rs reports identical files without header", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a /b");
    await env.exec("printf 'same\n' > /a/f.txt");
    await env.exec("printf 'same\n' > /b/f.txt");
    const result = await env.exec("diff -rs /a /b");
    expectExecResult(result, {
      stdout: "Files /a/f.txt and /b/f.txt are identical\n",
      stderr: "",
      exitCode: 0,
    });
  });
});

describe("diff -r edge cases", () => {
  it("two empty directories are identical", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a /b");
    const result = await env.exec("diff -r /a /b");
    expectExecResult(result, { stdout: "", stderr: "", exitCode: 0 });
  });

  it("missing directory operand exits 2", async () => {
    const env = new Bash();
    const result = await env.exec("diff -r /nonexistent /b");
    expectExecResult(result, {
      stdout: "",
      stderr: "diff: /nonexistent: No such file or directory\n",
      exitCode: 2,
    });
  });

  it("-r with two file args acts as regular diff", async () => {
    const env = new Bash();
    await env.exec("printf 'a\n' > /x.txt");
    await env.exec("printf 'b\n' > /y.txt");
    const result = await env.exec("diff -r /x.txt /y.txt");
    expectExecResult(result, {
      stdout: "1c1\n< a\n---\n> b\n",
      stderr: "",
      exitCode: 1,
    });
  });

  it("mixed file/dir with differing content", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a /b");
    await env.exec("printf 'old\n' > /a/file.txt");
    await env.exec("printf 'new\n' > /b/file.txt");
    const result = await env.exec("diff -r /a/file.txt /b");
    expectExecResult(result, {
      stdout: "1c1\n< old\n---\n> new\n",
      stderr: "",
      exitCode: 1,
    });
  });

  it("mixed file/dir with missing target exits 2", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a /b");
    await env.exec("printf 'x\n' > /a/unique.txt");
    const result = await env.exec("diff -r /a/unique.txt /b");
    expectExecResult(result, {
      stdout: "",
      stderr: "diff: /b/unique.txt: No such file or directory\n",
      exitCode: 2,
    });
  });

  it("mixed file/dir with missing target and -N shows full diff", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a /b");
    await env.exec("printf 'line1\nline2\n' > /a/new.txt");
    const result = await env.exec("diff -rN /a/new.txt /b");
    expectExecResult(result, {
      stdout: "1,2d0\n< line1\n< line2\n",
      stderr: "",
      exitCode: 1,
    });
  });
});
