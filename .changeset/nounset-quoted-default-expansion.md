---
"@jerryan/just-bash": patch
---

Fix default, assignment, and alternative parameter expansions used as an entire double-quoted word under `set -u`. For example, `echo "${U:-fallback}"` now prints `fallback` when `U` is unset instead of reporting "unbound variable". This also lets scripts safely check optional CI variables such as `GITHUB_STEP_SUMMARY`. (Upstream: vercel-labs/just-bash#416)
