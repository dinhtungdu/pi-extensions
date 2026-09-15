---
name: interrogate
description: "Use for interrogate, adversarial review, multi-model review, challenge this, stress-test this code, find blind spots, or tear this apart. Independent Pi subagents review the same change; the parent verifies and judges findings."
disable-model-invocation: true
---

# Interrogate

Deliver a synthesized verdict. Do not auto-apply changes.

## Scope and intent

Identify the exact diff or files. Read enough surrounding code to state one paragraph describing what the change must accomplish. If product intent is genuinely unknown, ask before reviewing; otherwise infer routine details from the task and code.

## Parallel review

Call `subagent` once with one task per configured `interrogate reviewers` model and `readonly: true`. Use `agent: "poteto-agent"` and `role: "interrogate reviewers"`. Give every reviewer the same:

1. Intent
2. Diff or precise file paths and base
3. [Review prompt](references/reviewer-prompt.md)
4. [Rubric](references/rubric.md)
5. [Code-quality lens](references/code-quality-review.md)

If a configured model is invalid, call `pstack_config` with `action: "list-models"`, choose a valid close equivalent or inherit the parent, and report the stale mapping. Do not block the review.

## Parent judgment

Deduplicate results, identify independent agreement and disagreement, then verify each material claim against the source. Reviewers are evidence, not verdicts. Apply [lead judgment](references/lead-judgment.md):

- **Act on:** real correctness, security, or maintainability blocker for the stated intent
- **Consider:** legitimate tradeoff whose benefit may not justify cost now
- **Noted:** valid but low-priority or context-dependent
- **Dismissed:** wrong, unsupported, duplicate, or preference-only

For every item, name the reviewer models and give one-line evidence. Never inflate confidence merely because identical models repeated the same claim.

## Output

### Intent
> One paragraph

### Reviewers
- Label: model, finding count

### Act On
Confirmed blockers

### Consider
Real tradeoffs

### Noted
Low-priority observations

### Dismissed
Rejected claims and why

### Agreement Map
Where independent evidence converged or diverged
