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
      stdout: "diff /a/file.txt /b/file.txt\n1c1\n< old\n---\n> new\n",
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
      stdout: "diff /a/extra.txt /b/extra.txt\n1,2d0\n< line1\n< line2\n",
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
      stdout: "diff /a/new.txt /b/new.txt\n0a1\n> hello\n",
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
