---
"@jerryan/just-bash": minor
---

feat: Windows drive-letter path translation (win32 only)

On Windows, `C:\foo\bar` and `C:/foo/bar` are translated to `/c/foo/bar`
(Git Bash convention) in `resolvePath`. On POSIX, `C:\foo` is a valid
relative filename and is NOT rewritten.
