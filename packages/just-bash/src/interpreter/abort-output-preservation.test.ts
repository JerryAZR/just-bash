import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

// Fatal execution errors (abort/timeout, safety limits) propagate as
// exceptions that carry the stdout/stderr accumulated before the abort.
// The interpreter's top-level catch must prepend its accumulated output
// before rethrowing — a bare rethrow would silently discard everything
// the script printed before the abort fired, which is exactly the
// partial output a harness needs after a timeout.
describe("abort/timeout output preservation", () => {
  it("execution deadline preserves stdout printed before the deadline", async () => {
    const bash = new Bash({
      executionLimits: { maxExecutionTimeMs: 1000 },
    });
    const result = await bash.exec(
      'echo "before loop"; while true; do :; done',
    );
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("before loop\n");
  });

  it("abort signal preserves stdout printed before the abort", async () => {
    const bash = new Bash();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const result = await bash.exec(
      'echo "line one"; echo "line two"; while true; do sleep 10; done',
      { signal: controller.signal },
    );
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("line one\nline two\n");
  });

  it("execution limit errors keep carrying accumulated output", async () => {
    const bash = new Bash({
      executionLimits: { maxCommandCount: 5 },
    });
    const result = await bash.exec(
      "echo one; echo two; echo three; echo four; echo five; echo six",
    );
    expect(result.exitCode).toBe(126);
    expect(result.stdout).toContain("one\n");
  });
});
