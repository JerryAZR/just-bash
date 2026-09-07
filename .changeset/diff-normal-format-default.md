---
"just-bash": minor
---

`diff` now defaults to POSIX normal format (`2c2` / `<` / `---` / `>`) instead of unified, matching GNU diffutils and POSIX. **This changes the default output and will break anything parsing the previous unified-by-default output** — pass `-u` to keep unified.

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
