import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

// The bridge protocol's data buffer is 8MB; files larger than that are
// now read and written in ranged chunks, transparent to the guest.
const NINE_MB = 9_000_000;

describe("python3 large file I/O (> 8MB bridge buffer)", () => {
  it("reads a pre-existing 9MB file", async () => {
    const env = new Bash({
      python: true,
      files: { "/big.bin": "A".repeat(NINE_MB) },
    });
    const result = await env.exec(
      `python3 -c "data = open('/big.bin', 'rb').read(); print(len(data), data[0:1], data[-1:])"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${NINE_MB} b'A' b'A'\n`);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it("writes and reads back a 9MB file", async () => {
    const env = new Bash({ python: true });
    const result = await env.exec(
      `python3 -c "
data = b'B' * ${NINE_MB}
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
});
