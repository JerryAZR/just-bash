---
"@jerryan/just-bash": patch
---

Reject default assignment to positional and special parameters. `echo "${1:=fallback}"` and `${@:=fallback}` now fail with `bash: $1: cannot assign in this way` instead of silently assigning, matching GNU bash. (Upstream: vercel-labs/just-bash#520)
