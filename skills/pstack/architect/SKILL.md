---
name: architect
description: "Design a consequential API, ownership boundary, or cross-system change through grounded competing sketches and parent synthesis."
disable-model-invocation: true
---

# Architect

Produce one implementation-ready design. Do not edit production code.

## Ground

Read the current flow and constraints. State the user outcome, non-goals, invariants, trust and ownership boundaries, callers, and observable success. Use `/skill:how` or `/skill:why` only for missing mechanics or motivation.

## Compare

Run two independent read-only candidates with the same grounding brief and [runner prompt](references/runner-prompt.md):

- one `bounded` pragmatic design
- one `complex` deep design

Require concrete call sites, core types, public signatures, data flow, migration, failure modes, verification, tradeoffs, and rejected alternatives. Two candidates are enough unless a third tests a genuinely different premise.

## Synthesize

The parent reads both candidates, checks them against [design red flags](references/design-red-flags.md), and chooses the smallest coherent shape. Do not average designs. Use one `critical` judge only for an irreversible decision with material disagreement, or after complex work fails with new evidence.

Return one design using [the rationale template](references/rationale-template.md), ordered independently verifiable implementation units, verification strategy, risks, rejected alternatives, and unresolved user decisions.
