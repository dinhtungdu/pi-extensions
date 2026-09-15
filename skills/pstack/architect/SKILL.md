---
name: architect
description: "Use for architecture, planning, approach, design, system-design, API-boundary, dependency-direction, or before implementing a non-trivial cross-file change. Parallel candidates explore the design space, then the parent synthesizes one plan."
disable-model-invocation: true
---

# Architect

Produce one implementation-ready architecture plan. Do not edit production code.

## 1. Ground

Read the relevant code and constraints first. State the problem, non-goals, invariants, trust boundaries, ownership boundaries, and observable success. For local architectural questions, use `/skill:how` first.

## 2. Fan out

Call `subagent` once with 2-4 parallel tasks, all using `agent: "poteto-agent"`, `role: "architect runners"`, and `readonly: true`. Give every candidate the same grounded problem and [runner prompt](references/runner-prompt.md), but ask for genuinely different designs. Use separate output paths only if a candidate must create an artifact.

Each candidate must include concrete files and APIs, data/control flow, migration sequence, failure modes, verification, tradeoffs, and rejected alternatives. Apply [design red flags](references/design-red-flags.md).

## 3. Judge and synthesize

Read every candidate. Score it against the task's actual constraints, not aesthetic preference. Pick the smallest base that preserves the required invariants, then graft only stronger pieces that remain coherent. Record the decision using [the rationale template](references/rationale-template.md).

## 4. Interrogate

Use `/skill:interrogate` on the synthesized plan. Resolve every blocker with source evidence. Do not average contradictory designs.

## Output

Return one plan with:

- Summary and non-goals
- Current state with file references
- Target boundaries and flow
- Ordered implementation units, each independently verifiable
- Migration and rollback constraints
- Verification strategy
- Risks, rejected alternatives, and unresolved user decisions
