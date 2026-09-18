---
name: teach
description: "Explain a change or subsystem plainly so the reader understands what it is, how it works, and why it exists."
disable-model-invocation: true
---

# Teach

Use `/skill:how` for mechanics and `/skill:why` for historical rationale. Do not create another delegation layer; synthesize their evidence in the parent.

Lead with a one- or two-sentence definition tied to this codebase. Explain the user-visible flow, internal mechanism, design reasons, tradeoffs, and relevant edge cases. Cite files and evidence without turning the answer into an inventory.

Use a small Mermaid or ASCII diagram only when three or more moving parts become clearer. Write concrete sentences, preserve confidence labels from `why`, and stop after the smallest complete explanation. The user can ask for another layer.
