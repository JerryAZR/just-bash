---
"@jerryan/just-bash": patch
---

interpreter: give a loop left via `break`/`continue` status 0 instead of the last command's

`break` and `continue` are builtins that return 0, and they are the last command a loop body runs. A loop exited through them reported the status of whatever ran *before* the `break` instead:

```bash
while :; do false; break; done; echo $?            # was 1, bash says 0
for i in 1; do false; break; done; echo $?         # was 1, bash says 0
for i in 1 2; do false; continue; done; echo $?    # was 1, bash says 0
```

All four loop forms were affected — `for`, C-style `for`, `while`, `until` — as was a `break`/`continue` in a `while` condition and a multi-level `break 2` unwinding through an enclosing loop. Under `set -e` the phantom failing loop ended the script with no output and no diagnostic.

`$?` moves with the status, so the next iteration sees it too. `continue` does not pin the status — a later iteration still overwrites it — and a loop that ends normally is unchanged.

Ported from upstream vercel-labs/just-bash#417.
