import { afterEach, describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import {
  _hasSharedJsExecWorkerForTests,
  _resetJsExecWorkerForTests,
  _setJsExecWorkerIdleTimeoutMsForTests,
} from "./js-exec.js";

// The idle-teardown timer must fire AFTER the scheduling execution's
// defense-in-depth context has deactivated. A timer bound to that context
// is silently suppressed (DefenseInDepthBox drops callbacks of deactivated
// executions), which leaked the shared worker — and its MessagePort and
// socket handles — forever, so any process that ran js-exec could never
// exit naturally.
describe("js-exec worker idle teardown", () => {
  afterEach(() => {
    _setJsExecWorkerIdleTimeoutMsForTests(5_000);
    _resetJsExecWorkerForTests();
  });

  it("terminates the shared worker after the execution completes", async () => {
    _setJsExecWorkerIdleTimeoutMsForTests(50);
    const env = new Bash({ javascript: true });
    const result = await env.exec(`js-exec -c "console.log('hi')"`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
    expect(result.stderr).toBe("");
    expect(_hasSharedJsExecWorkerForTests()).toBe(true);

    // Wait past the idle timeout; the worker must be gone even though the
    // execution that scheduled the timer has fully completed.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(_hasSharedJsExecWorkerForTests()).toBe(false);
  }, 15_000);

  it("keeps the worker alive across back-to-back executions", async () => {
    _setJsExecWorkerIdleTimeoutMsForTests(300);
    const env = new Bash({ javascript: true });
    await env.exec(`js-exec -c "console.log('a')"`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await env.exec(`js-exec -c "console.log('b')"`);
    expect(_hasSharedJsExecWorkerForTests()).toBe(true);
    // Wait past the ORIGINAL 300ms deadline: if exec 'b' did not re-arm
    // the teardown timer, the worker dies here. It must still be alive.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(_hasSharedJsExecWorkerForTests()).toBe(true);
  }, 15_000);
});
