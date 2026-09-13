import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { expectExecResult } from "../test-utils/exec-result.js";
import { resolvePath } from "./path-utils.js";

// Windows drive-letter path translation: C:\foo → /c/foo (win32 only).
// On POSIX, C:\foo is a valid relative filename and must NOT be rewritten.
const isWindows = process.platform === "win32";

describe("Windows drive-letter path translation (resolvePath)", () => {
  it.skipIf(!isWindows)("translates backslash style on win32", () => {
    expect(resolvePath("/home", "C:\\Users\\test\\file.txt")).toBe(
      "/c/Users/test/file.txt",
    );
  });

  it.skipIf(!isWindows)("translates forward-slash style on win32", () => {
    expect(resolvePath("/home", "C:/Users/test/file.txt")).toBe(
      "/c/Users/test/file.txt",
    );
  });

  it.skipIf(!isWindows)("translates lowercase drive on win32", () => {
    expect(resolvePath("/home", "d:\\work\\out.txt")).toBe("/d/work/out.txt");
  });

  it.skipIf(!isWindows)("does not translate non-drive paths on win32", () => {
    expect(resolvePath("/home", "foo\\bar")).toBe("/home/foo\\bar");
  });

  it.skipIf(isWindows)(
    "does NOT translate drive-letter patterns on POSIX",
    () => {
      expect(resolvePath("/home", "C:\\Users\\test")).toBe(
        "/home/C:\\Users\\test",
      );
    },
  );
});

describe("Windows drive-letter paths in commands", () => {
  it.skipIf(!isWindows)("cat works with translated path", async () => {
    const env = new Bash({
      files: { "/c/Users/test/file.txt": "hello\n" },
    });
    const result = await env.exec("cat /c/Users/test/file.txt");
    expectExecResult(result, { stdout: "hello\n", stderr: "", exitCode: 0 });
  });
});
