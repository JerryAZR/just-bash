import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { FsError } from "../../fs/fs-error.js";
import { InMemoryFs } from "../../fs/in-memory-fs/index.js";

// The bridge protocol's data buffer is 8MB; files larger than that are
// now read and written in ranged chunks, transparent to the guest.
// Payloads are position-dependent so chunk misassembly is detectable.
const NINE_MB = 9_000_000;
const pattern = (n: number) =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(65 + (i % 26))).join(
    "",
  );

describe("python3 large file I/O (> 8MB bridge buffer)", () => {
  it("reads a pre-existing 9MB file with exact assembly", async () => {
    const env = new Bash({
      python: true,
      files: { "/big.bin": pattern(NINE_MB) },
    });
    const result = await env.exec(
      `python3 -c "
data = open('/big.bin', 'rb').read()
expected = (''.join(chr(65 + (i % 26)) for i in range(len(data)))).encode()
print(len(data), data == expected)
"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${NINE_MB} True\n`);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it("writes and reads back a 9MB file", async () => {
    const env = new Bash({ python: true });
    const result = await env.exec(
      `python3 -c "
data = (''.join(chr(65 + (i % 26)) for i in range(${NINE_MB}))).encode()
open('/out.bin', 'wb').write(data)
back = open('/out.bin', 'rb').read()
print(len(back), back == data)
"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${NINE_MB} True\n`);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it("reports EISDIR honestly when opening a directory (not FileNotFoundError)", async () => {
    const env = new Bash({
      python: true,
      files: { "/data/f.txt": "x" },
    });
    const result = await env.exec(
      `python3 -c "
try:
    open('/data', 'rb').read()
    print('NO ERROR')
except IsADirectoryError as e:
    print('IsADirectoryError')
except FileNotFoundError as e:
    print('FileNotFoundError (the lie)')
except OSError as e:
    print('OSError', e.errno)
"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("IsADirectoryError\n");
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it("fails at open(), not late at close, when write-opening a directory", async () => {
    // The old open() catch swallowed every backend read error as
    // 'empty new file' for O_CREAT writes: an EISDIR surfaced only at
    // close() flush time. Real CPython raises IsADirectoryError at open.
    const env = new Bash({
      python: true,
      files: { "/data/f.txt": "x" },
    });
    const result = await env.exec(
      `python3 -c "
try:
    f = open('/data', 'wb')
    print('open succeeded (wrong)')
    f.close()
except IsADirectoryError:
    print('IsADirectoryError at open')
"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("IsADirectoryError at open\n");
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it("maps non-ENOENT backend errors honestly (fault-injected EACCES)", async () => {
    // Deterministic trigger for the open() catch: a backend read failure
    // that is NOT a missing file. The old blanket ENOENT turned this
    // into FileNotFoundError; the fix surfaces PermissionError.
    class DenyReadFs extends InMemoryFs {
      override async readFileBuffer(path: string): Promise<Uint8Array> {
        if (path === "/secret.txt") {
          throw new FsError("EACCES", "permission denied");
        }
        return super.readFileBuffer(path);
      }
    }
    const fs = new DenyReadFs();
    await fs.writeFile("/secret.txt", "x");
    const env = new Bash({ python: true, fs });
    const result = await env.exec(
      `python3 -c "
try:
    open('/secret.txt', 'rb').read()
    print('NO ERROR')
except PermissionError:
    print('PermissionError')
except FileNotFoundError:
    print('FileNotFoundError (the lie)')
except OSError as e:
    print('OSError', e.errno)
"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("PermissionError\n");
    expect(result.exitCode).toBe(0);
  }, 60_000);
});

describe("errno honesty for rmdir on non-empty directories", () => {
  it("reports ENOTEMPTY, not EIO", async () => {
    const env = new Bash({ python: true, files: { "/data/f.txt": "x" } });
    const result = await env.exec(
      `python3 -c "
import os
try:
    os.rmdir('/data')
    print('NO ERROR')
except OSError as e:
    print('OSError', 'not empty' in str(e).lower(), e.errno == 5)
"`,
    );
    expect(result.stderr).toBe("");
    // Must say "not empty"; must NOT be the EIO(5) fallback.
    expect(result.stdout).toBe("OSError True False\n");
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it("honors a structured .code with no message prefix (no prose parsing)", async () => {
    // Node-style error: code carried structurally, message carries no
    // "EACCES" text. Substring heuristics cannot see it; only the
    // structured channel can. Pre-fix this surfaces as the ENOENT lie.
    class NodeStyleDenyFs extends InMemoryFs {
      override async readFileBuffer(path: string): Promise<Uint8Array> {
        if (path === "/node-denied.txt") {
          throw Object.assign(new Error("go away"), { code: "EACCES" });
        }
        return super.readFileBuffer(path);
      }
    }
    const fs = new NodeStyleDenyFs();
    await fs.writeFile("/node-denied.txt", "x");
    const env = new Bash({ python: true, fs });
    const result = await env.exec(
      `python3 -c "
try:
    open('/node-denied.txt').read()
    print('open succeeded (wrong)')
except PermissionError:
    print('PermissionError (honest)')
except FileNotFoundError:
    print('FileNotFoundError (the lie)')
"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("PermissionError (honest)\n");
    expect(result.exitCode).toBe(0);
  }, 60_000);
});
