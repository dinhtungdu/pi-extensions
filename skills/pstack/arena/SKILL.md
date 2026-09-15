---
name: arena
description: "Spawn parallel candidates for the same non-trivial artifact, pick a base, graft the strongest ideas, and verify the synthesis. Use for /skill:arena, 'arena this', or when one attempt would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

## Frame

Define one artifact and 3-6 gradeable criteria. Pick 2-4 runners from the configured `arena runners` pool. Give every runner the same task contract. If candidates write, assign separate worktrees or disjoint scratch paths; otherwise set `readonly: true` on every task.

## Fan out

Call `subagent` once with a parallel `tasks` array. Use `agent: "poteto-agent"`, `role: "arena runners"`, the shared contract, and each candidate's isolated path. Require the artifact plus a short rationale naming alternatives considered and rejected. Proceed if one runner fails; record the dropout.

## Cross-judge

After every candidate finishes, call one `poteto-agent` with `role: "arena cross-judge pool"` and `readonly: true`. Give it the rubric and candidate paths or outputs. It scores every criterion and recommends a base. The parent reads every candidate independently.

## Pick and graft

Pick the easiest correct base to maintain. Disagreement with the judge means reread the evidence, not average scores. Fold in only clearly stronger parts from losing candidates, preserving one coherent design. Record the base, grafts, rejections, convergence, and dropouts.

## Verify

Run the same checks the final artifact must pass. If verification fails, fix the synthesis or reframe and rerun; multiple candidates never substitute for proof.

Return one artifact and one compact synthesis note.
