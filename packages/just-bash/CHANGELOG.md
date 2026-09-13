# just-bash

## 3.9.0

### Minor Changes

- [`00e40f9`](https://github.com/JerryAZR/just-bash/commit/00e40f927dfa0c6b77cadf063be094282ced2a5a) Thanks [@JerryAZR](https://github.com/JerryAZR)! - Add `diff -r` (recursive directory comparison), `diff -rq` (brief recursive), and `diff -N` (treat absent files as empty). No new dependencies.

- [`00e40f9`](https://github.com/JerryAZR/just-bash/commit/00e40f927dfa0c6b77cadf063be094282ced2a5a) Thanks [@JerryAZR](https://github.com/JerryAZR)! - Expose `maxJsMemoryBytes` in `ExecutionLimits` — the QuickJS heap limit (default 64MB) is now configurable per Bash instance. This is the only real cap on js-exec read/write sizes.

- [`00e40f9`](https://github.com/JerryAZR/just-bash/commit/00e40f927dfa0c6b77cadf063be094282ced2a5a) Thanks [@JerryAZR](https://github.com/JerryAZR)! - Add `readOnly` option to `VfsTemplateOptions` — when true, all fork overlay mounts are read-only (EROFS on writes).

### Patch Changes

- [`00e40f9`](https://github.com/JerryAZR/just-bash/commit/00e40f927dfa0c6b77cadf063be094282ced2a5a) Thanks [@JerryAZR](https://github.com/JerryAZR)! - Fix a class of CI failures where js-exec guest output was lost: loop `executePendingJobs()` until all QuickJS jobs drain, not just the first batch.

## 3.8.0

### Minor Changes

- [`30e7df8`](https://github.com/JerryAZR/just-bash/commit/30e7df8689f93409d50702df49f9dc5da1484d1c) Thanks [@trieloff](https://github.com/trieloff)! - `diff` now defaults to POSIX normal format (`2c2` / `<` / `---` / `>`) instead of unified, matching GNU diffutils and POSIX. **This changes the default output and will break anything parsing the previous unified-by-default output** — pass `-u` to keep unified.

  Previously `-u` was parsed and discarded, `createTwoFilesPatch` was the only output path, and every invocation was prefixed with jsdiff's 67-character `===...===` banner, which is not valid output in any GNU format. Normal format was unreachable by any flag, so `diff a b | grep '^<'` — the canonical "lines only in A" idiom — silently matched nothing and exited cleanly on files that differ.

  - `-u` / `--unified` now selects unified format, and `--normal` selects the default explicitly.
  - New `-c` / `--context` for context format (`*** ` / `--- ` / `***************` / `! `).
  - New `--version`.
  - The `===` banner is gone from every format. The `-u` / `-c` file headers carry no timestamp, so output is reproducible; GNU puts each file's mtime there.
  - Filenames in `-u` / `-c` headers are quoted and escaped as GNU does, so a filename containing a newline can no longer forge header or `@@` lines in the emitted patch.
  - Two output styles at once (for example `diff -u -c`) is now an error, as in GNU: `diff: conflicting output style options`, exit 2.
  - `\ No newline at end of file` is reported in all three formats.

  `-q`, `-s`, `-i`, `-` for stdin, and the exit codes are unchanged.

  Hunk selection is unchanged: where several equally minimal edit scripts exist, just-bash may group ambiguous changes differently than GNU. The output is always a correct, equally minimal patch, but the `NcN` line numbers can differ on such inputs.

### Patch Changes

- [`fa769ce`](https://github.com/JerryAZR/just-bash/commit/fa769ce277a6f1e137e5751082d7a84ab5e0badc) Thanks [@trieloff](https://github.com/trieloff)! - interpreter: give a bare assignment exit status 0 instead of the previous command's

  A command with no command word — `x=1`, `arr=(a b)`, `> file`, a `$empty` that expands to nothing — reported whatever `$?` already held rather than success. Bash gives such a command status 0 unless a command substitution ran while expanding it.

  The leak is invisible until something reads `$?`, and an `else` branch is where it bites: the branch runs with `$?` set to 1 by the condition that just failed, so an `else` branch ending in an assignment made the whole `if` report failure. Under `set -e` that ended the script with no output and no diagnostic:

  ```bash
  set -e
  if false; then :; else x=1; fi
  echo done                          # never ran
  ```

  A command substitution still sets the status where bash says it does. It counts from an assigned value or a redirection word, assignments expanded first and the last substitution winning: `x=$(exit 7)` is 7, `> /dev/null$(exit 5)` is 5, and `x=$(exit 7) > /dev/null$(exit 5)` is 5. A redirection onto fd 0 discards it and reports 0, matching bash 5.x, which forks a child to perform such a command's redirections. Process substitution never contributes, and neither does a command substitution in `PS4` under `set -x`.

- [`e6ae113`](https://github.com/JerryAZR/just-bash/commit/e6ae113b4dccbf7877028257511b19a52b0ddc78) Thanks [@mutewinter](https://github.com/mutewinter)! - Report gzip files from their header instead of inflating them. `file` no longer enters `file-type`'s nested gzip probe, which decompressed up to 16 MB of input to look for an inner tar and leaked an `AbortError` unhandled rejection after the command had already returned. Gzipped tar archives now read as `gzip compressed data` rather than `gzip archive data`, matching `file`.

- [`689d409`](https://github.com/JerryAZR/just-bash/commit/689d409f3de2cee192cac6afbe13df89328f6eb4) Thanks [@taoche](https://github.com/taoche)! - Run lazy file providers in the defense-in-depth trusted scope during materialization. Host-supplied providers doing real async I/O (`setTimeout`, `fetch`, `process.env`) previously tripped the blocked-globals traps when a script first read the file mid-exec, surfacing as a `SecurityViolationError` (formerly a silent empty read / ENOENT). Fixes [#253](https://github.com/JerryAZR/just-bash/issues/253).

- [`68f6984`](https://github.com/JerryAZR/just-bash/commit/68f69840ef018f7a0df0964b086b8d2403ad8abe) Thanks [@trieloff](https://github.com/trieloff)! - Bound `ls` directory entry collections before per-entry work. A filesystem backend returning a very large directory could previously drive `ls` into sorting, statting, classifying and formatting every entry before any limit applied, and piping to `head` did not help because pipeline producers are materialized before consumers run. Oversized listings now fail with exit code 126 (`array element limit exceeded` / `filesystem traversal entry limit exceeded`), the recursive descent no longer fans out across sibling directories, and every operand of a multi-directory listing is charged to the same budget.

- [`04dad0d`](https://github.com/JerryAZR/just-bash/commit/04dad0dcbdb90622587eb1273080286a2a4cd4b7) Thanks [@taoche](https://github.com/taoche)! - regex: cache compiled RE2 patterns across `UserRegex` constructions

  Every `createUserRegex()` call recompiled its pattern from source
  (`translateRegExp` → parse → simplify → compile). Commands that build a
  `UserRegex` inside a per-row loop therefore recompiled the same pattern once per
  row: jq's `test`/`match`/`capture`/`scan`/`splits`/`sub`/`gsub`, awk's `~`/`!~`
  and `sub`/`gsub`/`match`/`split`, and sed's `s///` (which compiled the same
  pattern twice per line for the `g` and Nth-occurrence paths). Compiling costs
  ~23µs against ~1.5µs to match with an already-compiled pattern, so compilation
  dominated these workloads.

  Compiled patterns are now memoized in a 256-entry cache keyed on the pattern and
  the RE2 flags, mirroring the existing glob regex cache in `src/utils/glob.ts`.
  Patterns longer than 1024 characters are compiled but not retained, bounding the
  cache's retained pattern source at 256 KiB. Only the compiled pattern is shared — `lastIndex`, the reusable matcher, result
  limits and the abort signal stay per-instance, so matching semantics are
  unchanged. Over 100k rows: jq `test()` 8.96s → 4.26s, awk `~` 4.15s → 2.55s,
  awk `gsub` 7.16s → 6.10s, sed `s///g` 10.46s → 8.29s. Commands that already
  hoisted compilation out of their loop (grep, rg) are unaffected.

- [`3820a66`](https://github.com/JerryAZR/just-bash/commit/3820a660b692c9e9638d8c88cb713b43691cdc02) Thanks [@JerryAZR](https://github.com/JerryAZR)! - Replace the custom js-exec QuickJS worker with run, using synchronous host bindings and native module loading while preserving filesystem, tools, process, fetch, output-limit, and cancellation behavior. Keep queue admission inside the JavaScript deadline, restore argv-only `spawnSync` execution, top-level-await module detection, optional tool exposure, and the historical 8 MiB per-call bridge ceiling. Make the aggregate bridge request ceiling configurable, bound filesystem and module reads before allocation, preserve module-loader and bootstrap diagnostics, and enforce source, generated guest configuration, and combined-output byte limits without allowing `process.exit()` to clear limit failures. Preserve binary `Buffer` filesystem writes and the `ArrayBuffer` filesystem contract, project command results before they cross into the guest, gate bootstrap-only host behavior to the bootstrap phase, parse guest stacks with bounded linear work, redact runtime stack paths, and forward cancellation through the companion executor into inline tool contexts and SDK Effect execution.

## 3.7.0

### Minor Changes

- [`ff8837a`](https://github.com/JerryAZR/just-bash/commit/ff8837ab0ed617c14ec70a2d7d383384e9c0ff5b) Thanks [@JerryAZR](https://github.com/JerryAZR)! - **VFS template fork model** (`createVfsTemplate`): fork a prepared filesystem into cheap copy-on-write instances for parallel agents, then merge their change sets and apply the result back to the host. **Merge is a replay**: entries from all sources (fork instances or plain diffs — the latter cross process boundaries) are ordered by untamperable `changedAt` stamps (ties by input order) and applied to a fresh fork with the stock filesystem operations over the template's real lower, so metacopy, resurrection, and deletion semantics are definitionally identical to the forks' own. Conflicting (racy) entries are refused exactly as a real filesystem would refuse them — deterministic, never throwing, contained to the conflicted path; no invented conflict-resolution rules. `merge()` returns the merged fork — diff it and discard it, or keep working on it. `diff({ space: "vfs" | "host" })` selects virtual vs host-absolute paths; `template.apply()` validates containment and writes through. `applyDiffToRealFs` remains the standalone host-apply primitive. See `docs/design/vfs-template-fork-model.md` and `docs/recipes/parallel-fan-out.md`.

  **Bridge: generic oversized-result assembly**: results of ANY size now cross the worker bridge transparently (host publishes a prefix + retains the buffer; the worker assembles with range reads) — one mechanism for file reads, HTTP responses, tool results, exec output, and readdir, replacing the per-channel 8MB ceiling.

  **Structural hardening** (architecture-level flaw classes closed):

  - **Builtin manifest**: the three disconnected builtin truths (dispatch chain, display set, unimplemented list) are now one leaf manifest; the dispatch table is typed against it, so a listed-but-undispatchable builtin is a compile error, unrepresentable in code.
  - **Two-word bridge protocol**: request and result channels are separate SAB words, so a result wait can only be woken by a real result publish — the torn-read flake class is unrepresentable (the re-wait tolerance loop is gone; impossible states fail loudly as protocol violations).
  - **Typed fs error codes**: `FsError` carries errnos structurally on `.code`; all ~140 fs throw sites converted, and the five ad-hoc prose-parsing errno heuristics (bridge, python worker, rm/cp/mv/mkdir/ln) are deleted. Unclassifiable errors coerce to honest EIO instead of a fabricated specific errno. A new banned-pattern lint rule makes the legacy `"ECODE: ..."` plain-Error channel unrepresentable in non-test source. `FsError`, `fsErrorCode`, `isFsErrorCode`, `toFsError` are exported; `IFileSystem` documents the error contract.
  - **`mergeDiffs` is O(n log n)**: sort+sweep replaces all-pairs prefix scans (8×5000-entry merge in ~47ms).

## 3.6.1

### Patch Changes

- [`f49b787`](https://github.com/JerryAZR/just-bash/commit/f49b7878d9f1b613afac0d58f6f67f4c6e180f85) Thanks [@JerryAZR](https://github.com/JerryAZR)! - Fixes since 3.6.0:

  - **Windows real-dir modes**: real directories no longer report `0o40666` (no execute bits), which made every real-backed directory untraversable for the python worker (`chdir`/`listdir`/`open` EACCES below the overlay root). Modes are normalized to `0o755` on win32.
  - **Abort/timeout preserves stdout**: output accumulated before an abort or execution deadline is no longer silently discarded — the exact partial output a harness needs on timeout.
  - **js-exec worker leak**: the idle-teardown timer was suppressed by defense-in-depth context deactivation, leaking the worker (and its handles) so any process that ran js-exec could never exit naturally.
  - **Torn bridge read on cancel**: a request-level cancel landing mid-op could surface as a garbage `Error code: 0` guest error instead of a clean timeout exit 124 (the intermittent js-exec CI flake class).
  - **8MB file ceiling removed**: files larger than the 8MB bridge buffer are readable and writable in both worker runtimes (python3 and js-exec) via ranged transport.
  - **Errno honesty**: python no longer reports `FileNotFoundError` for existing files when the backend errors (blanket ENOENT replaced by real mapping, numeric bridge error codes preferred over substring matching, `ENOTEMPTY` added end-to-end).
  - **Binary write corruption**: js-exec `writeFile`/`appendFile` no longer writes `Uint8Array` data as comma-joined text; write data accepts exactly string/Buffer/TypedArray/DataView and throws TypeError otherwise.
  - **Constructor guard**: `Bash({ fs, files })` now throws (files were silently ignored with a custom fs).
  - **Concurrency**: `appendFile` and `sync()` no longer lose concurrent writes (copy-up and detach compare-and-swap).
  - **rm -f**: ENOENT suppression anchored to the error-code prefix — a file named `ENOENT-notes` can't smuggle a real failure past `-f`.
  - Plus review hardening: directory mode/mtime restored at apply, non-normalized change-set paths rejected loudly, `RESULT_LENGTH` overflow guard.

## 3.6.0

### Minor Changes

- [`942abb1`](https://github.com/JerryAZR/just-bash/commit/942abb1a41b836757d98a7a47c9c85633b0455ad) Thanks [@JerryAZR](https://github.com/JerryAZR)! - `rm -f` now suppresses only ENOENT errors, matching GNU rm: mount-point (EBUSY) and other failures are reported and exit 1 instead of being silently swallowed. Previously `rm -rf` on a mount point or its parent was a silent no-op with exit 0, while the change set correctly showed nothing had been deleted.

  `AgentSandbox` gains path conversion helpers: `resolveRealPath(realPath)` maps a real host path to `{ mountPoint, overlay, path }` for direct shadow inspection on the overlay, and `toRealPath(vfsPath)` maps a VFS path to its real host path. Both return null for paths outside the mounted overlays.

## 3.4.2

### Patch Changes

- [#381](https://github.com/vercel-labs/just-bash/pull/381) [`d40a42d`](https://github.com/vercel-labs/just-bash/commit/d40a42d514b22da4ed023635d747c8b3f029a6c5) Thanks [@cramforce](https://github.com/cramforce)! - Include the security and transform declaration trees referenced by the package entrypoints and worker declarations in published packages.

## 3.4.1

### Patch Changes

- [#373](https://github.com/vercel-labs/just-bash/pull/373) [`2c1831c`](https://github.com/vercel-labs/just-bash/commit/2c1831cc832d4b09ee4e1823526afb6ccca77942) Thanks [@cramforce](https://github.com/cramforce)! - Prevent defense-in-depth violation reporting from recursively overflowing the call stack in host runtimes that wrap `Date.now()`, honor configured main-thread violation exclusions, include actionable exclusion guidance for configurable violations, and keep constructor-execution protections non-excludable.

## 3.4.0

### Minor Changes

- [#303](https://github.com/vercel-labs/just-bash/pull/303) [`c5a2a4a`](https://github.com/vercel-labs/just-bash/commit/c5a2a4a35c7490276befa716acae3fe880c1fe89) Thanks [@boramuyar](https://github.com/boramuyar)! - Provide the shadowed bundled command to custom command overrides through `CommandContext.origCommand`.

## 3.3.0

### Minor Changes

- [#291](https://github.com/vercel-labs/just-bash/pull/291) [`47f604a`](https://github.com/vercel-labs/just-bash/commit/47f604a7f1e12730318e4c88c7872a5a35383056) Thanks [@trieloff](https://github.com/trieloff)! - jq: add external-argument flags (`--arg`, `--argjson`, `--rawfile`, `--slurpfile`, `--args`, `--jsonargs`) and the `$ARGS` object (`$ARGS.named` / `$ARGS.positional`), matching real jq 1.7.1 behavior including exit codes, error messages, and prototype-sensitive key handling.

- [#336](https://github.com/vercel-labs/just-bash/pull/336) [`d97425d`](https://github.com/vercel-labs/just-bash/commit/d97425dff8f51cfd773d22bc009561a09235cd1b) Thanks [@trieloff](https://github.com/trieloff)! - Support user file descriptors (fd >= 3). `exec 3< file`, `N< file` / `N> file` / `N>> file` on any command, `read -u N`, `read <&N`, `>&N`, `N<&M`, and `N<&-` now go through a real descriptor table: a descriptor carries one shared read position, `exec` keeps it open until it is closed, and every other construct — including `done N< file` on a loop — gets it only for the duration of that command.

- [#331](https://github.com/vercel-labs/just-bash/pull/331) [`6680247`](https://github.com/vercel-labs/just-bash/commit/66802470837cfac3a58a09e00d37b2070387ba7b) Thanks [@trieloff](https://github.com/trieloff)! - Treat a `-` FILE operand in `grep` as standard input, matching GNU. `grep PATTERN -` now reads stdin instead of failing with "No such file or directory", stdin is labelled `(standard input)` in the multi-file prefix and in `-l`/`-L`/`-c` output, repeated `-` operands see the stream drained by the first one, and `-` is exempt from `-r` recursion and `--include`/`--exclude` filtering.

- [#325](https://github.com/vercel-labs/just-bash/pull/325) [`edc7f2f`](https://github.com/vercel-labs/just-bash/commit/edc7f2fac5337cebd19911c5756b76ed02e52090) Thanks [@trieloff](https://github.com/trieloff)! - Support process substitution `<(cmd)` and `>(cmd)`.

  `<(cmd)` runs `cmd` and substitutes a readable `/dev/fd/N` path backed by an
  in-memory file; `>(cmd)` substitutes a writable path whose contents are fed to
  `cmd` once the outer command finishes. Descriptors are numbered from 63
  downwards like bash and released when the command that opened them completes.
  Process substitutions retain their surrounding word context in assignments,
  conditionals, regular expressions, and heredoc delimiters. Previously any use
  raised `Parse error: Expected redirection target`.

- [#327](https://github.com/vercel-labs/just-bash/pull/327) [`eaedb5b`](https://github.com/vercel-labs/just-bash/commit/eaedb5bc34cffd2077b88bb1ccc48ea7e0545a48) Thanks [@trieloff](https://github.com/trieloff)! - Add `grep -f FILE` / `--file=FILE` to read patterns from a file (one per line). Patterns from `-f` OR-combine with `-e` patterns and with each other, `-f -` reads patterns from stdin, empty pattern lines match every line, and an empty pattern file selects nothing (exit 1). Newline-separated `PATTERNS` operands are now split into individual patterns, and `-x` groups alternatives correctly (`^(?:a|b)$`).

### Patch Changes

- [#358](https://github.com/vercel-labs/just-bash/pull/358) [`bd1df37`](https://github.com/vercel-labs/just-bash/commit/bd1df37f8ff836355f470e95dcaa004b769d1e61) Thanks [@privatenumber](https://github.com/privatenumber)! - Parse and serialize bare file descriptor variable redirections such as `{output}>output.log` and `{input}<<EOF`. Bare redirects create their target with a command-scoped descriptor, while named command forms keep the allocated descriptor available.

- [#347](https://github.com/vercel-labs/just-bash/pull/347) [`abb904b`](https://github.com/vercel-labs/just-bash/commit/abb904b1e126d14aa437b05f006df83117f06db3) Thanks [@privatenumber](https://github.com/privatenumber)! - Fix escaped reserved words being parsed as shell syntax. Unquoted escapes now retain their provenance through lexing and word parsing, including when the word is serialized back to Bash.

- [#332](https://github.com/vercel-labs/just-bash/pull/332) [`4f9bdec`](https://github.com/vercel-labs/just-bash/commit/4f9bdec02edb9eb72511546b759cb7e20bc2e27e) Thanks [@trieloff](https://github.com/trieloff)! - Fix `grep -L` exit status to match GNU grep. The status reports whether a line
  was selected, not whether a filename was printed, so `grep -L` now exits 0 when
  every file matched (printing nothing) and 1 when no file matched (printing every
  name) — previously these were inverted.

- [#339](https://github.com/vercel-labs/just-bash/pull/339) [`31d247f`](https://github.com/vercel-labs/just-bash/commit/31d247fe3a62f081b4462064da195552ab0a421c) Thanks [@mutewinter](https://github.com/mutewinter)! - network: restore private-range-enforced requests from the bundled build

  Every request made with `denyPrivateRanges` enabled failed with `Network access denied: DNS pinning unavailable for private IP enforcement`, so `curl` could not reach any host at all. The published ESM bundle was affected; source consumers and the CommonJS bundle were not.

  The pinned connection owner reads `Agent` and `fetch` off a dynamic `import("undici")`. Node's resolution of the package exposes those as named exports, but the ESM build inlines undici's CommonJS module into a chunk whose namespace carries it under `default` alone, so `Agent` was `undefined` and the `TypeError` from constructing it was reported as a runtime incapable of pinning.

  The namespace is now normalized before the transport is read off it, which also covers a consumer that bundles just-bash further.

- [#336](https://github.com/vercel-labs/just-bash/pull/336) [`d97425d`](https://github.com/vercel-labs/just-bash/commit/d97425dff8f51cfd773d22bc009561a09235cd1b) Thanks [@trieloff](https://github.com/trieloff)! - Stop command groups, function bodies and `eval` from rewinding stdin they never replaced, so `{ { read a; }; read b; }` gives `b` the second line instead of replaying the first.

- [#348](https://github.com/vercel-labs/just-bash/pull/348) [`1a7940d`](https://github.com/vercel-labs/just-bash/commit/1a7940ddf91dec8f69125474a40cef1adebabee9) Thanks [@privatenumber](https://github.com/privatenumber)! - Reject unsupported command-leading reserved words in every parser context instead of discarding them or executing them as simple commands. Unknown command AST nodes now fail explicitly instead of returning a successful result.

- [#345](https://github.com/vercel-labs/just-bash/pull/345) [`2208a34`](https://github.com/vercel-labs/just-bash/commit/2208a34e27d33a2fce712fbd024875ec60747553) Thanks [@privatenumber](https://github.com/privatenumber)! - Restore command groups and subshells after the process-substitution and stdin-ownership changes were combined without forwarding ownership through inner command dispatch.

- [#336](https://github.com/vercel-labs/just-bash/pull/336) [`d97425d`](https://github.com/vercel-labs/just-bash/commit/d97425dff8f51cfd773d22bc009561a09235cd1b) Thanks [@trieloff](https://github.com/trieloff)! - Apply output redirections attached to `while` and `until` loops. `while true; do echo x; break; done >/dev/null` no longer leaks its output to the caller, and `> file`, `>>`, `2>`, `2>&1`, `&>` and `>|` now behave on loops the way they already did on `for` and `case`. `until` loops also gained the input-redirection handling `while` loops already had, so `until ! read l; do ...; done < file` reads from the file. A loop now only restores stdin it owns, so reading inside a loop no longer rewinds an enclosing group's read position: `printf 'a\nb\n' | { while read x; do break; done; read y; }` sees `y=b`.

- [#328](https://github.com/vercel-labs/just-bash/pull/328) [`65dafd5`](https://github.com/vercel-labs/just-bash/commit/65dafd55afbfa7e62642ce485787f7d65fad4961) Thanks [@trieloff](https://github.com/trieloff)! - Stop pipelines from draining the enclosing shell's stdin, so `while read …; do … | …; done < file` runs once per line again.

- [#349](https://github.com/vercel-labs/just-bash/pull/349) [`be55fec`](https://github.com/vercel-labs/just-bash/commit/be55fec4e23b3f5a42cf8eaeb6939b379f741ae1) Thanks [@privatenumber](https://github.com/privatenumber)! - Process redirections through policy-driven transactions that preserve Bash ordering, descriptor lifetimes, persistent `exec` routes, compound-command stdin, control-flow output routing, and shared read-write descriptor positions without duplicate expansion or opening.

- [#368](https://github.com/vercel-labs/just-bash/pull/368) [`3ee215c`](https://github.com/vercel-labs/just-bash/commit/3ee215c2ad56c96ce0d88e2813050df9f15afa38) Thanks [@cramforce](https://github.com/cramforce)! - FS sym-link hardening

- [#338](https://github.com/vercel-labs/just-bash/pull/338) [`19a02c2`](https://github.com/vercel-labs/just-bash/commit/19a02c297d110fde8a8a3376d6956c2c549d128e) Thanks [@mutewinter](https://github.com/mutewinter)! - sqlite3: report failed statements on stderr and exit non-zero without `-bail`

  A statement that failed was written to **stdout** as `Error: ...` and the command still exited `0` unless `-bail` was passed. Real `sqlite3` writes the error to stderr and exits `1` in either mode; `-bail` only decides whether the remaining statements still run.

  Two consequences for callers: `sqlite3 db "SELECT ..." > out.csv` silently wrote the error text into the data file, and `sqlite3 db "..." && next-step` ran `next-step` after the query had failed, so a shell script could not detect a bad query without opting into `-bail` and losing the ability to see later statements.

  Errors now accumulate on stderr in statement order and the exit status is `1` whenever any statement failed. Successful runs are unchanged, `-bail` still stops at the first failure, and the partial stdout produced before a failure is still emitted. Writeback of a partially-successful script is also unchanged.

- [#360](https://github.com/vercel-labs/just-bash/pull/360) [`1fbde34`](https://github.com/vercel-labs/just-bash/commit/1fbde341d74ff7f933d9cead9a390a6ab65b5df3) Thanks [@privatenumber](https://github.com/privatenumber)! - Preserve whether a here-document ended at its delimiter or at end-of-input. Unterminated final body lines now receive Bash's trailing newline, backslash-newline continuations are removed during expansion, and serialization rejects unterminated documents rather than manufacturing a closing delimiter.

## 3.2.0

### Minor Changes

- [#304](https://github.com/vercel-labs/just-bash/pull/304) [`3d39a71`](https://github.com/vercel-labs/just-bash/commit/3d39a714b3751cedc173dffae27933dfe7b8b3b5) Thanks [@subsetpark](https://github.com/subsetpark)! - Add curl `-G`/`--get` query-string data handling and preserve command-line order when repeated `-d`, `--data-raw`, `--data-binary`, and `--data-urlencode` options are mixed, including `@file` forms. Data requests now also set curl's standard `application/x-www-form-urlencoded` content type unless the caller supplies one.

- [#307](https://github.com/vercel-labs/just-bash/pull/307) [`7c4caed`](https://github.com/vercel-labs/just-bash/commit/7c4caedf02599628f19b243f960d480760f5e476) Thanks [@cramforce](https://github.com/cramforce)! - Harden untrusted execution with shared aggregate budgets, liberal normal and
  opt-in hardened limit profiles, request-bound network validation, bounded
  archive and worker processing, transactional filesystem and shell state, and
  expanded adversarial regression checks.

  Established command declarations and host-extension defaults remain source
  compatible. Dispatched callbacks receive a `ResolvedCommandContext` with
  required limits; applications can use `createCommandContext({ fs })` for direct
  invocation, opt into restricted custom-command execution with `trusted: false`,
  and select tighter resource policy with the `hardened` profile. All
  host-registration paths keep their established trusted default. The supported
  Node.js floor is now declared as `>=20.18.1`.

### Patch Changes

- [#315](https://github.com/vercel-labs/just-bash/pull/315) [`6df692f`](https://github.com/vercel-labs/just-bash/commit/6df692f236ca108c888552a67557998156ac845b) Thanks [@matchai](https://github.com/matchai)! - Treat `--` as the end of options in `grep`.

## 3.1.0

### Minor Changes

- [#284](https://github.com/vercel-labs/just-bash/pull/284) [`af2e0f4`](https://github.com/vercel-labs/just-bash/commit/af2e0f4cdeb5417ea59e25140038c239dd8fd92d) Thanks [@arimxyer](https://github.com/arimxyer)! - sandbox: forward capability flags from `SandboxOptions` into the underlying `Bash`

  `Sandbox.create(opts)` previously constructed its internal `Bash` with only a subset
  of `BashOptions`, silently dropping the optional capability flags (`python`,
  `javascript`, `commands`, `customCommands`, `fetch`). A host that drives just-bash
  through the `Sandbox` API (rather than `new Bash(...)`) therefore could not enable
  python3, js-exec, a restricted command set, custom commands, or a custom fetch — even
  though the runtimes ship in the package.

  `SandboxOptions` now exposes those fields and `Sandbox.create` forwards them into the
  `Bash` it builds. Behavior is unchanged when a caller omits them (each falls back to
  its existing `BashOptions` default — Python/js-exec stay off, the full command set
  stays available). Fixes the root cause behind vercel/eve#431.

### Patch Changes

- [#268](https://github.com/vercel-labs/just-bash/pull/268) [`7a5a0b9`](https://github.com/vercel-labs/just-bash/commit/7a5a0b9ae3bf0524722653cbf4b45e6bc176cf22) Thanks [@trieloff](https://github.com/trieloff)! - jq: allow nested double-quoted strings inside `"\(...)"` string interpolation

  jq string interpolation of the form `"\(...)"` that contained a nested double-quoted string — for example `"\(sub("T.*";""))"` or `"\(ltrimstr("ab"))"` — previously failed with a parse error. The tokenizer terminated the outer string at the first `"` it saw inside the interpolation expression, so the rest of the expression became orphaned tokens.

  The lexer now tracks `\(...)` depth while consuming a string literal and treats nested `"..."` pairs as opaque content while inside an interpolation, restoring them verbatim into the captured interpolation source. `parseStringInterpolation` similarly skips over nested strings when balancing parentheses, so the interpolation expression is captured as a whole and handed to the expression parser intact.

## 3.0.3

### Patch Changes

- [#277](https://github.com/vercel-labs/just-bash/pull/277) [`aec5643`](https://github.com/vercel-labs/just-bash/commit/aec56431d7d9b6fcb141bbfe25d26f4931f54f80) Thanks [@mutewinter](https://github.com/mutewinter)! - interpreter: avoid lazy import in variable assignment path that trips defense-in-depth (fixes [#273](https://github.com/vercel-labs/just-bash/issues/273))

  Any non-`export` variable assignment (bare `SECRET=s`, prefixed `SECRET=s cmd`,
  or before a custom command) failed with a defense-in-depth security violation
  (`dynamic import of Node.js builtin 'node:module' is blocked during script
execution`), while plain commands and `export`-ed assignments passed.

  `processScalarAssignment()` resolved `isArray` via `await import("./expansion.js")`
  in two spots. In the bundled `dist`, that dynamic `import()` marks `expansion.js`
  as a lazily-linked chunk whose `createRequire` banner imports `node:module`; the
  defense layer's ESM `resolve` hook blocks that builtin import when the sandbox is
  active and untrusted, so it blocked just-bash's own chunk load. The file already
  statically imports from `./expansion.js`, so `isArray` is now pulled from that
  static import and the two lazy imports are removed — no lazy `node:module`-bearing
  chunk is linked at runtime. No public API change.

- [#276](https://github.com/vercel-labs/just-bash/pull/276) [`1ec5eec`](https://github.com/vercel-labs/just-bash/commit/1ec5eec0aefd099d23ac9f056df1e6612c81d49b) Thanks [@mutewinter](https://github.com/mutewinter)! - interpreter: preserve leading whitespace in multi-line quoted strings (fixes [#259](https://github.com/vercel-labs/just-bash/issues/259))

  `exec()` runs each script through `normalizeScript()`, which `trimStart()`s
  leading indentation from lines so indented template-literal scripts parse. It
  was applied line-by-line and stripped the leading whitespace inside multi-line
  single- and double-quoted strings too. The visible symptom was `python3 -c
'...'` (and `node -e`, `awk`, etc.) with an indented body failing with
  `IndentationError`, while the same code via heredoc or pipe worked.

  `normalizeScript()` is now quote-aware (mirroring the earlier heredoc-aware
  fix): it only strips indentation from lines that begin outside any quote, and
  preserves lines that begin inside an unterminated single- or double-quoted
  string verbatim. This also un-skips four sed spec tests whose indented stdin
  was previously being corrupted.

- [#286](https://github.com/vercel-labs/just-bash/pull/286) [`cb2b583`](https://github.com/vercel-labs/just-bash/commit/cb2b583b3f46e6bb4e6982c4bfe19903ec811a87) Thanks [@privatenumber](https://github.com/privatenumber)! - interpreter: deliver redirected output to each fd's final target (fixes `cmd > file 2>&1` leaking stderr to stdout)

  `applyRedirections()` processed a command's redirection list sequentially over
  the result's stdout/stderr strings, moving content at each step. The
  duplication operators (`2>&1`, `1>&2`) merged into the live stream regardless
  of where the source fd pointed, so the canonical `cmd > file 2>&1` wrote
  stdout to the file but leaked stderr onto the caller's stdout — including
  "command not found" errors and custom-command stderr. Any wrapper protocol
  that parses the enclosing script's stdout (e.g. a runner emitting a JSON
  payload after `eval "$CMD" > "$OUT" 2>&1`) saw the leaked stderr corrupt its
  stream. Ordering variants were wrong in other ways: `cmd 2>&1 > file` put
  stderr in the file instead of on stdout, and `cmd > a > b` wrote content to
  `a` instead of `b`.

  The pass now mirrors how bash sets up fds before running the command: each
  output redirection only opens/truncates its target and re-points the fd's
  sink (file, /dev/null, or a snapshot of the caller-visible stream), and
  duplication operators copy the source fd's current sink. Stream content is
  delivered once, after the whole list is processed, to each fd's final sink.
  This makes `cmd > file 2>&1` send stderr to the file, `cmd 2>&1 > file` keep
  stderr on the caller's stdout, `cmd > all 2>&1 2> err` let the later `2> err`
  reclaim stderr, and `cmd > a > b` truncate `a` while writing content to `b`.
  The `/dev/null`-as-regular-VFS-file behavior for stdout redirects is
  preserved.

## 3.0.2

### Patch Changes

- [#272](https://github.com/vercel-labs/just-bash/pull/272) [`150a915`](https://github.com/vercel-labs/just-bash/commit/150a915a1d45a2cc7f2b6aec3268f27116c34916) Thanks [@trieloff](https://github.com/trieloff)! - interpreter: fix UTF-8 mojibake when a script interleaves text-output and byte-output statements

  A single `exec()` can interleave text-shaped statements (sed, awk, echo — `ö`
  as `U+00F6`) with byte-shaped ones (grep | head, cat — `ö` as bytes
  `0xC3 0xB6`). `executeScript` / `executeStatement` concatenated each result's
  raw stdout, so the lone high byte from the text half made the combined stream
  invalid UTF-8, the output-boundary decoder bailed, and the byte half came back
  as Latin-1 mojibake (`KÃ¶penicker` for `Köpenicker`). The same path backs
  command substitution, so `echo "你好: $(cat /file)"` was affected too.

  The fix decodes each statement/pipeline result to text via its explicit
  `stdoutKind` (`decodedTextFromResult`) before concatenating — no guessing from
  string contents, so text whose code units merely look like UTF-8 (`Ã¶`) is
  preserved. `tac` (stdin path) and `curl` (response body) now declare
  `stdoutKind: "bytes"` on the results that forward raw bytes, so the decode is
  driven per output rather than by inspecting characters.

- [#256](https://github.com/vercel-labs/just-bash/pull/256) [`75d8dfd`](https://github.com/vercel-labs/just-bash/commit/75d8dfd3a322786250e3b0f81b1500c87610acb7) Thanks [@Hazzng](https://github.com/Hazzng)! - js-exec: fix Buffer shim correctness — ascii encode now uses & 0xff (not & 0x7f), consolidate latin1/ascii into shared \_rawEncode, fix Buffer.from(ArrayBuffer, offset, length), throw on invalid byteLength input, clamp negative toString start, throw RangeError for out-of-range write offset

- [#239](https://github.com/vercel-labs/just-bash/pull/239) [`1369b77`](https://github.com/vercel-labs/just-bash/commit/1369b772fe887694c09ce834d1b0b21aa6420b59) Thanks [@trieloff](https://github.com/trieloff)! - curl: interpret `@file` for `-d`/`--data`, `--data-binary`, and `--data-urlencode`

  Real curl reads file contents when these flags are passed `@filename`:

  - `-d @file` / `--data @file` — read file contents, strip CR/LF.
  - `--data-binary @file` — read file contents verbatim (newlines preserved).
  - `--data-urlencode @file` — read file, URL-encode the contents.
  - `--data-urlencode name@file` — prefix the URL-encoded contents with `name=`.

  just-bash's curl previously passed `@filename` through verbatim as the HTTP body. Posting JSON or any non-trivial payload via `curl --data-binary @payload.json https://…` sent the literal string `@payload.json` instead of the file. The new behavior matches upstream curl; `--data-raw` keeps the documented "no `@` interpretation" semantics.

- [#262](https://github.com/vercel-labs/just-bash/pull/262) [`4ece258`](https://github.com/vercel-labs/just-bash/commit/4ece2580d8cb707e6c6b7fa22897ea3fdd21739a) Thanks [@chernetsov](https://github.com/chernetsov)! - parser: don't treat quotes inside a heredoc body as shell quotes when finding the end of a command substitution

  A command substitution whose body contained a heredoc with an unbalanced quote in its body — most commonly an apostrophe in literal prose, e.g. `June's` — failed to parse with `bash: syntax error: ... unexpected EOF while looking for matching ')'`:

  ```bash
  OUT=$(cat <<'SCRIPT'
  June's moon
  SCRIPT
  )
  ```

  Both the lexer's `$(...)` word scanner and the substitution boundary scanner walked into the heredoc body and applied shell quote tracking to it. The `'` in `June's` opened a single-quoted string that never closed, so the closing `)` was swallowed and the scan ran to EOF. In bash a heredoc body is literal text and must be skipped wholesale when locating the substitution boundary.

  Both scanners are now heredoc-aware: when scanning a `$(...)` they recognize `<<` / `<<-` operators (but not the `<<<` here-string), capture the possibly-quoted delimiter, and skip the heredoc body lines literally — without quote or paren tracking — up to the terminator. Multiple heredocs on one line and tab-stripping (`<<-`) are handled. This fixes the common pattern of capturing the output of a connector/CLI invocation that is fed a heredoc script containing apostrophes, backticks, or parentheses.

  The heredoc scan also tracks arithmetic `((...))` nesting so a `<<` left-shift inside `$((...))` (or a nested arithmetic expansion) is not mistaken for a heredoc opener — previously a multi-line arithmetic expansion containing a shift, e.g. `$((\n1 << 2\n))`, had its closing `))` swallowed by spurious body-skipping.

- [#248](https://github.com/vercel-labs/just-bash/pull/248) [`d64009a`](https://github.com/vercel-labs/just-bash/commit/d64009aef6bc1556e7c84b22ed455863275ea953) Thanks [@Hazzng](https://github.com/Hazzng)! - perf(grep): up to 14.5× speedup via preFilter extensions and matcher reuse.

  Anchored alternation patterns like `^def \|^async def` now extract literal needles (stripping outer `^`/`$`), enabling the `String.indexOf` fast-path. Files with no matching needle are rejected before `split("\n")`, skipping RE2 entirely. `acquireMatcher()` extended to `match()`, `replace()`, `search()`, and `matchAll()` to reduce GC pressure across awk/sed hot-paths.

- [#261](https://github.com/vercel-labs/just-bash/pull/261) [`c9904de`](https://github.com/vercel-labs/just-bash/commit/c9904dea24ad2aa847749ee6289239c2a2c651fc) Thanks [@chernetsov](https://github.com/chernetsov)! - set: support a bundled `-o`/`+o` long option inside a short-flag cluster (e.g. `set -euo pipefail`)

  The `set` builtin previously rejected `set -euo pipefail` with `bash: set: -o: invalid option`, because it parsed each character after the `-` as an independent short flag and has no `o` short flag. `-o` was only honored as its own token (`set -eu -o pipefail`).

  This is the canonical "bash strict mode" idiom and is extremely common in generated scripts, so the whole script would abort on its first line.

  `set` now matches bash: an `o` inside a cluster consumes the _next word_ as its long-option name, and the remaining characters keep being parsed as short flags. So `set -euo pipefail` is equivalent to `set -e -u -o pipefail`, `set -oe pipefail` enables both `pipefail` and `errexit`, trailing words become positional parameters, and `+`-clusters (`set +euo pipefail`) disable the options. An invalid bundled name (`set -euo bogus`) still reports `invalid option name`, and an `o` with no following argument falls back to the standalone `-o`/`+o` listing.

## 3.0.1

### Patch Changes

- [#238](https://github.com/vercel-labs/just-bash/pull/238) [`01a4721`](https://github.com/vercel-labs/just-bash/commit/01a4721324350adea4b035b311f0b60ccdbb65ff) Thanks [@cramforce](https://github.com/cramforce)! - Fix `Dynamic require of "tty" is not supported` crash when invoking commands that transitively load `debug` / `supports-color` (notably `file`) under ESM Node consumers and via the `just-bash` CLI binary.

  The esbuild dynamic-require shim emitted into the ESM Node bundles had no `require` to delegate to at chunk-init under ESM, so any runtime `require("tty")` / `require("os")` from `file-type` → `debug` chain threw. Build banners now provide `createRequire(import.meta.url)` for `build:lib`, `build:cli`, and `build:shell`. CJS and browser bundles are unchanged.

  Fixes [#211](https://github.com/vercel-labs/just-bash/issues/211).

## 3.0.0

### Major Changes

- [#233](https://github.com/vercel-labs/just-bash/pull/233) [`7cca738`](https://github.com/vercel-labs/just-bash/commit/7cca73831987e3331160f426b7a66d7217b8cf79) Thanks [@cramforce](https://github.com/cramforce)! - Breaking change for stdin byte/utf8-handling. Will break some custom commands that handle stdin

### Minor Changes

- [#209](https://github.com/vercel-labs/just-bash/pull/209) [`b3bd85e`](https://github.com/vercel-labs/just-bash/commit/b3bd85ed816445e6d148290163a1900f49ebea82) Thanks [@cramforce](https://github.com/cramforce)! - Introducing plumbing for integrating executor and adding a peer package for the implememtation

- [#233](https://github.com/vercel-labs/just-bash/pull/233) [`7cca738`](https://github.com/vercel-labs/just-bash/commit/7cca73831987e3331160f426b7a66d7217b8cf79) Thanks [@cramforce](https://github.com/cramforce)! - TS-enforced correct handling of utf8 on stdin. Impacts many commands

## 2.14.5

### Patch Changes

- [#214](https://github.com/vercel-labs/just-bash/pull/214) [`da58f4f`](https://github.com/vercel-labs/just-bash/commit/da58f4f523c5e9c1c444106a0f2a7777a59fb618) Thanks [@subsetpark](https://github.com/subsetpark)! - jq: accept control characters inside JSON strings

- [#221](https://github.com/vercel-labs/just-bash/pull/221) [`a835686`](https://github.com/vercel-labs/just-bash/commit/a835686c97f5cac2e5b94bd551d996079a33dfc2) Thanks [@cramforce](https://github.com/cramforce)! - upgrade deps

- [#218](https://github.com/vercel-labs/just-bash/pull/218) [`13d78b2`](https://github.com/vercel-labs/just-bash/commit/13d78b2876d7ac7b6bc3a6eacfa3937bbb79665f) Thanks [@Hazzng](https://github.com/Hazzng)! - grep: 5-123x faster pattern matching via RE2 matcher reuse and literal pre-filter

## 2.14.4

### Patch Changes

- [#206](https://github.com/vercel-labs/just-bash/pull/206) [`6ccc35f`](https://github.com/vercel-labs/just-bash/commit/6ccc35f5a9b5c6f395b145ed2ec7ee71c4862057) Thanks [@subsetpark](https://github.com/subsetpark)! - Fix awk lexer to honor POSIX statement continuation across newlines after `,`,
  `{`, `&&`, `||`, `?`, `:`, `do`, `else`, `if`, and `while`. Previously, a
  multi-line idiom like `printf "%s=%d\n", \n  $1, $2` (comma at end-of-line
  followed by indented args on the next line) failed with `Unexpected token:
NEWLINE` because the lexer emitted a NEWLINE token unconditionally. The
  lexer now suppresses the NEWLINE when it immediately follows one of the
  continuation-allowing tokens, matching POSIX awk.

- [#212](https://github.com/vercel-labs/just-bash/pull/212) [`733c847`](https://github.com/vercel-labs/just-bash/commit/733c84796e3abbd05a25cf67805bf4b030d0b02d) Thanks [@cramforce](https://github.com/cramforce)! - Bug fixes across network, sqlite3, xan, rg, terminal rendering, and CI

## 2.14.3

### Patch Changes

- [#199](https://github.com/vercel-labs/just-bash/pull/199) [`3d11f05`](https://github.com/vercel-labs/just-bash/commit/3d11f05959faa205267a5173b25665c6732fee8b) Thanks [@cramforce](https://github.com/cramforce)! - Internal: convert repository to a pnpm workspace under `packages/just-bash` and adopt Changesets for versioning. No public API changes; `import` paths and the `bin` entries are unchanged.
