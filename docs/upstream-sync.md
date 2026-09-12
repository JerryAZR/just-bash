# Upstream sync state

Tracks which upstream (vercel-labs/just-bash) commits we've reviewed,
so the next sync doesn't re-review covered ground.

**Last reviewed through: `062ce00`** (2026-09-12)

## Reviewed commits (newest first)

| Upstream SHA | Description | Action | Our SHA |
|---|---|---|---|
| `062ce00` | fix(fs): lazy file providers in defense-in-depth trusted scope (#397) | Cherry-picked | `689d409` |
| `108c5cc` | perf(regex): cache compiled RE2 patterns (#399) | Cherry-picked | `04dad0d` |
| `2d9d41f` | fix(diff): default to POSIX normal format (#413) | Cherry-picked | `30e7df8` |
| `bbf3881` | fix(file): report gzip from its header (#365) | Cherry-picked | `e6ae113` |
| `08e22d8` | chore: add prha as a code owner (#404) | **Skipped** — CODEOWNERS is upstream-specific | — |
| `f559fc1` | fix(interpreter): bare assignment exit status 0 (#400) | Cherry-picked | `fa769ce` |
| `b7f556f` | fix(ls): bound directory entry collections (#390) | Cherry-picked | `68f6984` |
| `556a739` | refactor(js-exec): port JavaScript runtime to run (#394) | **Reverted** — `run` package has a hardcoded 10,000 interrupt check limit that caps writes at ~4MB. See `docs/design/js-exec-worker.md`. Backup branch: `backup/run-refactor-pre-split`. | — |

## Older upstream commits (before our merge point)

These predate our last full merge and were not individually reviewed:

- `a2a5843` fix(curl): don't build stdout when writing to file (#378)
- `c9bd93e` Fix workflow triggers (#395)
- `4de3cd6` fix(ls): match GNU and BSD on operand handling (#363)
- `43c37ce` fix(ln): report a refused symlink as a symlink failure (#391)

## How to sync

```bash
git fetch upstream
git log --oneline 062ce00..upstream/main   # new commits since last review
```

Cherry-pick individually, retarget changesets to `@jerryan/just-bash`,
and update this file with the new "last reviewed through" SHA.
