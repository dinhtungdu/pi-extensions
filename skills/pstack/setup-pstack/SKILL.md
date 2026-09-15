---
name: setup-pstack
description: "Configure Pi provider/model mappings for pstack workflow roles. Use when the user asks to set up pstack, change delegated models, inspect role mappings, or fix an unresolved model selector. Prefer the native /setup-pstack command."
---

# Set Up Pstack

Pi model identifiers are runtime-specific. Never copy fixed upstream slugs or guess an installed model.

## Interactive setup

Run `/setup-pstack`. Pick one role, then one model from Pi's live registry. Repeat only for roles the user wants to customize. Every untouched role inherits the parent model.

- `/setup-pstack status` shows the current mapping.
- `/setup-pstack reset` restores every role to `inherit-parent`.

## Tool setup

Use `pstack_config` when configuring from an agent turn:

1. Call with `action: "list-models"`.
2. Call with `action: "set"`, an exact listed role, and either one listed `model` or a `models` pool.
3. Call with `action: "get"` to verify the saved result.

Configuration lives at `~/.pi/agent/pstack/models.json`, mode `0600`. Roles are:

- `feature, refactoring`
- `bug-fix`
- `perf-issue`
- `hillclimb`
- `judgment and prose`
- `hardest tasks`
- `how explorer`
- `how explainer`
- `why investigators`
- `why synthesizer`
- `reflect tooling`
- `reflect judgment, divergent, synthesizer`
- `arena runners`
- `arena cross-judge pool`
- `swarm workers`
- `architect runners`
- `interrogate reviewers`

Use a model pool only for workflows that explicitly fan out across that role. `inherit-parent` pins the parent's current model; `auto` omits the child model override and lets Pi choose its configured default.
