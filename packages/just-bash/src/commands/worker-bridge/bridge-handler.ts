/**
 * Main thread bridge handler
 *
 * Runs on the main thread and processes filesystem, I/O, HTTP, and exec
 * requests from a worker thread via SharedArrayBuffer + Atomics.
 */

import { fromBuffer } from "../../fs/encoding.js";
import { FsError, fsErrorCode } from "../../fs/fs-error.js";
import type { IFileSystem } from "../../fs/interface.js";
import {
  sanitizeErrorMessage,
  sanitizeHostErrorMessage,
} from "../../fs/sanitize-error.js";
import { shellJoinArgs } from "../../helpers/shell-quote.js";
import type { SecureFetch } from "../../network/fetch.js";
import { DefenseInDepthBox } from "../../security/defense-in-depth-box.js";
import { _clearFiniteTimeout, _setTimeoutIfFinite } from "../../timers.js";
import type { CommandExecOptions, ExecResult } from "../../types.js";
import {
  ErrorCode,
  type ErrorCodeType,
  Flags,
  OpCode,
  type OpCodeType,
  ProtocolBuffer,
  RequestState,
  ResultState,
} from "./protocol.js";

export interface BridgeOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Handles requests from a worker thread.
 */
/**
 * Map a carried errno (FsError / node-style .code) to the bridge wire
 * code. This is the ONLY classification on the bridge error path:
 * structured codes in, wire codes out. An error with no structured
 * code is IO_ERROR — an honest unknown, never a fabricated specific
 * code guessed from prose.
 */
const ERRNO_TO_BRIDGE: Record<string, ErrorCodeType> = Object.assign(
  Object.create(null) as Record<string, ErrorCodeType>,
  {
    ENOENT: ErrorCode.NOT_FOUND,
    EISDIR: ErrorCode.IS_DIRECTORY,
    ENOTDIR: ErrorCode.NOT_DIRECTORY,
    ENOTEMPTY: ErrorCode.NOT_EMPTY,
    EEXIST: ErrorCode.EXISTS,
    EACCES: ErrorCode.PERMISSION_DENIED,
    EPERM: ErrorCode.PERMISSION_DENIED,
    EINVAL: ErrorCode.INVALID_PATH,
  },
);

function bridgeErrorCodeFromErrno_(code: string | undefined): ErrorCodeType {
  if (code !== undefined && Object.hasOwn(ERRNO_TO_BRIDGE, code)) {
    return ERRNO_TO_BRIDGE[code];
  }
  return ErrorCode.IO_ERROR;
}

export class BridgeHandler {
  private protocol: ProtocolBuffer;
  private running = false;
  private output: BridgeOutput = { stdout: "", stderr: "", exitCode: 0 };
  private outputLimitExceeded = false;
  private startTime = 0;
  private timeoutMs = 0;
  /** Complete buffer of the last published oversized result, retained
   * so the worker can fetch it in READ_RESULT_RANGE slices. Replaced on
   * every publish. */
  private lastResult: Uint8Array | null = null;

  constructor(
    sharedBuffer: SharedArrayBuffer,
    private fs: IFileSystem,
    private cwd: string,
    private commandName: string,
    private secureFetch: SecureFetch | undefined = undefined,
    private maxOutputSize = 0,
    private exec:
      | ((command: string, options: CommandExecOptions) => Promise<ExecResult>)
      | undefined = undefined,
    private invokeTool:
      | ((path: string, argsJson: string) => Promise<string>)
      | undefined = undefined,
  ) {
    this.protocol = new ProtocolBuffer(sharedBuffer);
  }

  /**
   * Returns remaining milliseconds before the overall execution deadline.
   */
  private remainingMs(): number {
    return Math.max(0, this.timeoutMs - (Date.now() - this.startTime));
  }

