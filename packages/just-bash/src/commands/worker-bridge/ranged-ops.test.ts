import { describe, expect, it } from "vitest";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import { BridgeHandler } from "./bridge-handler.js";
import {
  createSharedBuffer,
  ErrorCode,
  OpCode,
  type OpCodeType,
  ProtocolBuffer,
  Status,
} from "./protocol.js";

async function sendOp(
  protocol: ProtocolBuffer,
  opCode: OpCodeType,
  opts?: {
    path?: string;
    data?: Uint8Array;
    flags?: number;
    mode?: number;
  },
): Promise<{ status: number; result: Uint8Array }> {
  protocol.reset();
  protocol.setOpCode(opCode);
  protocol.setPath(opts?.path ?? "");
  protocol.setFlags(opts?.flags ?? 0);
  protocol.setMode(opts?.mode ?? 0);
  if (opts?.data !== undefined) {
    protocol.setData(opts.data);
  }
  protocol.setStatus(Status.READY);
  protocol.notify();

  for (let i = 0; i < 1000; i++) {
    const status = protocol.getStatus();
    if (status === Status.SUCCESS || status === Status.ERROR) {
      return { status, result: protocol.getResult() };
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("sendOp timed out waiting for bridge response");
}

describe("ranged bridge ops", () => {
  it("assembles a large file from ranged writes and reads it back in slices", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
    );
    const run = handler.run(10_000);
    try {
      const chunkA = new Uint8Array(100).fill(65);
      const chunkB = new Uint8Array(50).fill(66);
      const w0 = await sendOp(protocol, OpCode.WRITE_FILE_RANGE, {
        path: "/big.bin",
        data: chunkA,
        flags: 0,
      });
      expect(w0.status).toBe(Status.SUCCESS);
      const w1 = await sendOp(protocol, OpCode.WRITE_FILE_RANGE, {
        path: "/big.bin",
        data: chunkB,
        flags: 100,
      });
      expect(w1.status).toBe(Status.SUCCESS);

      const full = await sendOp(protocol, OpCode.READ_FILE, {
        path: "/big.bin",
      });
      expect(full.status).toBe(Status.SUCCESS);
      expect(full.result.length).toBe(150);
      expect(full.result[0]).toBe(65);
      expect(full.result[149]).toBe(66);
      // Slices of the assembled content are exact.
      expect([...full.result.slice(0, 100)]).toEqual(
        Array.from({ length: 100 }, () => 65),
      );
      expect([...full.result.slice(100)]).toEqual(
        Array.from({ length: 50 }, () => 66),
      );
    } finally {
      handler.stop();
      await run;
    }
  });

  it("rejects a non-sequential range write instead of corrupting the file", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
    );
    const run = handler.run(10_000);
    try {
      await sendOp(protocol, OpCode.WRITE_FILE_RANGE, {
        path: "/f.bin",
        data: new Uint8Array(10).fill(65),
        flags: 0,
      });
      const bad = await sendOp(protocol, OpCode.WRITE_FILE_RANGE, {
        path: "/f.bin",
        data: new Uint8Array(10).fill(66),
        flags: 999, // way past current size
      });
      expect(bad.status).toBe(Status.ERROR);
      expect(new TextDecoder().decode(bad.result)).toContain(
        "non-sequential range write",
      );
      // File untouched.
      const full = await sendOp(protocol, OpCode.READ_FILE, { path: "/f.bin" });
      expect(full.result.length).toBe(10);
    } finally {
      handler.stop();
      await run;
    }
  });

  it("publishes a numeric error code for backend failures", async () => {
    class DenyReadFs extends InMemoryFs {
      override async readFileBuffer(path: string): Promise<Uint8Array> {
        if (path === "/secret.txt") {
          throw new Error("EACCES: permission denied");
        }
        return super.readFileBuffer(path);
      }
    }
    const fs = new DenyReadFs();
    await fs.writeFile("/secret.txt", "x");
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(shared, fs, "/", "test-cmd");
    const run = handler.run(10_000);
    try {
      const res = await sendOp(protocol, OpCode.READ_FILE, {
        path: "/secret.txt",
      });
      expect(res.status).toBe(Status.ERROR);
      expect(protocol.getErrorCode()).toBe(ErrorCode.PERMISSION_DENIED);
    } finally {
      handler.stop();
      await run;
    }
  });
});
