/**
 * Exec-result assertion with full diagnostics on failure.
 *
 * A bare `expect(result.stdout).toBe(...)` hides the evidence when a
 * worker/WASM test flakes: the CI log shows `expected '' to be '...'`
 * and nothing else — no exitCode, no stderr — so the failure mechanism
 * is invisible (first seen hunting the js-exec empty-stdout flake,
 * run 34146184171). Every assertion through this helper carries the
 * complete result in its failure message.
 *
 * Pattern for worker-command tests (js-exec, python3, sqlite3):
 * assert through here instead of bare result.stdout/result.exitCode
 * assertions whenever the whole result matters.
 */

import { expect } from "vitest";

export interface ExecResultLike {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function expectExecResult(
  result: ExecResultLike,
  expected: { stdout?: string; stderr?: string; exitCode?: number },
): void {
  const diag =
    `\nexec diagnostics:\n  exitCode: ${result.exitCode}\n` +
    `  stderr: ${JSON.stringify(result.stderr)}\n` +
    `  stdout: ${JSON.stringify(result.stdout)}`;
  if (expected.exitCode !== undefined) {
    expect(result.exitCode, diag).toBe(expected.exitCode);
  }
  if (expected.stderr !== undefined) {
    expect(result.stderr, diag).toBe(expected.stderr);
  }
  if (expected.stdout !== undefined) {
    expect(result.stdout, diag).toBe(expected.stdout);
  }
}
