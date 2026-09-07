/**
 * Worker-side synchronous backend
 *
 * Runs in the worker thread and makes synchronous calls to the main thread
 * via SharedArrayBuffer + Atomics.
 */

import {
  Flags,
  OpCode,
  type OpCodeType,
  ProtocolBuffer,
  RequestState,
  ResultState,
  Size,
  wireToErrnoName,
} from "./protocol.js";

/**
 * Synchronous backend for worker threads.
 */
export class SyncBackend {
  private protocol: ProtocolBuffer;
  private operationTimeoutMs: number;

  constructor(sharedBuffer: SharedArrayBuffer, operationTimeoutMs = 30000) {
    this.protocol = new ProtocolBuffer(sharedBuffer);
    this.operationTimeoutMs = operationTimeoutMs;
  }

  private execSync(
    opCode: OpCodeType,
    path: string,
    data?: Uint8Array,
    flags = 0,
    mode = 0,
  ): {
    success: boolean;
    result?: Uint8Array;
    error?: string;
    errorCode?: number;
  } {
    this.protocol.reset();
    this.protocol.setOpCode(opCode);
    this.protocol.setPath(path);
    this.protocol.setFlags(flags);
    this.protocol.setMode(mode);
    if (data) {
      this.protocol.setData(data);
    }

    this.protocol.setRequest(RequestState.REQUEST);
    this.protocol.notifyRequest();

    // Wait on the RESULT word (host-only). With the two-word protocol,
    // stop() never touches this word, so a wake here is always a real
    // result publish — the torn-read class is unrepresentable. A state
    // outside the ResultState table is a genuine protocol bug and fails
    // loudly below.
    const waitResult = this.protocol.waitForResult(this.operationTimeoutMs);
    if (waitResult === "timed-out") {
      return { success: false, error: "Operation timed out" };
    }

    const resultState = this.protocol.getResultState();
    if (resultState === ResultState.SUCCESS) {
      const totalLength = this.protocol.getResultLength();
      if (totalLength <= Size.DATA_BUFFER) {
        return { success: true, result: this.protocol.getResult() };
      }
      // Oversized result: the first DATA_BUFFER bytes are in the region
      // and the host retains the full buffer. Assemble the rest with
      // generic range reads — transparent for every op (file reads,
      // HTTP responses, tool results, exec output, readdir).
      const content = new Uint8Array(totalLength);
      content.set(this.protocol.getResult().subarray(0, Size.DATA_BUFFER), 0);
      let offset = Size.DATA_BUFFER;
      while (offset < totalLength) {
        const length = Math.min(Size.DATA_BUFFER, totalLength - offset);
        const slice = this.execSync(
          OpCode.READ_RESULT_RANGE,
          "",
          undefined,
          offset,
          length,
        );
        if (!slice.success) {
          throw this.opError_("Failed to read result range", slice);
        }
        const chunk = slice.result ?? new Uint8Array(0);
        content.set(chunk, offset);
        offset += chunk.length;
        if (chunk.length === 0) {
          // Unreachable with the current honest host; if it ever fires,
          // the tail would be zeros — fail hard rather than return a
          // corrupt success.
          throw this.opError_("bridge returned an empty result slice", slice);
        }
      }
      return { success: true, result: content };
    }
    if (resultState === ResultState.ERROR) {
      return {
        success: false,
        error:
          this.protocol.getResultAsString() ||
          // Impossible by construction: every host error path publishes a
          // code and message. If this ever fires, the diagnostic payload
          // must identify the exact protocol state.
          `bridge protocol violation: op ${opCode} ERROR with empty message ` +
            `(wait=${waitResult}, errorCode=${this.protocol.getErrorCode()})`,
        errorCode: this.protocol.getErrorCode(),
      };
    }
    // Neither SUCCESS nor ERROR: impossible under the two-word protocol
    // (the result wait only wakes on a result publish). Fail loudly.
    return {
      success: false,
      error:
        `bridge protocol violation: op ${opCode} woke with resultState ` +
        `${resultState} (wait=${waitResult}, errorCode=${this.protocol.getErrorCode()})`,
      errorCode: this.protocol.getErrorCode(),
    };
  }

