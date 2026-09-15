---
name: swarm
description: "Fan out bounded parallel workers, drain every result, and return one evidenced report. Use for /skill:swarm, 'swarm this', parallel coverage, races, gauntlets, or broad read-only exploration."
disable-model-invocation: true
---

# Swarm

## Frame

State the done predicate and final report. Choose one shape: disjoint coverage, identical race, or a mix. For a race, declare `first pass`, `rank all`, or `best of` before launch. Derive N from the work, capped by the `subagent` tool.

Use the configured `swarm workers` role. If workers write, every worker needs a separate worktree or disjoint scratch path. Otherwise keep the swarm read-only.

## Fan out

Call `subagent` once with a parallel `tasks` array. Use `agent: "poteto-agent"` and `role: "swarm workers"`. Every brief stands alone: goal, exact slice or race arm, paths, authority, verification, and required report. Results use `PASS`, `ISSUES`, or `BLOCKED` with evidence.

A child failure is a reported dropout. Continue with remaining results unless its slice is required for coverage.

## Aggregate

Read every terminal result. For coverage, every required slice needs evidence. For a race, apply the declared selection rule. Verify material claims against source or runtime. Do not paste raw child dumps.

Return one compact table, one-line confirmed issues, explicit gaps/dropouts, and the race rule when used.
