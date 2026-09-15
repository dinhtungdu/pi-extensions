---
name: figure-it-out
description: "Design an auditable workflow when no narrower playbook fits: large migration, ambitious multi-part change, or work reviewed after the user steps away. Scales rigor to risk and logs decisions through show-me-your-work."
disable-model-invocation: true
---

# Figure It Out

Use only when no narrower pstack playbook fits.

## Frame

State a falsifiable done predicate, quantified scope, unknowns, blast radius, non-goals, and rigor level. A multi-hour or one-way-door plan gets a user checkpoint; routine reversible work continues.

## Design

Split work into the fewest independently verifiable units. Put risky unknowns and verification scaffolding first. Use `/skill:architect` for one-way-door boundaries, not mechanical work. Parallelize only along real seams; isolate every writer.

Write the phase list in the existing Manager task record when one is active. Otherwise keep a short in-chat checklist or user-requested plan file. Do not invent another tracker.

## Experiment loop

For each unit: state the hypothesis, make the smallest change, inspect the artifact, run the predicate, and keep or revert based on evidence. Verdicts are `VERIFIED`, `NOT VERIFIED`, or `INCONCLUSIVE`; inconclusive never passes.

Pair delegated work with independent review when risk warrants it. The parent verifies child artifacts directly.

## Trail and handoff

Use `/skill:show-me-your-work` for a long run. Log decisions and checkpoints, not every command. Commit the trail only when explicitly requested or required for review.

Return the designed workflow, rigor choice, evidence paths, predicate status, and exact open decisions.