  /**
   * Races a promise against the remaining execution deadline.
   * If the deadline expires first, sets `this.running = false` and rejects.
   */
  private raceDeadline<T>(fn: () => Promise<T>): Promise<T> {
    const remaining = this.remainingMs();
    if (remaining <= 0) {
      this.running = false;
      this.output.exitCode = 124;
      this.output.stderr += `\n${this.commandName}: execution timeout exceeded\n`;
      return Promise.reject(new Error("Operation timed out"));
    }
    const promise = fn();
    if (remaining === Number.POSITIVE_INFINITY) return promise;
    return new Promise<T>((resolve, reject) => {
      const timer = _setTimeoutIfFinite(() => {
        this.running = false;
        this.output.exitCode = 124;
        this.output.stderr += `\n${this.commandName}: execution timeout exceeded\n`;
        reject(new Error("Operation timed out"));
      }, remaining);
      promise.then(
        (v) => {
          _clearFiniteTimeout(timer);
          resolve(v);
        },
        (e) => {
          _clearFiniteTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /**
   * Run the handler loop until EXIT operation or timeout.
   */
  async run(timeoutMs: number): Promise<BridgeOutput> {
    this.running = true;
    this.startTime = Date.now();
    this.timeoutMs = timeoutMs;

    while (this.running) {
      const elapsed = Date.now() - this.startTime;
      if (elapsed >= timeoutMs) {
        this.output.stderr += `\n${this.commandName}: execution timeout exceeded\n`;
        this.output.exitCode = 124;
        break;
      }

      // Wait for worker to publish a request
      const remainingMs = this.remainingMs();
      const ready = await this.protocol.waitUntilReady(remainingMs);
      if (!ready) {
        // CANCELLED wakes land here too: stop() already flipped running,
        // so a non-ready wake while stopped is a cancel, not a timeout.
        if (!this.running) break;
        this.output.stderr += `\n${this.commandName}: execution timeout exceeded\n`;
        this.output.exitCode = 124;
        break;
      }
      if (!this.running) break;

      // Consume the request: return the word to IDLE BEFORE handling, so
      // the next loop iteration cannot re-read this request as new. This
      // is the consumption half of the two-word handshake — without it
      // the host would hot-loop on a stale REQUEST (the worker only
      // resets the word at the START of its next op).
      this.protocol.setRequest(RequestState.IDLE);

      const opCode = this.protocol.getOpCode();
      await this.handleOperation(opCode);

      // handleOperation publishes SUCCESS/ERROR on the result word.
      // Notify the worker's result wait.
      this.protocol.notifyResult();
    }

    return this.output;
  }

  stop(): void {
    this.running = false;
    this.lastResult = null;
    // Wake a handler blocked before the worker's first bridge operation.
    // CANCELLED goes on the REQUEST word — it is not a result and can
    // never be torn into a worker's result wait.
    this.protocol.setRequest(RequestState.CANCELLED);
    this.protocol.notifyRequest();
  }

  private async handleOperation(opCode: OpCodeType): Promise<void> {
    try {
      switch (opCode) {
        case OpCode.READ_FILE:
          await this.handleReadFile();
          break;
        case OpCode.WRITE_FILE:
          await this.handleWriteFile();
          break;
        case OpCode.STAT:
          await this.handleStat();
          break;
        case OpCode.LSTAT:
          await this.handleLstat();
          break;
        case OpCode.READDIR:
          await this.handleReaddir();
          break;
        case OpCode.MKDIR:
          await this.handleMkdir();
          break;
        case OpCode.READ_RESULT_RANGE:
          this.handleReadResultRange();
          break;
        case OpCode.WRITE_FILE_RANGE:
          await this.handleWriteFileRange();
          break;
        case OpCode.RM:
          await this.handleRm();
          break;
        case OpCode.EXISTS:
          await this.handleExists();
          break;
        case OpCode.APPEND_FILE:
          await this.handleAppendFile();
          break;
        case OpCode.SYMLINK:
          await this.handleSymlink();
          break;
        case OpCode.READLINK:
          await this.handleReadlink();
          break;
        case OpCode.CHMOD:
          await this.handleChmod();
          break;
        case OpCode.REALPATH:
          await this.handleRealpath();
          break;
        case OpCode.RENAME:
          await this.handleRename();
          break;
        case OpCode.COPY_FILE:
          await this.handleCopyFile();
          break;
        case OpCode.WRITE_STDOUT:
          this.handleWriteStdout();
          break;
        case OpCode.WRITE_STDERR:
          this.handleWriteStderr();
          break;
        case OpCode.EXIT:
          this.handleExit();
          break;
        case OpCode.HTTP_REQUEST:
          await this.handleHttpRequest();
          break;
        case OpCode.EXEC_COMMAND:
          await this.handleExecCommand();
          break;
        case OpCode.INVOKE_TOOL:
          await this.handleInvokeTool();
          break;
        default:
          this.protocol.setErrorCode(ErrorCode.IO_ERROR);
          this.protocol.setResultState(ResultState.ERROR);
      }
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  /** Publish a result of any size; oversized results are fetched by the
   * worker in READ_RESULT_RANGE slices from the retained buffer. */
  private publishResult(data: Uint8Array | string): void {
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.lastResult = bytes;
    this.protocol.setResultPrefix(bytes);
    this.protocol.setResultState(ResultState.SUCCESS);
  }

  private handleReadResultRange(): void {
    const offset = this.protocol.getFlags();
    const length = this.protocol.getMode();
    const retained = this.lastResult;
    if (!retained || offset > retained.length) {
      this.protocol.setErrorCode(ErrorCode.IO_ERROR);
      this.protocol.setResultFromString(
        "No retained result for range read " +
          `(offset=${offset}, length=${length}, retained=${retained?.length ?? "none"})`,
      );
      this.protocol.setResultState(ResultState.ERROR);
      return;
    }
    // Serve via setResult (fits the buffer), NOT publishResult — a
    // range read must not replace the buffer it is reading from.
    this.protocol.setResult(retained.subarray(offset, offset + length));
    this.protocol.setResultState(ResultState.SUCCESS);
  }

  private resolvePath(path: string): string {
    return this.fs.resolvePath(this.cwd, path);
  }

  private async handleReadFile(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const content = await this.fs.readFileBuffer(path);
      this.publishResult(content);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleWriteFileRange(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    const offset = this.protocol.getFlags();
    const data = this.protocol.getData();
    try {
      if (offset === 0) {
        await this.fs.writeFile(path, data);
      } else {
        // Sequential appends are positionally exact; reject anything
        // else rather than corrupt the file silently.
        const st = await this.fs.stat(path);
        if (st.size !== offset) {
          throw new FsError(
            "EIO",
            `non-sequential range write to '${path}': offset ${offset} != size ${st.size}`,
          );
        }
        await this.fs.appendFile(path, data);
      }
      this.protocol.setResultState(ResultState.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleWriteFile(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    const data = this.protocol.getData();
    try {
      await this.fs.writeFile(path, data);
      this.protocol.setResultState(ResultState.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleStat(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const stat = await this.fs.stat(path);
      this.protocol.encodeStat(stat);
      this.protocol.setResultState(ResultState.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleLstat(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const stat = await this.fs.lstat(path);
      this.protocol.encodeStat(stat);
      this.protocol.setResultState(ResultState.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleReaddir(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const entries = await this.fs.readdir(path);
      this.publishResult(JSON.stringify(entries));
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleMkdir(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    const flags = this.protocol.getFlags();
    const recursive = (flags & Flags.MKDIR_RECURSIVE) !== 0;
    try {
      await this.fs.mkdir(path, { recursive });
      this.protocol.setResultState(ResultState.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleRm(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    const flags = this.protocol.getFlags();
    const recursive = (flags & Flags.RECURSIVE) !== 0;
    const force = (flags & Flags.FORCE) !== 0;
    try {
      await this.fs.rm(path, { recursive, force });
      this.protocol.setResultState(ResultState.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleExists(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const exists = await this.fs.exists(path);
      this.protocol.setResult(new Uint8Array([exists ? 1 : 0]));
      this.protocol.setResultState(ResultState.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleAppendFile(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    const data = this.protocol.getData();
    try {
      await this.fs.appendFile(path, data);
      this.protocol.setResultState(ResultState.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleSymlink(): Promise<void> {
    const path = this.protocol.getPath();
    const data = this.protocol.getDataAsString();
    const linkPath = this.resolvePath(path);
    try {
      await this.fs.symlink(data, linkPath);
      this.protocol.setResultState(ResultState.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleReadlink(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const target = await this.fs.readlink(path);
      this.protocol.setResultFromString(target);
      this.protocol.setResultState(ResultState.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleChmod(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    const mode = this.protocol.getMode();
    try {
      await this.fs.chmod(path, mode);
      this.protocol.setResultState(ResultState.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleRealpath(): Promise<void> {
    const path = this.resolvePath(this.protocol.getPath());
    try {
      const realpath = await this.fs.realpath(path);
      this.protocol.setResultFromString(realpath);
      this.protocol.setResultState(ResultState.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleRename(): Promise<void> {
    const oldPath = this.resolvePath(this.protocol.getPath());
    const newPath = this.resolvePath(this.protocol.getDataAsString());
    try {
      await this.fs.mv(oldPath, newPath);
      this.protocol.setResultState(ResultState.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private async handleCopyFile(): Promise<void> {
    const src = this.resolvePath(this.protocol.getPath());
    const dest = this.resolvePath(this.protocol.getDataAsString());
    try {
      await this.fs.cp(src, dest);
      this.protocol.setResultState(ResultState.SUCCESS);
    } catch (e) {
      this.setErrorFromException(e);
    }
  }

  private handleWriteStdout(): void {
    const data = this.protocol.getDataAsString();
    if (!this.tryAppendOutput("stdout", data)) {
      this.outputLimitExceeded = true;
      this.output.exitCode = 1;
      this.appendOutputLimitError();
      this.protocol.setErrorCode(ErrorCode.IO_ERROR);
      this.protocol.setResultFromString("Output size limit exceeded");
      this.protocol.setResultState(ResultState.ERROR);
      return;
    }
    this.protocol.setResultState(ResultState.SUCCESS);
  }

  private handleWriteStderr(): void {
    const data = this.protocol.getDataAsString();
    if (!this.tryAppendOutput("stderr", data)) {
      this.outputLimitExceeded = true;
      this.output.exitCode = 1;
      this.appendOutputLimitError();
      this.protocol.setErrorCode(ErrorCode.IO_ERROR);
      this.protocol.setResultFromString("Output size limit exceeded");
      this.protocol.setResultState(ResultState.ERROR);
      return;
    }
    this.protocol.setResultState(ResultState.SUCCESS);
  }

  private handleExit(): void {
    const exitCode = this.protocol.getFlags();
    if (!this.outputLimitExceeded) {
      this.output.exitCode = exitCode;
    } else if (this.output.exitCode === 0) {
      this.output.exitCode = 1;
    }
    this.protocol.setResultState(ResultState.SUCCESS);
    this.running = false;
  }

  private tryAppendOutput(stream: "stdout" | "stderr", data: string): boolean {
    if (this.outputLimitExceeded) {
      return false;
    }

    if (this.maxOutputSize <= 0) {
      if (stream === "stdout") {
        this.output.stdout += data;
      } else {
        this.output.stderr += data;
      }
      return true;
    }

    const total = this.output.stdout.length + this.output.stderr.length;
    if (total + data.length > this.maxOutputSize) {
      return false;
    }

    if (stream === "stdout") {
      this.output.stdout += data;
    } else {
      this.output.stderr += data;
    }
    return true;
  }

  private appendOutputLimitError(): void {
    if (this.maxOutputSize <= 0) {
      return;
    }

    const fullMsg = `${this.commandName}: total output size exceeded (>${this.maxOutputSize} bytes), increase executionLimits.maxOutputSize\n`;
    const msg =
      fullMsg.length > this.maxOutputSize
        ? fullMsg.slice(0, this.maxOutputSize)
        : fullMsg;
    if (this.output.stderr.includes("total output size exceeded")) {
      return;
    }

    const currentTotal = this.output.stdout.length + this.output.stderr.length;
    const needed = currentTotal + msg.length - this.maxOutputSize;
    if (needed > 0) {
      if (this.output.stdout.length >= needed) {
        this.output.stdout = this.output.stdout.slice(
          0,
          this.output.stdout.length - needed,
        );
      } else {
        const remainingNeeded = needed - this.output.stdout.length;
        this.output.stdout = "";
        if (remainingNeeded >= this.output.stderr.length) {
          this.output.stderr = "";
        } else {
          this.output.stderr = this.output.stderr.slice(
            0,
            this.output.stderr.length - remainingNeeded,
          );
        }
      }
    }
    this.output.stderr += msg;
  }

  private async handleHttpRequest(): Promise<void> {
    const fetchFn = this.secureFetch;
    if (!fetchFn) {
      this.protocol.setErrorCode(ErrorCode.NETWORK_NOT_CONFIGURED);
      this.protocol.setResultFromString(
        "Network access not configured. Enable network in Bash options.",
      );
      this.protocol.setResultState(ResultState.ERROR);
      return;
    }

    const url = this.protocol.getPath();
    const requestJson = this.protocol.getDataAsString();

    try {
      // @banned-pattern-ignore: fallback default for HTTP options, accessed only by known keys below
      const request = requestJson ? JSON.parse(requestJson) : {};
      // Cap fetch to the remaining execution deadline via raceDeadline
      // (secureFetch uses AbortController internally for its timeoutMs,
      // but raceDeadline guarantees we don't hang if it never settles).
      const remaining = this.remainingMs();
      const result = await this.raceDeadline(() =>
        fetchFn(url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          timeoutMs: remaining,
        }),
      );

      // Return response as JSON
      const response = JSON.stringify({
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        bodyBase64: fromBuffer(result.body, "base64"),
        url: result.url,
      });
      this.publishResult(response);
    } catch (e) {
      const message = sanitizeErrorMessage(
        e instanceof Error ? e.message : String(e),
      );
      this.protocol.setErrorCode(ErrorCode.NETWORK_ERROR);
      this.protocol.setResultFromString(message);
      this.protocol.setResultState(ResultState.ERROR);
    }
  }

  private async handleExecCommand(): Promise<void> {
    const execFn = this.exec;
    if (!execFn) {
      this.protocol.setErrorCode(ErrorCode.IO_ERROR);
      this.protocol.setResultFromString(
        "Command execution not available in this context.",
      );
      this.protocol.setResultState(ResultState.ERROR);
      return;
    }

    let command = this.protocol.getPath();
    const dataStr = this.protocol.getDataAsString();

    // Cap exec to the remaining execution deadline via AbortSignal + raceDeadline.
    // AbortSignal provides cooperative cancellation; raceDeadline guarantees
    // we don't hang if exec never respects the signal.
    const controller = new AbortController();
    try {
      const options: CommandExecOptions = {
        cwd: this.cwd,
        signal: controller.signal,
      };
      if (dataStr) {
        const parsed = JSON.parse(dataStr);
        if (parsed.stdin) {
          options.stdin = parsed.stdin;
        }
        // Structured args: pass directly via args option (no shell escaping needed)
        if (parsed.args && Array.isArray(parsed.args)) {
          options.args = parsed.args.map((a: unknown) => String(a));
          command = shellJoinArgs([command]);
        }
      }

      const result = await this.raceDeadline(() => execFn(command, options));

      const response = JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
      this.publishResult(response);
    } catch (e) {
      controller.abort();
      const message = e instanceof Error ? e.message : String(e);
      this.protocol.setErrorCode(ErrorCode.IO_ERROR);
      this.protocol.setResultFromString(message);
      this.protocol.setResultState(ResultState.ERROR);
    }
  }

  private async handleInvokeTool(): Promise<void> {
    const invokeToolFn = this.invokeTool;
    if (!invokeToolFn) {
      this.protocol.setErrorCode(ErrorCode.IO_ERROR);
      this.protocol.setResultFromString(
        "Tool invocation not available in this context.",
      );
      this.protocol.setResultState(ResultState.ERROR);
      return;
    }

    const path = this.protocol.getPath();
    const argsJson = this.protocol.getDataAsString();

    try {
      const resultJson = await this.raceDeadline(() =>
        DefenseInDepthBox.runTrustedAsync(() => invokeToolFn(path, argsJson)),
      );
      this.publishResult(resultJson);
    } catch (e) {
      const message = sanitizeHostErrorMessage(
        e instanceof Error ? e.message : String(e),
      );
      this.protocol.setErrorCode(ErrorCode.IO_ERROR);
      this.protocol.setResultFromString(message);
      this.protocol.setResultState(ResultState.ERROR);
    }
  }

  private setErrorFromException(e: unknown): void {
    const rawMessage = e instanceof Error ? e.message : String(e);
    const message = sanitizeErrorMessage(rawMessage);

    this.protocol.setErrorCode(bridgeErrorCodeFromErrno_(fsErrorCode(e)));
    this.protocol.setResultFromString(message);
    this.protocol.setResultState(ResultState.ERROR);
  }
}
