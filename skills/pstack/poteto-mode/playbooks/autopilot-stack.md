# Autopilot stack

Apply only when several dependent branches or pull requests already form an intentional stack.

1. Inspect the real base/head relationship and current SHAs. Do not infer order from titles.
2. Work from the lowest unresolved unit upward. Serialize edits, rebases, and merges within a stack.
3. Give independent verification a pinned SHA and the behavior each unit protects.
4. A changed head invalidates prior verification. Re-run the affected check.
5. Children prepare patches or reports in isolated worktrees; the retained parent alone performs authorized pushes, restacks, PR mutations, and merges.
6. If authority is absent, stop at a verified handoff containing branches, SHAs, order, conflicts, and commands the parent may choose to run.

Do not add stack bookkeeping when ordinary Git history already answers the question.
