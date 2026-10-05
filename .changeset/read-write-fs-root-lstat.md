---
"@jerryan/just-bash": patch
---

Let `ReadWriteFs.lstat` and `ReadWriteFs.readlink` accept the sandbox root (upstream vercel-labs/just-bash#454)

Both authorized a path by validating the directory above it, which for `/` lies outside the sandbox, so they failed with `EACCES`. Since `find`, `du`, `chmod -R` and `file` run on `lstat`, `find .` and `find /` at the root printed nothing and exited 0, `du` and `chmod -R` reported `cannot access '/'`, and `file /` reported `cannot open`. The root is now validated directly, as `mkdir` and `link` already do.
