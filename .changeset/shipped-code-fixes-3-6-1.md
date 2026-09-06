---
"@jerryan/just-bash": patch
---

Fixes since 3.6.0:

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
