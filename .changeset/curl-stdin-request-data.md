---
"@jerryan/just-bash": patch
---

curl: support request data from stdin via `-d @-` / `--data-binary @-` / `--data-urlencode @-` (upstream vercel-labs/just-bash#411)

The exact `-` source consumes command stdin once; later references are empty. Binary stdin request bodies are sent verbatim (invalid UTF-8 preserved) without relying on Node's `Buffer`.
