# Shipping

Shipping changes external state. The retained parent performs only actions explicitly authorized by the user/task; children provide independent evidence.

1. Resolve the exact PRs, base/head SHAs, intended order, and active forge with read-only inspection.
2. For each PR, run an independent `subagent` verification against its actual behavior and current head. Use isolated checkouts when needed. CI green alone is not a verdict.
3. Re-read current checks, reviews, mergeability, and head SHA immediately before any mutation. A stale verdict does not transfer to a changed head.
4. If merge authority is absent, report readiness and blockers. Stop.
5. If merge authority is explicit, the parent merges one PR at a time using the repository's Git policy, verifies the merged state, then reassesses descendants.
6. Deploy, release, cleanup, and branch deletion require their own authority. Never infer them from merge authority.

Return each PR's verified SHA, behavior verdict, checks, blockers, action taken, and remaining authorized action.
