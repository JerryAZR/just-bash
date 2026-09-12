---
"@jerryan/just-bash": minor
---

Expose `maxJsMemoryBytes` in `ExecutionLimits` — the QuickJS heap limit (default 64MB) is now configurable per Bash instance. This is the only real cap on js-exec read/write sizes.
