/**
 * SharedArrayBuffer protocol for synchronous worker bridge
 *
 * This protocol enables synchronous filesystem and I/O access from a worker thread
 * (where CPython/Python or QuickJS runs) to the main thread (which has async IFileSystem).
 */

// Type declaration for Atomics.waitAsync (available in Node.js but not in TS lib)
declare global {
  interface Atomics {
    waitAsync(
      typedArray: Int32Array,
      index: number,
      value: number,
      timeout?: number,
    ):
      | { async: false; value: "not-equal" | "timed-out" }
      | { async: true; value: Promise<"ok" | "timed-out"> };
  }
}

/** Operation codes */
export const OpCode = {
  NOOP: 0,
  READ_FILE: 1,
  WRITE_FILE: 2,
  STAT: 3,
  READDIR: 4,
  MKDIR: 5,
  RM: 6,
  EXISTS: 7,
  APPEND_FILE: 8,
  SYMLINK: 9,
  READLINK: 10,
  LSTAT: 11,
  CHMOD: 12,
  REALPATH: 13,
  RENAME: 14,
  COPY_FILE: 15,
  // Ranged variant for write payloads larger than the data buffer.
  // FLAGS carries the file offset (uint32); the chunk length is its
  // DATA_LENGTH. (Reads use plain READ_FILE plus the generic
  // READ_RESULT_RANGE assembly; only the write direction needs this.)
  WRITE_FILE_RANGE: 17,
  // Fetch the next slice of an oversized result (any op). The host
  // publishes the first DATA_BUFFER bytes with the FULL length in
  // RESULT_LENGTH and retains the complete buffer; the worker loops
  // this op (FLAGS = offset, MODE = length) to assemble the rest.
  READ_RESULT_RANGE: 18,
  // Special operations for I/O
  WRITE_STDOUT: 100,
  WRITE_STDERR: 101,
  EXIT: 102,
  // HTTP operations
  HTTP_REQUEST: 200,
  // Sub-shell execution
  EXEC_COMMAND: 300,
  // Tool invocation (executor mode)
  INVOKE_TOOL: 400,
} as const;

export type OpCodeType = (typeof OpCode)[keyof typeof OpCode];

/**
 * Two-word request/result state. The previous single STATUS word was
 * written by THREE actors with TWO meanings (worker READY = "request
 * published", host SUCCESS/ERROR = "result published", stop() READY =
 * "wake for cancel") — a worker waiting for a result could observe a
 * request-channel value and read a torn buffer (the CI flake class).
 * Splitting the channels makes the torn state unrepresentable: a
 * result wait is only ever woken by a result write. A state outside
 * the tables on wake is a genuine protocol bug and fails loudly.
 */

/** Worker + stop() write; the host waits on this word. */
export const RequestState = {
  IDLE: 0,
  /** Worker has published an op. */
  REQUEST: 1,
  /** stop() cancellation wake. The host treats any non-REQUEST wake as
   * loop-abort (stop() also flips its `running` flag). */
  CANCELLED: 2,
} as const;
type RequestStateType = (typeof RequestState)[keyof typeof RequestState];

/** Host writes; the worker waits on this word. stop() never touches
 * it, so a result wait cannot be torn by cancellation. */
export const ResultState = {
  NONE: 0,
  SUCCESS: 1,
  ERROR: 2,
} as const;
type ResultStateType = (typeof ResultState)[keyof typeof ResultState];

