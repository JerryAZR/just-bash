---
"@jerryan/just-bash": patch
---

Assign array-valued parameter defaults correctly. `"${value:=${defaults[@]}}"` now assigns the joined default to `value` (space-joined for `[@]`, IFS-joined for `[*]`) and rejects whole-array targets like `${a[@]:=x}` with `bad array subscript`, matching GNU bash. Also bounds joined array expansions by `maxStringLength` before assigning and preserves non-BMP IFS separators. (Upstream: vercel-labs/just-bash#519)
