import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { FsError } from "../../fs/fs-error.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import type { IFileSystem } from "../../fs/interface.js";

function withInjectedFsError(
  fs: IFileSystem,
  method: "link" | "symlink",
  code: string,
  message: string,
): IFileSystem {
  return new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === method) {
        return async () => {
          throw new FsError(code, message);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as IFileSystem;
}

describe("ln command error forwarding", () => {
  it("sanitizes symlink error strings before forwarding", async () => {
    const fs = withInjectedFsError(
      new InMemoryFs({ "/target.txt": "ok\n" }),
      "symlink",
      "EIO",
      "symlink failed at /Users/attacker/private/secret.py via node:internal/modules/cjs/loader:999",
    );
    const env = new Bash({ fs });

    const result = await env.exec("ln -s /target.txt /leak-link");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "ln: symlink failed at <path> via <internal>:999\n",
    );
    expect(result.exitCode).toBe(1);
  });

  // A filesystem that does not allow symlinks reports EPERM from `symlink`,
  // which is neither a hard link nor a statement about the target. The
  // injected message is deliberately UNRELATED prose: only the structured
  // .code channel can classify this — a message-sniffing implementation
  // would fall to the generic branch and fail the exact assertion.
  it("reports a refused symlink as a symlink failure", async () => {
    const fs = withInjectedFsError(
      new InMemoryFs({ "/target.txt": "ok\n" }),
      "symlink",
      "EPERM",
      "go away",
    );
    const env = new Bash({ fs });

    const result = await env.exec("ln -s target.txt link");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "ln: failed to create symbolic link 'link': Operation not permitted\n",
    );
    expect(result.exitCode).toBe(1);
  });

  it("still reports a refused hard link against a directory", async () => {
    const fs = withInjectedFsError(
      new InMemoryFs({ "/dir/file.txt": "ok\n" }),
      "link",
      "EPERM",
      "operation not permitted, link '/dir'",
    );
    const env = new Bash({ fs });

    const result = await env.exec("ln /dir /link");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "ln: '/dir': hard link not allowed for directory\n",
    );
    expect(result.exitCode).toBe(1);
  });

  it("sanitizes hard-link error strings before forwarding", async () => {
    const fs = withInjectedFsError(
      new InMemoryFs({ "/target.txt": "ok\n" }),
      "link",
      "EIO",
      "link fault near /Users/attacker/workspace at node:internal/process/task_queues:95",
    );
    const env = new Bash({ fs });

    const result = await env.exec("ln /target.txt /hard-link");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("ln: link fault near <path> at <internal>:95\n");
    expect(result.exitCode).toBe(1);
  });
});