  /** Build an op failure that preserves the bridge's numeric error code,
   * so downstream errno mapping prefers it over substring matching. */
  private opError_(
    fallback: string,
    result: { error?: string; errorCode?: number },
  ): Error {
    const err = new Error(result.error || fallback) as Error & {
      bridgeErrorCode?: number;
      code?: string;
    };
    err.bridgeErrorCode = result.errorCode;
    // Node-style .code for guests (js-exec fs shims surface error.code
    // to guest code): derived from the shared wire table, never parsed.
    if (result.errorCode !== undefined) {
      const name = wireToErrnoName(result.errorCode);
      if (name !== undefined) err.code = name;
    }
    return err;
  }

  readFile(path: string): Uint8Array {
    // Any size works: execSync assembles oversized results from the
    // host's retained buffer (a consistent snapshot), so there is no
    // transport ceiling and no stat round-trip.
    const result = this.execSync(OpCode.READ_FILE, path);
    if (!result.success) {
      throw this.opError_("Failed to read file", result);
    }
    return result.result ?? new Uint8Array(0);
  }

  writeFile(path: string, data: Uint8Array): void {
    if (data.length <= Size.DATA_BUFFER) {
      const result = this.execSync(OpCode.WRITE_FILE, path, data);
      if (!result.success) {
        throw this.opError_("Failed to write file", result);
      }
      return;
    }
    // Large writes stream as sequential ranges: offset 0 creates/
    // truncates, subsequent chunks append (positionally exact).
    let offset = 0;
    while (offset < data.length) {
      const chunk = data.subarray(offset, offset + Size.DATA_BUFFER);
      const result = this.execSync(
        OpCode.WRITE_FILE_RANGE,
        path,
        chunk,
        offset,
      );
      if (!result.success) {
        throw this.opError_("Failed to write file", result);
      }
      offset += chunk.length;
    }
  }

  stat(path: string): {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    mode: number;
    size: number;
    mtime: Date;
  } {
    const result = this.execSync(OpCode.STAT, path);
    if (!result.success) {
      throw this.opError_("Failed to stat", result);
    }
    return this.protocol.decodeStat();
  }

  lstat(path: string): {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    mode: number;
    size: number;
    mtime: Date;
  } {
    const result = this.execSync(OpCode.LSTAT, path);
    if (!result.success) {
      throw this.opError_("Failed to lstat", result);
    }
    return this.protocol.decodeStat();
  }

  readdir(path: string): string[] {
    const result = this.execSync(OpCode.READDIR, path);
    if (!result.success) {
      throw this.opError_("Failed to readdir", result);
    }
    return JSON.parse(this.protocol.getResultAsString());
  }

  mkdir(path: string, recursive = false): void {
    const flags = recursive ? Flags.MKDIR_RECURSIVE : 0;
    const result = this.execSync(OpCode.MKDIR, path, undefined, flags);
    if (!result.success) {
      throw this.opError_("Failed to mkdir", result);
    }
  }

  rm(path: string, recursive = false, force = false): void {
    let flags = 0;
    if (recursive) flags |= Flags.RECURSIVE;
    if (force) flags |= Flags.FORCE;
    const result = this.execSync(OpCode.RM, path, undefined, flags);
    if (!result.success) {
      throw this.opError_("Failed to rm", result);
    }
  }

  exists(path: string): boolean {
    const result = this.execSync(OpCode.EXISTS, path);
    if (!result.success) {
      return false;
    }
    return result.result?.[0] === 1;
  }

  appendFile(path: string, data: Uint8Array): void {
    const result = this.execSync(OpCode.APPEND_FILE, path, data);
    if (!result.success) {
      throw this.opError_("Failed to append file", result);
    }
  }

  symlink(target: string, linkPath: string): void {
    const targetData = new TextEncoder().encode(target);
    const result = this.execSync(OpCode.SYMLINK, linkPath, targetData);
    if (!result.success) {
      throw this.opError_("Failed to symlink", result);
    }
  }

  readlink(path: string): string {
    const result = this.execSync(OpCode.READLINK, path);
    if (!result.success) {
      throw this.opError_("Failed to readlink", result);
    }
    return this.protocol.getResultAsString();
  }

