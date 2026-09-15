import { describe, it } from "vitest";
import { Bash } from "../Bash.js";
import { OverlayFs } from "../fs/overlay-fs/overlay-fs.js";
import { expectExecResult } from "../test-utils/exec-result.js";

function readOnlyEnv(): Bash {
  return new Bash({
    fs: new OverlayFs({ root: "/", readOnly: true }),
    cwd: "/",
  });
}

describe("read-only filesystem redirect errors", () => {
  it("redirect failure sets exit code and continues", async () => {
    const env = readOnlyEnv();
    const result = await env.exec('echo x > /file; echo "exit=$?"; echo done');
    expectExecResult(result, {
      stdout: "exit=1\ndone\n",
      stderr: "bash: /file: Read-only file system\n",
      exitCode: 0,
    });
  });

  it("errexit consumes redirect failure", async () => {
    const env = readOnlyEnv();
    const result = await env.exec(
      "set -e; echo x > /file; echo should-not-print",
    );
    expectExecResult(result, {
      stdout: "",
      stderr: "bash: /file: Read-only file system\n",
      exitCode: 1,
    });
  });

  it("append redirect failure on read-only FS", async () => {
    const env = readOnlyEnv();
    const result = await env.exec("echo x >> /file; echo rc=$?");
    expectExecResult(result, {
      stdout: "rc=1\n",
      stderr: "bash: /file: Read-only file system\n",
      exitCode: 0,
    });
  });

  it("stderr redirect failure on read-only FS", async () => {
    const env = readOnlyEnv();
    const result = await env.exec("echo x 2> /file; echo rc=$?");
    expectExecResult(result, {
      stdout: "rc=1\n",
      stderr: "bash: /file: Read-only file system\n",
      exitCode: 0,
    });
  });

  it("no file created on redirect failure", async () => {
    const env = readOnlyEnv();
    const result = await env.exec(
      "echo x > /file; test -e /file; echo exists=$?",
    );
    expectExecResult(result, {
      stdout: "exists=1\n",
      stderr: "bash: /file: Read-only file system\n",
      exitCode: 0,
    });
  });

  it("conditional context: redirect failure takes else branch", async () => {
    const env = readOnlyEnv();
    const result = await env.exec(
      "if echo x > /file; then echo yes; else echo no; fi",
    );
    expectExecResult(result, {
      stdout: "no\n",
      stderr: "bash: /file: Read-only file system\n",
      exitCode: 0,
    });
  });
});
