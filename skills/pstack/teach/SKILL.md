---
name: teach
description: "Explain a change or subsystem plainly so the reader understands what it is, how it works, and why it exists. Use for teach me this, help me understand X, or explain this change."
disable-model-invocation: true
---

# Teach

Orient in the code, then follow `/skill:how` for mechanism and `/skill:why` for rationale. For a broad subsystem, run their investigations in parallel through `subagent` with `readonly: true`; for a narrow question, use only the evidence path needed. Preserve `why` confidence and gaps.

Decide the few concepts the reader needs from their question and current context. Do not quiz them or repeat what they plainly know.

Lead with a one- or two-sentence definition tied to this codebase. Then explain the user-visible flow, internal mechanism, design reasons, and relevant edge cases. Cite files and sources without turning the answer into an inventory.

Use a small diagram when three or more moving parts are easier to see than describe. Build complex diagrams incrementally. Use only visualization tools actually available; plain Mermaid or ASCII is enough.

Write through `/skill:unslop`. Normal sentence case. Short concrete sentences. No lecture framing, pacing theater, fake certainty, or report about the teaching process.

Return the explanation itself. Stop after the smallest complete layer; go deeper when the user asks.
