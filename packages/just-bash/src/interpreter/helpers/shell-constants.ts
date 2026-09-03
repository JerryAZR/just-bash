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
 * Shell builtins (for type, command -v, builtin, etc.)
 */
export const SHELL_BUILTINS: Set<string> = new Set([
  ":",
  "true",
  "false",
  "cd",
  "export",
  "unset",
  "exit",
  "local",
  "set",
  "break",
  "continue",
  "return",
  "eval",
  "shift",
  "getopts",
  "compgen",
  "complete",
  "compopt",
  "pushd",
  "popd",
  "dirs",
  "source",
  ".",
  "read",
  "mapfile",
  "readarray",
  "declare",
  "typeset",
  "readonly",
  "let",
  "command",
  "shopt",
  "exec",
  "test",
  "[",
  "echo",
  "printf",
  "pwd",
  "alias",
  "unalias",
  "type",
  "hash",
  "ulimit",
  "umask",
  "trap",
  "times",
  "wait",
  "kill",
  "jobs",
  "fg",
  "bg",
  "disown",
  "suspend",
  "fc",
  "history",
  "help",
  "enable",
  "builtin",
  "caller",
]);

/**
 * Names in the builtin display sets that have NO implementation: dispatch
 * has no handler for them, so at runtime they fall through to external
 * resolution and fail with "command not found" (exit 127). Real bash
 * implements these; just-bash does not (yet).
 *
 * Membership in POSIX_SPECIAL_BUILTINS / SHELL_BUILTINS is about DISPLAY
 * (type, command -v) and POSIX mode behavior — not about resolvability.
 * Static analysis (Bash.analyzeCommands) subtracts this set so its
 * results match dispatch. Keep this honest: the parity test in
 * command-analysis.test.ts runs every display-set name through both
 * runtime dispatch and analysis and fails on any divergence — both when
 * a name here gets implemented (remove it) and when a new unimplemented
 * name joins a display set (add it).
 */
export const UNIMPLEMENTED_BUILTIN_NAMES: ReadonlySet<string> = new Set([
  "bg",
  "caller",
  "disown",
  "enable",
  "fc",
  "fg",
  "jobs",
  "kill",
  "suspend",
  "times",
  "trap",
  "ulimit",
  "umask",
]);
