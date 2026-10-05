---
"@jerryan/just-bash": patch
---

find: report a directory it cannot read and keep going (upstream vercel-labs/just-bash#414)

A `readdir` failure inside the traversal threw out of the whole search, so one unreadable directory ended `find` with no results. GNU find names the directory on stderr, continues with everything else, and exits 1 at the end. It now does the same here. The message is `find: <path>: Permission denied`, with the phrase taken from the errno alone, so nothing from the underlying error's text reaches the output. A failure that is not one of the errnos a directory read can produce (a cancellation, an execution limit, a filesystem policy refusal) still ends the search as before.

Messages are emitted in traversal order beside the node's own output, whatever order the parallel batch settled in, and a failed read still counts toward the trace's `readdirCalls` and `readdirTime`.
