import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Bash } from "../../Bash.js";

// Oversized bridge results (> the 8MB transport buffer) are assembled
// transparently by execSync: the host publishes the first chunk with
// the full length, the worker loops READ_RESULT_RANGE for the rest.
// Payloads are POSITION-DEPENDENT so chunk duplication, reordering,
// and boundary off-by-ones are all detectable.
const NINE_MB = 9_000_000;
const pattern = (n: number) =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(65 + (i % 26))).join(
    "",
  );
const GUEST_CHECK = `
var ok = true;
for (var i = 0; i < s.length; i++) { if (s[i] !== String.fromCharCode(65 + (i % 26))) { ok = false; break; } }
console.log(s.length, ok);
`;

describe("oversized bridge results (> 8MB) assemble exactly", () => {
  describe("HTTP responses", () => {
    const originalFetch = global.fetch;
    beforeAll(() => {
      global.fetch = vi.fn(
        async () =>
          new Response(pattern(NINE_MB), {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      ) as unknown as typeof fetch;
    });
    afterAll(() => {
      global.fetch = originalFetch;
    });

    it("fetch returns a 9MB body with exact assembly", async () => {
      const env = new Bash({
        javascript: true,
        network: { allowedUrlPrefixes: ["http://example.com/"] },
      });
      const result = await env.exec(
        `js-exec -c "var r = await fetch('http://example.com/big'); var s = await r.text(); ${GUEST_CHECK}"`,
      );
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`${NINE_MB} true\n`);
      expect(result.exitCode).toBe(0);
    }, 30_000);
  });

  it("spawnSync returns > 8MB of stdout with exact assembly", async () => {
    const env = new Bash({
      javascript: true,
      files: { "/big.txt": pattern(NINE_MB) },
    });
    const result = await env.exec(
      `js-exec -c "var cp = require('child_process'); var r = cp.spawnSync('cat', ['/big.txt']); var s = r.stdout; console.log(r.status); ${GUEST_CHECK}"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`0\n${NINE_MB} true\n`);
    expect(result.exitCode).toBe(0);
  }, 30_000);

  it("invokeTool returns a 9MB JSON result with exact assembly", async () => {
    const payload = { data: pattern(NINE_MB) };
    const env = new Bash({
      javascript: {
        invokeTool: async (path: string) => {
          if (path !== "big.fetch") throw new Error(`Unknown tool: ${path}`);
          return JSON.stringify(payload);
        },
      },
    });
    const result = await env.exec(
      `js-exec -c "var r = await tools['big.fetch']({}); var s = r.data; ${GUEST_CHECK}"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${NINE_MB} true\n`);
    expect(result.exitCode).toBe(0);
  }, 30_000);
});
