import { describe, expect, it } from "vitest";
import { FsError } from "../../fs/fs-error.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import type { SecureFetch } from "../../network/fetch.js";
import type { CommandExecOptions, ExecResult } from "../../types.js";
import { BridgeHandler } from "./bridge-handler.js";
import {
  createSharedBuffer,
  ErrorCode,
  OpCode,
  type OpCodeType,
  ProtocolBuffer,
  RequestState,
  ResultState,
} from "./protocol.js";

async function sendOp(
  protocol: ProtocolBuffer,
  opCode: OpCodeType,
  opts?: { path?: string; data?: string; flags?: number },
): Promise<number> {
  protocol.reset();
  protocol.setOpCode(opCode);
  protocol.setPath(opts?.path ?? "");
  protocol.setFlags(opts?.flags ?? 0);
  if (opts?.data !== undefined) {
    protocol.setDataFromString(opts.data);
  }
  protocol.setRequest(RequestState.REQUEST);
  protocol.notifyRequest();

  for (let i = 0; i < 1000; i++) {
    const status = protocol.getResultState();
    if (status === ResultState.SUCCESS || status === ResultState.ERROR) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("sendOp timed out waiting for bridge response");
}

describe("BridgeHandler raceDeadline", () => {
  it("HTTP_REQUEST resolves with error when secureFetch never settles", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const neverSettle: SecureFetch = () => new Promise<never>(() => {});
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
      neverSettle,
    );
    const runPromise = handler.run(200);

    const status = await sendOp(protocol, OpCode.HTTP_REQUEST, {
      path: "https://example.com",
      data: JSON.stringify({ method: "GET" }),
    });

    expect(status).toBe(ResultState.ERROR);
    const errMsg = protocol.getResultAsString();
    expect(errMsg).toContain("timed out");

    const result = await runPromise;
    expect(result.exitCode).toBe(124);
  });

  it("EXEC_COMMAND resolves with error when exec never settles", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const neverSettle: (
      command: string,
      options: CommandExecOptions,
    ) => Promise<ExecResult> = () => new Promise<never>(() => {});
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
      undefined,
      0,
      neverSettle,
    );
    const runPromise = handler.run(200);

    const status = await sendOp(protocol, OpCode.EXEC_COMMAND, {
      path: "echo hello",
    });

    expect(status).toBe(ResultState.ERROR);
    const errMsg = protocol.getResultAsString();
    expect(errMsg).toContain("timed out");

    const result = await runPromise;
    expect(result.exitCode).toBe(124);
  });

  it("INVOKE_TOOL resolves with error when invokeTool never settles", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const neverSettle: (path: string, argsJson: string) => Promise<string> =
      () => new Promise<never>(() => {});
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
      undefined,
      0,
      undefined,
      neverSettle,
    );
    const runPromise = handler.run(200);

    const status = await sendOp(protocol, OpCode.INVOKE_TOOL, {
      path: "tool.slow",
      data: "{}",
    });

    expect(status).toBe(ResultState.ERROR);
    const errMsg = protocol.getResultAsString();
    expect(errMsg).toContain("timed out");

    const result = await runPromise;
    expect(result.exitCode).toBe(124);
  });

  it("INVOKE_TOOL sanitizes host-originated error messages", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
      undefined,
      0,
      undefined,
      async () => {
        throw new Error(
          "failed at /Users/alice/project/secret.txt from file:///Users/alice/project/tool.js\n    at internal",
        );
      },
    );
    const runPromise = handler.run(1000);

    const status = await sendOp(protocol, OpCode.INVOKE_TOOL, {
      path: "tool.fail",
      data: "{}",
    });

    expect(status).toBe(ResultState.ERROR);
    const errMsg = protocol.getResultAsString();
    expect(errMsg).toContain("<path>");
    expect(errMsg).not.toContain("/Users/alice");
    expect(errMsg).not.toContain("file://");
    expect(errMsg).not.toContain("at internal");

    await sendOp(protocol, OpCode.EXIT, { flags: 0 });
    const result = await runPromise;
    expect(result.exitCode).toBe(0);
  });
});

describe("BridgeHandler stop() channel isolation", () => {
  it("stop() writes CANCELLED on the request word and NEVER touches the result word", async () => {
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
    );
    const run = handler.run(10_000);
    // Mid-idle stop: no op was ever published.
    handler.stop();
    await run;
    // The headline two-word property: a cancel wake is only ever a
    // request-channel value; the result word stays NONE, so a worker
    // parked in a result wait cannot be torn by stop().
    expect(protocol.getRequest()).toBe(RequestState.CANCELLED);
    expect(protocol.getResultState()).toBe(ResultState.NONE);
  });

  it("a cancelled wait ends the run without a timeout record", async () => {
    const shared = createSharedBuffer();
    const handler = new BridgeHandler(
      shared,
      new InMemoryFs(),
      "/",
      "test-cmd",
    );
    const run = handler.run(60_000);
    handler.stop();
    const output = await run;
    // Cancel, not timeout: no "execution timeout exceeded" record.
    expect(output.stderr).toBe("");
    expect(output.exitCode).toBe(0);
  });
});

describe("ERRNO_TO_BRIDGE mapping", () => {
  it.each([
    ["ENOENT", ErrorCode.NOT_FOUND],
    ["EISDIR", ErrorCode.IS_DIRECTORY],
    ["ENOTDIR", ErrorCode.NOT_DIRECTORY],
    ["ENOTEMPTY", ErrorCode.NOT_EMPTY],
    ["EEXIST", ErrorCode.EXISTS],
    ["EACCES", ErrorCode.PERMISSION_DENIED],
    ["EPERM", ErrorCode.PERMISSION_DENIED],
    ["EINVAL", ErrorCode.INVALID_PATH],
    ["ELOOP", ErrorCode.LOOP],
    ["EFBIG", ErrorCode.FILE_TOO_LARGE],
    ["ENOSPC", ErrorCode.NO_SPACE],
    ["EBUSY", ErrorCode.BUSY],
    ["EROFS", ErrorCode.READ_ONLY],
    ["EXDEV", ErrorCode.CROSS_DEVICE],
  ])("maps %s to its wire code", async (errno, wire) => {
    class ThrowFs extends InMemoryFs {
      override async readFileBuffer(): Promise<Uint8Array> {
        throw new FsError(errno, "injected");
      }
    }
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(shared, new ThrowFs(), "/", "test-cmd");
    const run = handler.run(10_000);
    try {
      const status = await sendOp(protocol, OpCode.READ_FILE, { path: "/x" });
      expect(status).toBe(ResultState.ERROR);
      expect(protocol.getErrorCode()).toBe(wire);
    } finally {
      handler.stop();
      await run;
    }
  });

  it("maps an unknown structured code to honest IO_ERROR", async () => {
    class ThrowFs extends InMemoryFs {
      override async readFileBuffer(): Promise<Uint8Array> {
        throw new FsError("EDQUOT", "injected");
      }
    }
    const shared = createSharedBuffer();
    const protocol = new ProtocolBuffer(shared);
    const handler = new BridgeHandler(shared, new ThrowFs(), "/", "test-cmd");
    const run = handler.run(10_000);
    try {
      const status = await sendOp(protocol, OpCode.READ_FILE, { path: "/x" });
      expect(status).toBe(ResultState.ERROR);
      expect(protocol.getErrorCode()).toBe(ErrorCode.IO_ERROR);
    } finally {
      handler.stop();
      await run;
    }
  });
});
