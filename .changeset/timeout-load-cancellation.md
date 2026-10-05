---
"@jerryan/just-bash": patch
---

timeout: a deadline that lands while a command is still loading no longer aborts the rest of the script

`timeout` on a cold command — the first use of any lazily loaded command — could return 124 and still kill every statement after it. Cancelled invocations now stop waiting for the load and report cancellation instead. (Upstream: vercel-labs/just-bash#506)
