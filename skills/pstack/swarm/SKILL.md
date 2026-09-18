---
name: swarm
description: "Fan out up to four independent workers for real coverage, measured samples, or disjoint work, then return one evidenced report."
disable-model-invocation: true
---

# Swarm

Use a swarm only when work has independent slices or a meaningful sample size. One difficult task is not a swarm.

1. State the done predicate, required coverage, and aggregation rule.
2. Derive the smallest useful N, capped at four.
3. Route fixed extraction or repeated verification to `mechanical`, well-specified exploration or implementation to `bounded`, and ambiguous slices to `complex`. Never use `critical` as a swarm default.
4. Give every task a standalone goal, exact slice, paths, authority, verification, and output contract. Parallel writers need isolated worktrees or disjoint paths; otherwise use `readonly: true`.
5. Drain every result. Treat failures as explicit dropouts and verify material claims against source or runtime.

Return one compact coverage table, confirmed findings, gaps, dropouts, and the selection rule for races. Do not paste raw child reports.
