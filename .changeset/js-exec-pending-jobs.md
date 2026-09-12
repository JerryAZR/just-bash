---
"@jerryan/just-bash": patch
---

Fix a class of CI failures where js-exec guest output was lost: loop `executePendingJobs()` until all QuickJS jobs drain, not just the first batch.
