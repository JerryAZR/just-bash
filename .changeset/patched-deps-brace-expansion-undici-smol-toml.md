---
"@jerryan/just-bash": patch
---

Bundle the patched `smol-toml` 1.9.0 and require patched `brace-expansion` and `undici`.

The Node bundle inlines `smol-toml`, so a consumer can't pick up its fix through its own lockfile. Only a just-bash release carries it. (Upstream: vercel-labs/just-bash#469, #509)
