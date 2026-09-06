/**
 * Filesystem error carrying its errno as a STRUCTURED field.
 *
 * The contract: the errno is chosen at the throw site and carried on
 * `.code`; consumers read `.code` and never re-derive it from message
 * prose. There is deliberately NO message-parsing fallback here —
 * parsing "CODE:" prefixes back out of strings is the legacy path this
 * module replaces, and keeping it would leave two sources of truth
 * (the field and the phrasing) with an illusion of robustness.
 *
 * Message format is preserved as a DISPLAY convention only: FsError
 * renders `${code}: ${message}` so existing user-facing text and
 * message-asserting tests are unchanged. The prefix is produced FROM
 * the code, never parsed back INTO one.
 *
 * Contract for IFileSystem implementations (documented on the
 * interface): throw FsError, or any node-style error with a string
 * `.code`. Errors without a structured code are coerced to EIO at
 * classification boundaries (toFsError) — an honest unknown, never a
 * fabricated specific errno.
 */
export class FsError extends Error {
  readonly code: string;
  /** The message WITHOUT the "CODE: " transport prefix — what
   * user-facing display paths should render. */
  readonly bareMessage: string;

  constructor(code: string, message: string) {
    super(message.startsWith(`${code}:`) ? message : `${code}: ${message}`);
    this.name = "FsError";
    this.code = code;
    this.bareMessage = message.startsWith(`${code}: `)
      ? message.slice(code.length + 2)
      : message;
  }
}

/** Extract a structured errno from any thrown value, or undefined when
 * the value carries none (bare Errors, strings, foreign objects). */
export function fsErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return undefined;
}

/** True when the error carries the given structured errno. */
export function isFsErrorCode(err: unknown, code: string): boolean {
  return fsErrorCode(err) === code;
}

/**
 * Classify any thrown value at a boundary: structured codes pass
 * through unchanged; everything else becomes the fallback (EIO by
 * default) with the original message preserved. This is the ONLY
 * classification heuristic in the system — consumers downstream of a
 * toFsError call always see a structured code.
 */
export function toFsError(err: unknown, fallbackCode = "EIO"): FsError {
  const code = fsErrorCode(err);
  const message =
    err instanceof Error ? err.message : String(err ?? "unknown error");
  if (code !== undefined) {
    // Strip a redundant "CODE: " prefix so the constructor does not
    // double it; FsError re-renders the canonical display form.
    const prefix = `${code}: `;
    return new FsError(
      code,
      message.startsWith(prefix) ? message.slice(prefix.length) : message,
    );
  }
  return new FsError(fallbackCode, message);
}
