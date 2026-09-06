import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Bash } from "../../Bash.js";

// Oversized bridge results (> the 8MB transport buffer) are assembled
// transparently by execSync: the host publishes the first chunk with
// the full length, the worker loops READ_RESULT_RANGE for the rest.
// One generic mechanism — every channel benefits: HTTP responses,
// sub-shell exec output, tool results (and file reads / readdir).
const NINE_MB = 9_000_000;

describe("oversized bridge results (> 8MB) assemble transparently", () => {
  describe("HTTP responses", () => {
    const originalFetch = global.fetch;
    beforeAll(() => {
      global.fetch = vi.fn(
        async () =>
          new Response("H".repeat(NINE_MB), {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      ) as unknown as typeof fetch;
    });
    afterAll(() => {
      global.fetch = originalFetch;
    });

    it("fetch returns a 9MB body intact", async () => {
      const env = new Bash({
        javascript: true,
        network: { allowedUrlPrefixes: ["http://example.com/"] },
      });
      const result = await env.exec(
        `js-exec -c "var r = await fetch('http://example.com/big'); var t = await r.text(); console.log(t.length, t[0], t[t.length-1]);"`,
      );
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`${NINE_MB} H H\n`);
      expect(result.exitCode).toBe(0);
    }, 30_000);
  });

  it("spawnSync returns > 8MB of stdout intact", async () => {
    const env = new Bash({
      javascript: true,
      files: { "/big.txt": "S".repeat(NINE_MB) },
    });
    const result = await env.exec(
      `js-exec -c "var cp = require('child_process'); var r = cp.spawnSync('cat', ['/big.txt']); console.log(r.status, r.stdout.length, r.stdout[0], r.stdout[r.stdout.length-1]);"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`0 ${NINE_MB} S S\n`);
    expect(result.exitCode).toBe(0);
  }, 30_000);

  it("invokeTool returns a 9MB JSON result intact", async () => {
    const payload = { data: "T".repeat(NINE_MB) };
    const env = new Bash({
      javascript: {
        invokeTool: async (path: string) => {
          if (path !== "big.fetch") throw new Error(`Unknown tool: ${path}`);
          return JSON.stringify(payload);
        },
      },
    });
    const result = await env.exec(
      `js-exec -c "var r = await tools['big.fetch']({}); console.log(r.data.length, r.data[0], r.data[r.data.length-1]);"`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${NINE_MB} T T\n`);
    expect(result.exitCode).toBe(0);
  }, 30_000);
});
