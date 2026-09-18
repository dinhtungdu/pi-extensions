---
name: interrogate
description: "Run an independent adversarial review of a risky diff or design, then have the parent verify and judge the findings."
disable-model-invocation: true
---

# Interrogate

Deliver a synthesized verdict. Do not auto-apply changes.

1. Identify exact intent, diff or files, and review base. Read enough context to state what the change must accomplish.
2. Call one read-only `complex` reviewer with [the reviewer prompt](references/reviewer-prompt.md), [rubric](references/rubric.md), and [code-quality lens](references/code-quality-review.md).
3. Add one `critical` reviewer only for security, data-loss, concurrency, irreversible boundaries, or a material unresolved disagreement. Do not multiply identical reviews to manufacture confidence.
4. The parent traces every material claim against source and applies [lead judgment](references/lead-judgment.md). Reviewers provide evidence, not verdicts.

Return confirmed blockers, legitimate tradeoffs, low-priority observations, dismissed claims with reasons, and the verification evidence. Prefer no findings over padded nits.
