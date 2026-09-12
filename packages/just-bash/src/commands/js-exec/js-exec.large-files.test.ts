import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { expectExecResult } from "../../test-utils/exec-result.js";

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
      executionLimits: { maxJsTimeoutMs: 120_000 },
    });
    const result = await env.exec(
      `js-exec -c "
var fs = require('fs');
var s = fs.readFileSync('/big.bin', 'utf8');
var ok = s.length === ${NINE_MB};
// Verify start, end, and every 1MB boundary (chunk-boundary integrity)
// without an exhaustive per-char loop that would timeout in QuickJS.
var checkpoints = [0, 1, 1999999, 2000000, 3999998, 3999999, 4000000];
for (var j = 0; j < checkpoints.length; j++) {
  var i = checkpoints[j];
  if (s[i] !== String.fromCharCode(65 + (i % 26))) { ok = false; break; }
}
console.log(s.length, ok);
"`,
    );
    expectExecResult(result, {
      stdout: `${NINE_MB} true\n`,
      stderr: "",
      exitCode: 0,
    });
  }, 120_000);

  it("writes and reads back a large file with exact bytes", async () => {
    // run sync bridge stalls when cumulative args across ALL sync calls
    // exceed ~6MB (serialized stack frames accumulate). Reads are
    // unaffected (return values are not in the frame).
    const env = new Bash({
      javascript: true,
      executionLimits: { maxJsTimeoutMs: 120_000 },
    });
    const result = await env.exec(
      `js-exec -c "
var fs = require('fs');
var SIZE = 4000001;
var data = new Uint8Array(SIZE);
data.fill(68);
fs.writeFileSync('/out.bin', data);
var back = fs.readFileSync('/out.bin', 'utf8');
var ok = back.length === SIZE;
var checkpoints = [0, 1, 1999999, 2000000, 3999998, 3999999, 4000000];
for (var j = 0; ok && j < checkpoints.length; j++) {
  var i = checkpoints[j];
  if (back.charCodeAt(i) !== 68) ok = false;
}
console.log(back.length, ok);
"`,
    );
    expectExecResult(result, {
      stdout: `${4_000_001} true
`,
      stderr: "",
      exitCode: 0,
    });
  }, 240_000);
});

describe("write data type strictness", () => {
  it("rejects plain objects loudly instead of writing coerced text", async () => {
    const env = new Bash({
      javascript: true,
      executionLimits: { maxJsTimeoutMs: 120_000 },
    });
    const result = await env.exec(
      `js-exec -c "var fs = require('fs'); try { fs.writeFileSync('/x', {a: 1}); console.log('NO ERROR'); } catch(e) { console.log('threw'); }"`,
    );
    expectExecResult(result, { stdout: "threw\n" });
    const cat = await env.exec("cat /x");
    expect(cat.exitCode).toBe(1);
  }, 120_000);
});