/** Error codes */
export const ErrorCode = {
  NONE: 0,
  NOT_FOUND: 1,
  IS_DIRECTORY: 2,
  NOT_DIRECTORY: 3,
  EXISTS: 4,
  PERMISSION_DENIED: 5,
  INVALID_PATH: 6,
  IO_ERROR: 7,
  NETWORK_ERROR: 9,
  NETWORK_NOT_CONFIGURED: 10,
  NOT_EMPTY: 11,
  LOOP: 12,
  FILE_TOO_LARGE: 13,
  NO_SPACE: 14,
  BUSY: 15,
  READ_ONLY: 16,
  CROSS_DEVICE: 17,
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * The canonical errno-name <-> wire-code table. Both bridge sides ship
 * together, so the table lives here (not per-side copies): the host
 * maps thrown errnos to wire codes with it, and workers derive guest-
 * facing codes from its inverse via wireToErrnoName(). EPERM precedes
 * EACCES so the inverse prefers the common node spelling.
 */
export const ERRNO_TO_WIRE: Record<string, ErrorCodeType> = Object.assign(
  Object.create(null) as Record<string, ErrorCodeType>,
  {
    ENOENT: ErrorCode.NOT_FOUND,
    EISDIR: ErrorCode.IS_DIRECTORY,
    ENOTDIR: ErrorCode.NOT_DIRECTORY,
    ENOTEMPTY: ErrorCode.NOT_EMPTY,
    EEXIST: ErrorCode.EXISTS,
    EPERM: ErrorCode.PERMISSION_DENIED,
    EACCES: ErrorCode.PERMISSION_DENIED,
    EINVAL: ErrorCode.INVALID_PATH,
    ELOOP: ErrorCode.LOOP,
    EFBIG: ErrorCode.FILE_TOO_LARGE,
    ENOSPC: ErrorCode.NO_SPACE,
    EBUSY: ErrorCode.BUSY,
    EROFS: ErrorCode.READ_ONLY,
    EXDEV: ErrorCode.CROSS_DEVICE,
  },
);

const WIRE_TO_ERRNO: Record<number, string> = Object.create(
  null,
) as Record<number, string>;
for (const [name, code] of Object.entries(ERRNO_TO_WIRE)) {
  WIRE_TO_ERRNO[code] = name;
}

/** Errno name for a wire code, or undefined for non-errno wire codes
 * (NONE, IO_ERROR, network conditions). PERMISSION_DENIED inverts to
 * EACCES (the more common spelling in node guests). */
export function wireToErrnoName(code: number): string | undefined {
  return Object.hasOwn(WIRE_TO_ERRNO, code) ? WIRE_TO_ERRNO[code] : undefined;
}

/** Buffer layout offsets */
const Offset = {
  OP_CODE: 0,
  REQUEST: 4,
  PATH_LENGTH: 8,
  DATA_LENGTH: 12,
  RESULT_LENGTH: 16,
  ERROR_CODE: 20,
  FLAGS: 24,
  MODE: 28,
  RESULT_STATE: 32,
  PATH_BUFFER: 36,
  DATA_BUFFER: 4132, // 36 + 4096
} as const;

/** Buffer sizes */
export const Size = {
  PATH_BUFFER: 4096,
  // 8MB transfer CHUNK size — not a semantic cap. Results larger than
  // this are assembled transparently (READ_RESULT_RANGE), and large
  // writes stream as WRITE_FILE_RANGE chunks. Sized to keep ordinary
  // ops single-transfer while bounding per-transfer copies.
  DATA_BUFFER: 8388608,
  TOTAL: 8392740, // 36 + 4096 + 8MB
} as const;

/** Flags for operations */
export const Flags = {
  NONE: 0,
  RECURSIVE: 1,
  FORCE: 2,
  MKDIR_RECURSIVE: 1,
} as const;

/** Stat result structure layout */
const StatLayout = {
  IS_FILE: 0,
  IS_DIRECTORY: 1,
  IS_SYMLINK: 2,
  MODE: 4,
  SIZE: 8,
  MTIME: 16,
  TOTAL: 24,
} as const;

/** Create a new SharedArrayBuffer for the protocol */
import {
  _Atomics,
  _SharedArrayBuffer,
} from "../../security/trusted-globals.js";
export function createSharedBuffer(): SharedArrayBuffer {
  return new _SharedArrayBuffer(Size.TOTAL);
}

/**
 * Helper class for reading/writing protocol data
 */
export class ProtocolBuffer {
  private int32View: Int32Array;
  private uint8View: Uint8Array;
  private dataView: DataView;

  constructor(buffer: SharedArrayBuffer) {
    this.int32View = new Int32Array(buffer);
    this.uint8View = new Uint8Array(buffer);
    this.dataView = new DataView(buffer);
  }

  getOpCode(): OpCodeType {
    return _Atomics.load(this.int32View, Offset.OP_CODE / 4) as OpCodeType;
  }

  setOpCode(code: OpCodeType): void {
    _Atomics.store(this.int32View, Offset.OP_CODE / 4, code);
  }

  getRequest(): RequestStateType {
    return _Atomics.load(
      this.int32View,
      Offset.REQUEST / 4,
    ) as RequestStateType;
  }

  setRequest(request: RequestStateType): void {
    _Atomics.store(this.int32View, Offset.REQUEST / 4, request);
  }

  getResultState(): ResultStateType {
    return _Atomics.load(
      this.int32View,
      Offset.RESULT_STATE / 4,
    ) as ResultStateType;
  }

  setResultState(state: ResultStateType): void {
    _Atomics.store(this.int32View, Offset.RESULT_STATE / 4, state);
  }

  getPathLength(): number {
    return _Atomics.load(this.int32View, Offset.PATH_LENGTH / 4);
  }

  setPathLength(length: number): void {
    _Atomics.store(this.int32View, Offset.PATH_LENGTH / 4, length);
  }

  getDataLength(): number {
    return _Atomics.load(this.int32View, Offset.DATA_LENGTH / 4);
  }

  setDataLength(length: number): void {
    _Atomics.store(this.int32View, Offset.DATA_LENGTH / 4, length);
  }

  getResultLength(): number {
    return _Atomics.load(this.int32View, Offset.RESULT_LENGTH / 4);
  }

  setResultLength(length: number): void {
    _Atomics.store(this.int32View, Offset.RESULT_LENGTH / 4, length);
  }

  getErrorCode(): ErrorCodeType {
    return _Atomics.load(
      this.int32View,
      Offset.ERROR_CODE / 4,
    ) as ErrorCodeType;
  }

  setErrorCode(code: ErrorCodeType): void {
    _Atomics.store(this.int32View, Offset.ERROR_CODE / 4, code);
  }

  getFlags(): number {
    return _Atomics.load(this.int32View, Offset.FLAGS / 4);
  }

  setFlags(flags: number): void {
    _Atomics.store(this.int32View, Offset.FLAGS / 4, flags);
  }

  getMode(): number {
    return _Atomics.load(this.int32View, Offset.MODE / 4);
  }

  setMode(mode: number): void {
    _Atomics.store(this.int32View, Offset.MODE / 4, mode);
  }

  getPath(): string {
    const length = this.getPathLength();
    const bytes = this.uint8View.slice(
      Offset.PATH_BUFFER,
      Offset.PATH_BUFFER + length,
    );
    return new TextDecoder().decode(bytes);
  }

  setPath(path: string): void {
    const encoded = new TextEncoder().encode(path);
    if (encoded.length > Size.PATH_BUFFER) {
      throw new Error(`Path too long: ${encoded.length} > ${Size.PATH_BUFFER}`);
    }
    this.uint8View.set(encoded, Offset.PATH_BUFFER);
    this.setPathLength(encoded.length);
  }

  getData(): Uint8Array {
    const length = this.getDataLength();
    return this.uint8View.slice(
      Offset.DATA_BUFFER,
      Offset.DATA_BUFFER + length,
    );
  }

  setData(data: Uint8Array): void {
    if (data.length > Size.DATA_BUFFER) {
      throw new Error(`Data too large: ${data.length} > ${Size.DATA_BUFFER}`);
    }
    this.uint8View.set(data, Offset.DATA_BUFFER);
    this.setDataLength(data.length);
  }

  getDataAsString(): string {
    const data = this.getData();
    return new TextDecoder().decode(data);
  }

  setDataFromString(str: string): void {
    const encoded = new TextEncoder().encode(str);
    this.setData(encoded);
  }

  getResult(): Uint8Array {
    const length = this.getResultLength();
    return this.uint8View.slice(
      Offset.DATA_BUFFER,
      Offset.DATA_BUFFER + length,
    );
  }

  setResult(data: Uint8Array): void {
    if (data.length > Size.DATA_BUFFER) {
      throw new Error(`Result too large: ${data.length} > ${Size.DATA_BUFFER}`);
    }
    this.uint8View.set(data, Offset.DATA_BUFFER);
    this.setResultLength(data.length);
  }

  /**
   * Publish a result of ANY size: the first DATA_BUFFER bytes land in
   * the data region and RESULT_LENGTH carries the FULL length. The
   * worker detects the overflow and fetches the rest with
   * READ_RESULT_RANGE ops (served from the host's retained buffer).
   */
  setResultPrefix(data: Uint8Array): void {
    if (data.length > 0x7fffffff) {
      // RESULT_LENGTH is int32; an overflowing length would wrap
      // negative and surface downstream as an empty SUCCESS.
      throw new Error(`Result too large: ${data.length} exceeds int32`);
    }
    const n = Math.min(data.length, Size.DATA_BUFFER);
    this.uint8View.set(data.subarray(0, n), Offset.DATA_BUFFER);
    this.setResultLength(data.length);
  }

  getResultAsString(): string {
    const result = this.getResult();
    return new TextDecoder().decode(result);
  }

  setResultFromString(str: string): void {
    const encoded = new TextEncoder().encode(str);
    this.setResult(encoded);
  }

  encodeStat(stat: {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    mode: number;
    size: number;
    mtime: Date;
  }): void {
    this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_FILE] = stat.isFile
      ? 1
      : 0;
    this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_DIRECTORY] =
      stat.isDirectory ? 1 : 0;
    this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_SYMLINK] =
      stat.isSymbolicLink ? 1 : 0;
    this.dataView.setInt32(
      Offset.DATA_BUFFER + StatLayout.MODE,
      stat.mode,
      true,
    );
    const size = Math.min(stat.size, Number.MAX_SAFE_INTEGER);
    this.dataView.setFloat64(Offset.DATA_BUFFER + StatLayout.SIZE, size, true);
    this.dataView.setFloat64(
      Offset.DATA_BUFFER + StatLayout.MTIME,
      stat.mtime.getTime(),
      true,
    );
    this.setResultLength(StatLayout.TOTAL);
  }

  decodeStat(): {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    mode: number;
    size: number;
    mtime: Date;
  } {
    return {
      isFile: this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_FILE] === 1,
      isDirectory:
        this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_DIRECTORY] === 1,
      isSymbolicLink:
        this.uint8View[Offset.DATA_BUFFER + StatLayout.IS_SYMLINK] === 1,
      mode: this.dataView.getInt32(Offset.DATA_BUFFER + StatLayout.MODE, true),
      size: this.dataView.getFloat64(
        Offset.DATA_BUFFER + StatLayout.SIZE,
        true,
      ),
      mtime: new Date(
        this.dataView.getFloat64(Offset.DATA_BUFFER + StatLayout.MTIME, true),
      ),
    };
  }

  /**
   * Wait for the request word to become REQUEST.
   * Returns immediately if already REQUEST; CANCELLED or any unexpected
   * state returns false (the caller's running-flag check aborts the loop).
   */
  async waitUntilReady(timeout: number): Promise<boolean> {
    const startTime = Date.now();

    while (true) {
      const request = this.getRequest();
      if (request === RequestState.REQUEST) {
        return true;
      }
      // IDLE is the only waitable state.
      if (request !== RequestState.IDLE) {
        return false;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= timeout) {
        return false;
      }

      const remainingMs = timeout - elapsed;
      const result = _Atomics.waitAsync(
        this.int32View,
        Offset.REQUEST / 4,
        RequestState.IDLE,
        remainingMs,
      );

      if (result.async) {
        const waitResult = await result.value;
        if (waitResult === "timed-out") {
          return false;
        }
      }
      // Re-check request after wait
    }
  }

  /** Worker-side blocking wait on the RESULT word (host writes). */
  waitForResult(timeout?: number): "ok" | "timed-out" | "not-equal" {
    return _Atomics.wait(
      this.int32View,
      Offset.RESULT_STATE / 4,
      ResultState.NONE,
      timeout,
    );
  }

  notifyRequest(): number {
    return _Atomics.notify(this.int32View, Offset.REQUEST / 4);
  }

  notifyResult(): number {
    return _Atomics.notify(this.int32View, Offset.RESULT_STATE / 4);
  }

  reset(): void {
    this.setOpCode(OpCode.NOOP);
    this.setRequest(RequestState.IDLE);
    this.setResultState(ResultState.NONE);
    this.setPathLength(0);
    this.setDataLength(0);
    this.setResultLength(0);
    this.setErrorCode(ErrorCode.NONE);
    this.setFlags(Flags.NONE);
    this.setMode(0);
  }
}
