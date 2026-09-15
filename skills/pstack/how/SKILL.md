---
name: how
description: "Use for how does X work, code walkthroughs before changing something, ownership and layering questions, runtime flow, or architecture critique. Produces a sourced mental model; use why for historical motivation."
disable-model-invocation: true
---

# How

## Explain

1. Parse the question and state a best-guess scope. Do not ask unless product ambiguity blocks a truthful answer.
2. For one module or narrow symbol, call one `subagent` using `agent: "poteto-agent"`, `role: "how explainer"`, and `readonly: true`, and [the explainer prompt](references/explainer-prompt.md).
3. For a cross-file subsystem, split it into 2-4 distinct angles and call one parallel `subagent` with `role: "how explorer"` and `readonly: true` on every task and [the explorer prompt](references/explorer-prompt.md). Then call one explainer with the terminal findings and exact source paths.
4. Verify the explanation's decisive claims against code. Parent edits for clarity but never invents missing links.

Explorers start broad, follow actual callers and callees, trace input to effect, read definitions, and cite files and symbols. Keep them read-only.

## Critique

Explain first. Then run `/skill:interrogate` on the architecture with the stated goals and relevant files. Categorize confirmed issues as act on, consider, noted, or dismissed. Do not critique architecture you have not traced.

## Output

- **Overview:** what it is and the boundary it owns
- **Key concepts:** only the types/services needed for the model
- **How it works:** trigger, flow, decisions, data, and effects with file references
- **Where it lives:** small path map
- **Gotchas:** non-obvious behavior supported by source
