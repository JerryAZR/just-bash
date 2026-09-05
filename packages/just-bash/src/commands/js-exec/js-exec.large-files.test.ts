import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

// Same 8MB bridge-buffer ceiling as python: files larger than the
// transport buffer are read/written in ranged chunks, transparently.
const NINE_MB = 9_000_000;

describe("js-exec large file I/O (> 8MB bridge buffer)", () => {
  it("reads a pre-existing 9MB file", async () => {
    const env = new Bash({
      javascript: true,
      files: { "/big.bin": "C".repeat(NINE_MB) },
    });
    const result = await env.exec(
      `js-exec -c "var fs = require('fs'); var s = fs.readFileSync('/big.bin', 'utf8'); console.log(s.length, s[0], s[s.length-1]);"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${NINE_MB} C C\n`);
    expect(result.exitCode).toBe(0);
  }, 30_000);

  it("writes and reads back a 9MB file", async () => {
    const env = new Bash({ javascript: true });
    const result = await env.exec(
      `js-exec -c "
var fs = require('fs');
var data = new Uint8Array(${NINE_MB}).fill(68);
fs.writeFileSync('/out.bin', data);
fs.appendFileSync('/out.bin', new Uint8Array([69]));
var back = fs.readFileSync('/out.bin');
var s = back.toString('utf8');
console.log(back.length, s.length === ${NINE_MB + 1} && s[0] === 'D' && s[s.length-1] === 'E');
"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${NINE_MB + 1} true\n`);
    expect(result.exitCode).toBe(0);
  }, 30_000);
});
