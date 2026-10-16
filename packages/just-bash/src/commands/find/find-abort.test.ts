import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import { OverlayFs } from "../../fs/overlay-fs/overlay-fs.js";

describe("find abort safety", () => {
  it("abort before traversal starts returns 124 cleanly", async () => {
    const fs = new InMemoryFs();
    fs.mkdirSync("/dir", { recursive: true });
    fs.writeFileSync("/dir/file.txt", "content");

    const env = new Bash({ fs });
    const controller = new AbortController();
    controller.abort();

    const result = await env.exec("find / -type f", {
      signal: controller.signal,
    });
    expect(result.exitCode).toBe(124);
  });

  it(
    "abort mid-traversal returns 124 without throwing",
    { timeout: 30000 },
    async () => {
      // Real filesystem ensures traversal takes long enough for abort to fire
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "find-abort-test-"));
      try {
        for (let d = 0; d < 100; d++) {
          const dir = path.join(tmp, `dir${d}`);
          fs.mkdirSync(dir, { recursive: true });
          for (let f = 0; f < 50; f++) {
            fs.writeFileSync(path.join(dir, `file${f}.txt`), "content");
          }
        }

        const overlay = new OverlayFs({ root: tmp });
        const env = new Bash({ fs: overlay });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 5);

        // Must not throw — abort should be caught and returned as exit 124
        const result = await env.exec("find / -type f", {
          signal: controller.signal,
        });
        expect([0, 124]).toContain(result.exitCode);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
