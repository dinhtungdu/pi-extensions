---
name: no-comments
description: "Read-only review for misleading, redundant, stale, or missing why-focused code comments. Use when asked to review comments, remove narration, check comment quality, or run no-comments."
disable-model-invocation: true
---

# No Comments

Determine the diff or file scope, then call `subagent` once with:

- `agent`: `comment-sicko`
- a self-contained task naming the exact scope and review base
- no write permission

Read the result and verify each material finding against the code. Return only confirmed findings as `path:line — remove | rewrite | add — reason`. Do not auto-edit; the user asked for review. If nothing material survives verification, return `PASS: no material comment issues`.
