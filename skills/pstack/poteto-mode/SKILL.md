---
name: poteto-mode
description: "Run evidence-driven software work with proportionate delegation, empirical design, and live verification. Use for /poteto-mode, autonomous engineering, or multi-phase execution."
disable-model-invocation: true
---

# Poteto Mode

Read [the Pi port contract](references/pi-port.md) first. The parent owns decisions, external side effects, final review, and user communication.

## Core loop

1. **Frame.** State the user-visible outcome, constraints, non-goals, and smallest proof.
2. **Ground.** Read the affected flow. Use `/skill:how`, `/skill:why`, or `/skill:recall` only when current code, history, or prior work is genuinely missing.
3. **Choose one execution shape.**
   - Work directly for a small local change.
   - Delegate one end-to-end worker when isolation protects context or the task is long enough to justify another process. Do not make the parent and child repeat the same investigation.
   - Run two candidates only when competing designs or prototypes could materially differ.
   - Use `/skill:swarm` only for independent coverage, a measured sample, or genuinely disjoint work.
4. **Build.** Reuse existing code and native features. Keep the change small and coherent.
5. **Verify.** Use the project's verification skill when present. Exercise the real behavior, not only compilation or unit tests.
6. **Judge.** Inspect the artifact and decisive evidence. Use `/skill:interrogate` only for risky changes or explicit review requests.
7. **Report.** Return changed paths, checks, live evidence, and remaining gaps.

## Workload routes

`subagent` uses four configurable workload routes. An explicit task `model` or `thinking` overrides the saved route.

- **mechanical:** fixed extraction, inventory, structured reduction, or repeated verification with an exact recipe.
- **bounded:** well-specified implementation, refactoring, exploration, tests, prototypes, or routine review.
- **complex:** ambiguous debugging, performance diagnosis, architecture, synthesis, or cross-boundary implementation.
- **critical:** security, data-loss, concurrency, irreversible public boundaries, multi-system work, or escalation after complex work fails with new evidence.

Escalate instead of retrying weak work indefinitely: mechanical failure goes to bounded; exposed ambiguity goes to complex; consequential disagreement or repeated complex failure goes to critical. Never use critical as a broad swarm default.

## Delegation rules

- Every brief names the goal, exact scope, route, authority, verification, and required evidence.
- Only one writer touches a checkout. Parallel writers need separate worktrees or disjoint scratch paths.
- Read-only children may share a checkout. Set `readonly: true`.
- Children return evidence. The parent verifies material claims and never treats agent agreement as proof.
- Prefer one strong child over a chain of explorer, explainer, synthesizer, and judge agents.

Follow [the engineering standard](references/engineering-standard.md). Load one matching playbook, not all of them:

- [Feature](playbooks/feature.md)
- [Bug fix](playbooks/bug-fix.md)
- [Refactoring](playbooks/refactoring.md)
- [Performance](playbooks/perf-issue.md)
- [Investigation and forensics](playbooks/investigation.md)
- [Prototype, visual comparison, and evaluation](playbooks/prototype.md)
- [Multi-phase work](playbooks/multi-phase-plan.md)
- [Shipping](playbooks/shipping.md)
