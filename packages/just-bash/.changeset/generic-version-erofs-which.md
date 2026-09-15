---
"@jerryan/just-bash": minor
---

feat: generic --version, EROFS GNU messages, which improvements

- All commands respond to `--version` with `<cmd> (just-bash)` via
  dispatch-level interception. Commands that handle their own version
  (python3, js-exec, diff, rg) set `handlesOwnVersion: true`. Custom
  commands that handle `--version` must set `handlesOwnVersion: true`
  to opt out of the generic response.
- rm/cp/mv/mkdir map EROFS to "Read-only file system" (GNU style).
  Redirect failures use errno descriptions ("Read-only file system",
  "Permission denied", etc.) matching real bash.
- `which` checks shell builtins when no file found in PATH, and prints
  "which: no X in this sandboxed bash environment" on miss.
- rg implements `--version`.