  chmod(path: string, mode: number): void {
    const result = this.execSync(OpCode.CHMOD, path, undefined, 0, mode);
    if (!result.success) {
      throw this.opError_("Failed to chmod", result);
    }
  }

  realpath(path: string): string {
    const result = this.execSync(OpCode.REALPATH, path);
    if (!result.success) {
      throw this.opError_("Failed to realpath", result);
    }
    return this.protocol.getResultAsString();
  }

  rename(oldPath: string, newPath: string): void {
    const newPathData = new TextEncoder().encode(newPath);
    const result = this.execSync(OpCode.RENAME, oldPath, newPathData);
    if (!result.success) {
      throw this.opError_("Failed to rename", result);
    }
  }

  copyFile(src: string, dest: string): void {
    const destData = new TextEncoder().encode(dest);
    const result = this.execSync(OpCode.COPY_FILE, src, destData);
    if (!result.success) {
      throw this.opError_("Failed to copyFile", result);
    }
  }

  writeStdout(data: string): void {
    const encoded = new TextEncoder().encode(data);
    const result = this.execSync(OpCode.WRITE_STDOUT, "", encoded);
    if (!result.success) {
      throw this.opError_("Failed to write stdout", result);
    }
  }

  writeStderr(data: string): void {
    const encoded = new TextEncoder().encode(data);
    const result = this.execSync(OpCode.WRITE_STDERR, "", encoded);
    if (!result.success) {
      throw this.opError_("Failed to write stderr", result);
    }
  }

  exit(code: number): void {
    this.execSync(OpCode.EXIT, "", undefined, code);
  }

  /**
   * Make an HTTP request through the main thread's secureFetch.
   * Returns the response as a parsed object.
   */
  httpRequest(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    bodyBase64: string;
    url: string;
  } {
    const requestData = options
      ? new TextEncoder().encode(JSON.stringify(options))
      : undefined;
    const result = this.execSync(OpCode.HTTP_REQUEST, url, requestData);
    if (!result.success) {
      throw this.opError_("HTTP request failed", result);
    }
    const responseJson = new TextDecoder().decode(result.result);
    const parsed = JSON.parse(responseJson) as {
      status: number;
      statusText: string;
      headers: Record<string, string>;
      url: string;
      bodyBase64: string;
    };
    const bodyBase64 = parsed.bodyBase64 ?? "";
    const body = atob(bodyBase64);
    return {
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
      url: parsed.url,
      body,
      bodyBase64,
    };
  }

  /**
   * Execute a shell command through the main thread's exec function.
   * Returns the result as { stdout, stderr, exitCode }.
   */
  execCommand(
    command: string,
    stdin?: string,
  ): {
    stdout: string;
    stderr: string;
    exitCode: number;
  } {
    const requestData = stdin
      ? new TextEncoder().encode(JSON.stringify({ stdin }))
      : undefined;
    const result = this.execSync(OpCode.EXEC_COMMAND, command, requestData);
    if (!result.success) {
      throw this.opError_("Command execution failed", result);
    }
    const responseJson = new TextDecoder().decode(result.result);
    return JSON.parse(responseJson);
  }

  /**
   * Execute a shell command with structured args (shell-escaped on the main thread).
   * Prevents command injection from unsanitized args.
   */
  execCommandArgs(
    command: string,
    args: string[],
  ): {
    stdout: string;
    stderr: string;
    exitCode: number;
  } {
    const requestData = new TextEncoder().encode(JSON.stringify({ args }));
    const result = this.execSync(OpCode.EXEC_COMMAND, command, requestData);
    if (!result.success) {
      throw this.opError_("Command execution failed", result);
    }
    const responseJson = new TextDecoder().decode(result.result);
    return JSON.parse(responseJson);
  }

  /**
   * Invoke a tool through the main thread's invokeTool hook.
   * Returns the JSON-serialized result.
   */
  invokeTool(path: string, argsJson: string): string {
    const requestData = argsJson
      ? new TextEncoder().encode(argsJson)
      : undefined;
    const result = this.execSync(OpCode.INVOKE_TOOL, path, requestData);
    if (!result.success) {
      throw this.opError_("Tool invocation failed", result);
    }
    return new TextDecoder().decode(result.result);
  }
}
