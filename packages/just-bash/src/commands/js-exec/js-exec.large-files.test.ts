import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

// Same 8MB bridge-buffer ceiling as python: files larger than the
// transport buffer are read/written in chunks, transparently. Payloads
// are POSITION-DEPENDENT: uniform repeats cannot detect chunk
// duplication, reordering, or boundary off-by-ones — this pattern can.
const NINE_MB = 9_000_000;
const charAt = (i: number) => String.fromCharCode(65 + (i % 26));
const pattern = (n: number) =>
  Array.from({ length: n }, (_, i) => charAt(i)).join("");

describe("js-exec large file I/O (> 8MB bridge buffer)", () => {
  it("reads a pre-existing 9MB file with exact assembly", async () => {
    const env = new Bash({
      javascript: true,
      files: { "/big.bin": pattern(NINE_MB) },
    });
    const result = await env.exec(
      `js-exec -c "
var fs = require('fs');
var s = fs.readFileSync('/big.bin', 'utf8');
var ok = true;
for (var i = 0; i < s.length; i++) { if (s[i] !== String.fromCharCode(65 + (i % 26))) { ok = false; break; } }
console.log(s.length, ok);
"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${NINE_MB} true\n`);
    expect(result.exitCode).toBe(0);
  }, 30_000);

  it("writes and reads back a 9MB file with exact bytes", async () => {
    const env = new Bash({ javascript: true });
    const result = await env.exec(
      `js-exec -c "
var fs = require('fs');
var data = new Uint8Array(${NINE_MB});
for (var i = 0; i < data.length; i++) data[i] = 68 + (i % 26);
fs.writeFileSync('/out.bin', data);
fs.appendFileSync('/out.bin', new Uint8Array([69]));
var back = fs.readFileSync('/out.bin', 'utf8');
var ok = back.length === data.length + 1;
for (var i = 0; ok && i < data.length; i++) { if (back[i] !== String.fromCharCode(68 + (i % 26))) ok = false; }
if (ok && back[back.length - 1] !== 'E') ok = false;
console.log(back.length, ok);
"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${NINE_MB + 1} true\n`);
    expect(result.exitCode).toBe(0);
  }, 30_000);
});

describe("write data type strictness", () => {
  it("rejects plain objects loudly instead of writing coerced text", async () => {
    const env = new Bash({ javascript: true });
    const result = await env.exec(
      `js-exec -c "var fs = require('fs'); try { fs.writeFileSync('/x', {a: 1}); console.log('NO ERROR'); } catch(e) { console.log('threw'); }"`,
    );
    expect(result.stdout).toBe("threw\n");
    const cat = await env.exec("cat /x");
    expect(cat.exitCode).toBe(1);
  }, 30_000);
});
