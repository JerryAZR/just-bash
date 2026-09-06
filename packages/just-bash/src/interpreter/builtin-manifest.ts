/**
 * The single source of truth for shell builtins: every name `type` and
 * `command -v` display as a builtin, classified as:
 *
 * - `handler`: executed by dispatchBuiltin (phase "early" handlers run
 *   before user-defined functions — special builtins functions cannot
 *   override; phase "late" handlers run after).
 * - `registry`: executed as a registry command (echo, printf, ...) —
 *   displayed as builtins for bash parity, resolved externally.
 * - `unimplemented`: displayed as builtins (bash implements them) but
 *   just-bash has no implementation; at runtime they fall through to
 *   external resolution and fail with exit 127. Static analysis
 *   (Bash.analyzeCommands) subtracts these structurally.
 *
 * This module is a LEAF: it imports nothing, so every consumer
 * (dispatch, compgen, type, analysis) can import it without cycles.
 * The handler functions live in builtin-dispatch.ts, keyed by a mapped
 * type derived from this manifest — a manifest `handler` entry without
 * a handler function (or vice versa) is a COMPILE ERROR, which makes
 * the old display-set/dispatch dual truth unrepresentable.
 */

export type BuiltinKind = "handler" | "registry" | "unimplemented";

export interface BuiltinManifestEntry {
  kind: BuiltinKind;
  /** Handler dispatch order; meaningless for other kinds. */
  phase?: "early" | "late";
}

type ManifestShape = Record<string, BuiltinManifestEntry>;

// The literal manifest type is load-bearing (ManifestHandlerName
// extracts handler names from it), so `manifest` uses `as const` rather
// than an annotation — any annotation would widen the per-entry literal
// kinds. The exported alias carries the explicit `typeof manifest`
// annotation that isolatedDeclarations requires.
const manifest = {
  // Early handlers: functions cannot override these.
  export: { kind: "handler", phase: "early" },
  unset: { kind: "handler", phase: "early" },
  exit: { kind: "handler", phase: "early" },
  local: { kind: "handler", phase: "early" },
  set: { kind: "handler", phase: "early" },
  break: { kind: "handler", phase: "early" },
  continue: { kind: "handler", phase: "early" },
  return: { kind: "handler", phase: "early" },
  shift: { kind: "handler", phase: "early" },
  getopts: { kind: "handler", phase: "early" },
  compgen: { kind: "handler", phase: "early" },
  complete: { kind: "handler", phase: "early" },
  compopt: { kind: "handler", phase: "early" },
  pushd: { kind: "handler", phase: "early" },
  popd: { kind: "handler", phase: "early" },
  dirs: { kind: "handler", phase: "early" },
  source: { kind: "handler", phase: "early" },
  ".": { kind: "handler", phase: "early" },
  read: { kind: "handler", phase: "early" },
  mapfile: { kind: "handler", phase: "early" },
  readarray: { kind: "handler", phase: "early" },
  declare: { kind: "handler", phase: "early" },
  typeset: { kind: "handler", phase: "early" },
  readonly: { kind: "handler", phase: "early" },

  // Late handlers: functions may override these. `eval` is the special
  // case bash makes special: in POSIX mode it dispatches early (see
  // dispatchBuiltin).
  eval: { kind: "handler", phase: "late" },
  cd: { kind: "handler", phase: "late" },
  ":": { kind: "handler", phase: "late" },
  true: { kind: "handler", phase: "late" },
  false: { kind: "handler", phase: "late" },
  let: { kind: "handler", phase: "late" },
  command: { kind: "handler", phase: "late" },
  builtin: { kind: "handler", phase: "late" },
  shopt: { kind: "handler", phase: "late" },
  exec: { kind: "handler", phase: "late" },
  wait: { kind: "handler", phase: "late" },
  type: { kind: "handler", phase: "late" },
  hash: { kind: "handler", phase: "late" },
  help: { kind: "handler", phase: "late" },
  "[": { kind: "handler", phase: "late" },
  test: { kind: "handler", phase: "late" },

  // Displayed as builtins; executed as registry commands.
  echo: { kind: "registry" },
  printf: { kind: "registry" },
  pwd: { kind: "registry" },
  alias: { kind: "registry" },
  unalias: { kind: "registry" },
  history: { kind: "registry" },

  // Displayed as builtins; no implementation.
  bg: { kind: "unimplemented" },
  caller: { kind: "unimplemented" },
  disown: { kind: "unimplemented" },
  enable: { kind: "unimplemented" },
  fc: { kind: "unimplemented" },
  fg: { kind: "unimplemented" },
  jobs: { kind: "unimplemented" },
  kill: { kind: "unimplemented" },
  suspend: { kind: "unimplemented" },
  times: { kind: "unimplemented" },
  trap: { kind: "unimplemented" },
  ulimit: { kind: "unimplemented" },
  umask: { kind: "unimplemented" },
} as const;

const _manifestShapeCheck: ManifestShape = manifest;

export const BUILTIN_MANIFEST: typeof manifest = manifest;

/** Names displayed as shell builtins (type, command -v, coverage). */
export const SHELL_BUILTINS: Set<string> = new Set(
  Object.keys(BUILTIN_MANIFEST),
);

/** Manifest keys whose kind is "handler", as a type (for the dispatch
 * handler map's bidirectional coverage check). */
export type ManifestHandlerName = {
  [K in keyof typeof BUILTIN_MANIFEST]: (typeof BUILTIN_MANIFEST)[K] extends {
    kind: "handler";
  }
    ? K
    : never;
}[keyof typeof BUILTIN_MANIFEST];

/** Names with no implementation (analysis subtracts these). */
export const UNIMPLEMENTED_BUILTIN_NAMES: ReadonlySet<string> = new Set(
  Object.entries(BUILTIN_MANIFEST)
    .filter(([, entry]) => entry.kind === "unimplemented")
    .map(([name]) => name),
);

/** Widened view for string-keyed lookups (the literal manifest type is
 * precise for the mapped-type coverage check). */
const manifestView: Record<string, BuiltinManifestEntry> = BUILTIN_MANIFEST;

/** Dispatch order for a handler name (undefined for non-handlers). */
export function builtinPhase(name: string): "early" | "late" | undefined {
  const entry = Object.hasOwn(manifestView, name)
    ? manifestView[name]
    : undefined;
  return entry?.kind === "handler" ? entry.phase : undefined;
}
