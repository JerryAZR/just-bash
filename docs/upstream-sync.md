# Upstream sync state

Tracks which upstream (vercel-labs/just-bash) commits we've reviewed,
so the next sync doesn't re-review covered ground.

**Last reviewed through: `7537a26`** (2026-10-01, upstream release 3.6.0)

## Reviewed commits (newest first)

| Upstream SHA | Description | Action | Our SHA |
|---|---|---|---|
| `7537a26` | chore: release (#504) | **Skipped** — upstream release mechanics | — |
| `632090a` | chore(deps): update undici and smol-toml (#509) | Cherry-picked (overrides + ranges) | `e92b595` |
| `e0cca16` | fix(jq): to_entries on arrays, tonumber on empty strings (#384) | Cherry-picked | `b09632e` |
| `d91dce8` | refactor(expansion): share pattern-removal compilation (#518) | Cherry-picked | `5e7a68e` |
| `2d79d8b` | refactor(fs): simplify mount storage and routing (#517) | **Skipped** — behavior-identical, would churn fork's diff()/restamp() | — |
| `e9bc741` | chore(network): remove unused request-owned DNS transport (#516) | Cherry-picked | `e0896d2` |
| `d959d9f` | fix(curl): support request data from stdin (#411) | Cherry-picked (NUL-stripping left out) | `c02090e` |
| `f77efbd`/`f826b2f`/`0ccc9d5`/`69ac484`/`a25da1d`/`5eb1bfc` | chores: CONTRIBUTING, issue templates, LFS lock, code owners, badges, release | **Skipped** — upstream-specific | — |
| `9503e06` | fix(expansion): assign array-valued parameter defaults (#519) | Cherry-picked | `f9d4cac` |
| `701f8e5` | fix(expansion): reject default assignment to positional parameters (#520) | Cherry-picked | `b3824fc` |
| `4af0dc0` | fix(expansion): nounset on whole-word quoted ${var:-default} (#416) | Cherry-picked | `03c1bf3` |
| `52a5617` | fix: lower browser buffer conversion chunk size (#346) | Cherry-picked | `ac61171` |
| `90df057` | fix(grep): combine repeated -e patterns (#314) | Cherry-picked | `4c78060` |
| `c21d678` | fix(fs): standard layout in a MountableFs base (#488) | Cherry-picked | `05f267c` |
| `ef8c75d` | fix(worker-bridge): ignore stale wake from previous request (#513) | **Skipped** — moot: fork's two-word protocol eliminates the stale-wake class | — |
| `4ee035b` | fix: keep shell running when a cancelled command is still loading (#506) | Cherry-picked (loader adapted) | `d13cf6f` |
| `0353b22` | fix(sed): keep leading whitespace after a\, i\ and c\ (#487) | Cherry-picked | `8966372` |
| `a36c324` | fix: support Bun module accessor descriptors (#443) | **Deferred** — only relevant for Bun support; needs adaptation | — |
| `128feaa` | fix: virtual executable name for Python workers (#444) | Cherry-picked | `4a3e413` |
| `017a911` | fix(interpreter): loop left via break/continue status 0 (#417) | Cherry-picked | `2a8626d` |
| `cc35fab` | feat(mktemp): GNU-compatible mktemp (#377) | **Pending** — needs OverlayTree-specific createExclusive design | — |
| `31ac823` | fix(find): report unreadable dir and keep going (#414) | Cherry-picked | `205648d` |
| `7313062` | fix(interpreter): preserve associative array compound values (#445) | Cherry-picked | `66565ae` |
| `5d19cc3` | feat(yes): implement the yes command (#409) | Cherry-picked | `8c18f71` |
| `2201d6b` | refactor: share worker lifecycle (#470) | **Skipped** — fork already has its own richer WorkerRequestController | — |
| `022e260` | fix(fs): ReadWriteFs lstat/readlink accept sandbox root (#454) | Cherry-picked | `4a96d1a` |
| `130da94` | fix: handle late host rejections after cancellation (#503) | Cherry-picked (test rewritten for two-word protocol) | `3931199` |
| `23eb99e` | chore(deps): update brace-expansion (#469) | Cherry-picked (overrides) | `e92b595` |
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
git log --oneline 7537a26..upstream/main   # new commits since last review
```

Cherry-pick individually, retarget changesets to `@jerryan/just-bash`,
and update this file with the new "last reviewed through" SHA.

Bug fixes go red-first: port the upstream test first, confirm it fails
against the current implementation, then port the fix.
