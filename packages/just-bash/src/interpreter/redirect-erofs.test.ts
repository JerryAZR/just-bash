import { describe, it } from "vitest";
import { Bash } from "../Bash.js";
import { OverlayFs } from "../fs/overlay-fs/overlay-fs.js";
import { expectExecResult } from "../test-utils/exec-result.js";

describe("read-only filesystem redirect errors", () => {
  it("redirect failure sets exit code and continues", async () => {
    // On a read-only overlay, `echo x > file` should fail with exit code 1
    // and the script should continue (bash semantics), not abort entirely.
    const env = new Bash({
      fs: new OverlayFs({ root: "/", readOnly: true }),
      cwd: "/",
    });
    const result = await env.exec('echo x > /file; echo "exit=$?"; echo done');
    expectExecResult(result, {
      stdout: "exit=1\ndone\n",
      stderr: "bash: /file: cannot open redirect target\n",
      exitCode: 0,
    });
  });
});
