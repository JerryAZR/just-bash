---
"@jerryan/just-bash": patch
---

interpreter: preserve complete associative-array values in `declare -A` compound assignments (upstream vercel-labs/just-bash#445)

Quoted values containing whitespace were reconstructed without quoting before the `declare` builtin parsed them, so every value was silently truncated at its first space. Associative-array declarations now retain whitespace and other quoted content.
