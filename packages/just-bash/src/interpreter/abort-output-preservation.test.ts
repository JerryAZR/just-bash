import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";

// Fatal execution errors (abort/timeout, safety limits) propagate as
// exceptions that carry the stdout/stderr accumulated before the abort.
// The interpreter's top-level catch must prepend its accumulated output
// before rethrowing — a bare rethrow would silently discard everything
// the script printed before the abort fired, which is exactly the
// partial output a harness needs after a timeout.
//
// The abort is driven deterministically from inside the script (a
// custom command trips the AbortController), never by wall clock:
// deadline-based tests are flaky under CI load because interpreter
// startup time varies.
describe("abort/timeout output preservation", () => {
  const abortingBash = (controller: AbortController) =>
    new Bash({
      customCommands: [
        defineCommand("abort-now", async () => {
          controller.abort();
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      ],
    });

  it("abort preserves stdout printed before it, deterministically", async () => {
    const controller = new AbortController();
    const result = await abortingBash(controller).exec(
      'echo "line one"; echo "line two"; abort-now; echo "never"',
      { signal: controller.signal },
    );
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("line one\nline two\n");
  });

  it("execution deadline reports 124 with the deadline message", async () => {
    const bash = new Bash({
      executionLimits: { maxExecutionTimeMs: 200 },
    });
    const result = await bash.exec("while true; do :; done");
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("deadline");
  });

  it("execution limit errors keep carrying accumulated output", async () => {
    const bash = new Bash({
      executionLimits: { maxCommandCount: 5 },
    });
    const result = await bash.exec(
      "echo one; echo two; echo three; echo four; echo five; echo six",
    );
    expect(result.exitCode).toBe(126);
    expect(result.stdout).toBe("one\ntwo\nthree\nfour\nfive\n");
  });
});
