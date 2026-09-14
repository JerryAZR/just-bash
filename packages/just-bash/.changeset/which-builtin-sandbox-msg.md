---
"@jerryan/just-bash": patch
---

feat(which): builtin awareness + sandbox miss message

`which` now checks shell builtins when no file is found in PATH
(e.g., `which cd` → "cd: shell builtin"). On complete miss, prints
"which: no X in this sandboxed bash environment" to stderr instead
of silently exiting 1.
