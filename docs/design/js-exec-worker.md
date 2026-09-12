# js-exec Worker: Known Issues and Design Decisions

## Microtask draining (executePendingJobs loop)

**Problem**: A class of CI failures where the guest's final output is lost.
The signature is consistent: the script's last output (a `console.log` inside
a `Promise.resolve().then()` microtask, or the final line of an `import()`
result) never reaches the host. The execution completes successfully
(exitCode=0, no stderr) but stdout is empty or truncated.

**Observed on CI (never reproduced locally)**:
- `blocks nested js-exec from Promise microtask bridge callback` — empty stdout, 66ms
- `.code errno marshalling test` — empty stdout, 46ms
- `import() prototype-chain test` — last line truncated
- Node-24 `copyFile` flake — empty stdout

**Root cause (confident guess, unverified)**: `runtime.executePendingJobs()`
calls QuickJS's `JS_ExecutePendingJob` once. The C API executes one job per
call; jobs that schedule more jobs (e.g. `Promise.resolve().then()` inside a
`.then()`) may not all drain in a single pass. The QTS wrapper should loop
internally with `maxJobs=-1`, but this may fail when a job's sync bridge call
triggers `Atomics.wait` (which suspends the WASM thread and may interact
with QuickJS's job queue in unexpected ways).

**Fix**: Loop `executePendingJobs()` until it returns 0 jobs executed, with
a 10,000 iteration cap to prevent runaway chains. This is the standard
QuickJS drain pattern — harmless when one call already drains all jobs
(the loop exits immediately), and correct when it doesn't.

**Limitation**: We cannot reproduce the race locally (0 failures across
hundreds of attempts on Windows and under simulated CPU load). The fix is
structurally more correct but may not address the root cause if the issue
is elsewhere (e.g. in the sync bridge's Atomics interaction or the QuickJS
WASM build's asyncify mechanism).
