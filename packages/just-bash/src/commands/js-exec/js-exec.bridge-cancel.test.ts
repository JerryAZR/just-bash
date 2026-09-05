import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Bash } from "../../Bash.js";

// A request-level cancel (timeout/abort) while a bridge op is in flight
// must report as that cancellation (exit 124), never as a torn bridge
// read. bridgeHandler.stop() writes READY + notifies to wake the host
// loop; Atomics.notify also wakes the worker's result wait even though
// the status value did not change, and reading that unchanged state used
// to produce a garbage "Error code: 0" guest error that raced the
// timeout resolution — surfacing as exit 1 under CI load. The worker now
// re-waits on READY-after-wake (spurious by protocol), so the cancel
// resolves cleanly.
describe("js-exec bridge cancel during in-flight op", () => {
  const originalFetch = global.fetch;
  beforeAll(() => {
    global.fetch = vi.fn(
      () => new Promise<Response>(() => {}),
    ) as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("request timeout mid-op reports 124, not a torn bridge error", async () => {
    const env = new Bash({
      javascript: true,
      network: { allowedUrlPrefixes: ["http://example.com/"] },
      executionLimits: { maxJsTimeoutMs: 800 },
    });
    const result = await env.exec(
      `js-exec -c "var r = await fetch('http://example.com/'); console.log(r.status)"`,
    );
    expect(result.exitCode).toBe(124);
    expect(result.stderr).not.toContain("Error code:");
    expect(result.stderr).not.toContain("bridge protocol violation");
  }, 20_000);

  it("abort mid-op reports 124, not a torn bridge error", async () => {
    const env = new Bash({
      javascript: true,
      network: { allowedUrlPrefixes: ["http://example.com/"] },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 800);
    const result = await env.exec(
      `js-exec -c "var r = await fetch('http://example.com/'); console.log(r.status)"`,
      { signal: controller.signal },
    );
    expect(result.exitCode).toBe(124);
    expect(result.stderr).not.toContain("Error code:");
    expect(result.stderr).not.toContain("bridge protocol violation");
  }, 20_000);
});
