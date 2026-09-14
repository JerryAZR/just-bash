---
"@jerryan/just-bash": patch
---

fix(interpreter): redirect failure on read-only FS continues script

Previously, `echo x > file` on a read-only filesystem threw an
unhandled EROFS error that killed the entire script. Now it follows
bash semantics: the command fails with exit code 1, an error message
goes to stderr, and the script continues to the next command.

The root cause was `handleWriteError = false` in the redirect path
(introduced by the transactional redirect refactor), which rethrew
filesystem errors instead of converting them to command-level results.
