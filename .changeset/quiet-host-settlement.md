---
"@jerryan/just-bash": patch
---

Host operations that settle after a cancelled execution no longer surface as a process-level `unhandledRejection`.

Aborting or timing out an execution while the worker bridge was awaiting a host tool (or an `exec`) left that operation to settle after the defense-in-depth box deactivated. The box's `Promise.prototype.then` guard, which blocks sandbox callbacks once their execution ends, then dropped the handlers meant to consume that result: a late rejection crashed processes that treat unhandled rejections as fatal, and a late success never reached the bridge. Host-side settlement now goes through `await`, which bypasses the guarded `then`. (Upstream: vercel-labs/just-bash#503)
