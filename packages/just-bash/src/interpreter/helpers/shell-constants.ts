/**
 * Shell Constants
 *
 * Constants for shell builtins, keywords, and POSIX special builtins.
 */

/**
 * POSIX special built-in commands.
 * In POSIX mode, these have special behaviors:
 * - Prefix assignments persist after the command
 * - Cannot be redefined as functions
 * - Errors may be fatal
 */
export const POSIX_SPECIAL_BUILTINS: Set<string> = new Set([
  ":",
  ".",
  "break",
  "continue",
  "eval",
  "exec",
  "exit",
  "export",
  "readonly",
  "return",
  "set",
  "shift",
  "trap",
  "unset",
]);

/**
 * Check if a command name is a POSIX special built-in
 */
export function isPosixSpecialBuiltin(name: string): boolean {
  return POSIX_SPECIAL_BUILTINS.has(name);
}

/**
 * Shell keywords (for type, command -v, etc.)
 */
export const SHELL_KEYWORDS: Set<string> = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "case",
  "esac",
  "for",
  "select",
  "while",
  "until",
  "do",
  "done",
  "in",
  "function",
  "{",
  "}",
  "time",
  "[[",
  "]]",
  "!",
]);

/**
 * Shell builtins (for type, command -v, builtin, etc.) and the set of
 * names with no implementation. Both are DERIVED from BUILTIN_MANIFEST
 * (the single source of truth) — see builtin-manifest.ts. Membership is
 * about DISPLAY (type, command -v) and POSIX mode behavior, not
 * resolvability: the unimplemented subset falls through to external
 * resolution at runtime and fails with exit 127.
 */
export {
  SHELL_BUILTINS,
  UNIMPLEMENTED_BUILTIN_NAMES,
} from "../builtin-manifest.js";
