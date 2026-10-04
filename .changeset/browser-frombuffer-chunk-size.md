---
"@jerryan/just-bash": patch
---

fs: keep the Buffer-less `fromBuffer` fallback under the argument limit (upstream vercel-labs/just-bash#346)

Without `Buffer` (for example in a Chrome extension service worker), `fromBuffer` converted `base64`, `binary` and `latin1` content by spreading 64KB chunks into `String.fromCharCode`, which can exceed the engine's argument limit and throw `RangeError: Maximum call stack size exceeded` on a 64KB `cat`. The fallback now converts in 8KB chunks.
