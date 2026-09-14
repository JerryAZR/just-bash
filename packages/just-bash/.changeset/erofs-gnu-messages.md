---
"@jerryan/just-bash": patch
---

feat: generic --version for all commands + EROFS GNU messages

- All commands now respond to --version with "<cmd> (just-bash)"
  via a dispatch-level interception. Commands that handle their own
  version (python3, js-exec, diff, rg) set handlesOwnVersion: true.
- rm/cp/mv map EROFS → "Read-only file system" (GNU style, was raw
  Node error dump with EROFS: prefix and internal paths)
- rg implements --version
