---
"@jerryan/just-bash": patch
---

fix: find command no longer crashes host process on abort

When an AbortSignal fires during `find`'s parallel batch traversal,
all concurrent `processNode` promises throw `ExecutionAbortedError`
from the traversal budget checkpoint. `Promise.all` only catches the
first rejection — the rest become unhandled rejections that crash the
host process (e.g. pi) with `uncaughtException`.

Fix: catch `ExecutionAbortedError` inside the `Promise.all` map
callbacks and return null. The abort is still detected on the next
sequential checkpoint and properly propagated as exit code 124.
