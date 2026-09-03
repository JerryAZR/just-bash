import {
  ExecutionAbortedError,
  ExecutionLimitError,
  UnresolvedCommandError,
} from "./interpreter/errors.js";
import { SecurityViolationError } from "./security/defense-in-depth-box.js";

/**
 * Fatal execution errors come in two tiers:
 *
 * 1. NEVER-CONTAINED (this module): errors that no catch block may turn
 *    into an ordinary command result, at any nesting level — execution
 *    limits, host aborts, security violations, and the
 *    abort-on-unresolved unwind. They must propagate to the top of the
 *    exec call.
 * 2. BOUNDARY-SPECIFIC (per-site lists): ExitError, ReturnError,
 *    ErrexitError, etc. — contained at specific boundaries (subshells,
 *    functions, pipelines) by design.
 *
 * Every broad catch block must route tier-1 errors through this module
 * FIRST (call rethrowFatalExecutionError, or test isFatalExecutionError
 * when the site needs to prepend output before rethrowing), then handle
 * its tier-2 errors. Adding a new tier-1 class here then protects every
 * compliant site at once; a site that hand-lists tier-1 classes is a bug
 * waiting to happen (and has been: see handleLoopError history).
 */
export function isFatalExecutionError(
  error: unknown,
): error is
  | ExecutionLimitError
  | ExecutionAbortedError
  | SecurityViolationError
  | UnresolvedCommandError {
  return (
    error instanceof ExecutionLimitError ||
    error instanceof ExecutionAbortedError ||
    error instanceof SecurityViolationError ||
    error instanceof UnresolvedCommandError
  );
}

/**
 * Rethrow errors that command-level recovery must never turn into ordinary
 * command failures. Call this first in broad catch blocks.
 */
export function rethrowFatalExecutionError(error: unknown): void {
  if (isFatalExecutionError(error)) {
    throw error;
  }
}
