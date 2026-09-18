---
name: how
description: "Trace how a symbol, module, or subsystem works and return a sourced mental model. Use for code walkthroughs, ownership, runtime flow, or architecture critique."
disable-model-invocation: true
---

# How

1. Pin the question and likely boundary. Read the entry point, callers, core types, and effects directly for a narrow symbol or module.
2. For a broad subsystem with genuinely independent slices, call at most two read-only `bounded` children using [the explorer prompt](references/explorer-prompt.md). Give each a distinct angle and exact paths.
3. The parent reconciles their findings against code. Do not launch a separate explainer or synthesizer.
4. If historical motivation matters, use `/skill:why`. Current code can prove mechanics, not intent.

Return:

- **Overview:** owned boundary and purpose
- **Key concepts:** only types and services needed for the model
- **Flow:** trigger, decisions, data, and effects with file references
- **Locations:** a small path map
- **Gotchas and gaps:** non-obvious behavior and anything not traced
