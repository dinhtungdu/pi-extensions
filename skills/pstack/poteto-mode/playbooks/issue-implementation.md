# Issue implementation

The driver supplies task context, the issue, and the path to the project's verification skill. Treat all as required inputs. Task context includes objective, constraints, acceptance, current evidence, and current stage; when a Manager task provides a canonical `Stages` ledger, use it as context, not an execution workflow or lifecycle state machine. Read each supporting skill file only when its stage begins; do not front-load them.

## 1. Ground + verification preflight

Read [How](../../how/SKILL.md) directly to ground current mechanics. Trace the affected entry point, callers, data, effects, constraints, and user-visible acceptance criteria. When prior work is relevant, read [Recall](../../recall/SKILL.md) directly. When historical intent affects the decision, read [Why](../../why/SKILL.md) directly.

Read the driver-supplied project verification skill directly. Confirm that it provides the affected surface's launch, drive, evidence-capture, and teardown recipe. If the path, file, recipe, environment, tool, access, credential, or affected surface is unavailable, name that exact gap and the behavior and evidence it blocks. Tests are not a substitute for this preflight.

## 2. Reproduce

Before editing, use the project verification skill to exercise the smallest realistic user path and preserve live before evidence. For a bug, demonstrate the failure; for missing behavior, capture the current result that must change. Also add or identify the smallest focused automated check when practical. If there is no runnable surface, state why. If the surface exists but cannot be driven, carry the exact preflight gap forward rather than claiming reproduction.

## 3. Design

Design directly by default. Turn the observed behavior and traced flow into the smallest empirical design: affected boundary and callers, expected observable delta, implementation units, focused checks, and live verification recipe. Read [Architect](../../architect/SKILL.md) directly only when the boundary is consequential or hard to reverse, or when materially competing boundaries require comparison.

## 4. Execute closed loop

For each coherent unit: implement the smallest change, run the cheapest relevant static or focused automated check, drive the affected live recipe, inspect the result, and adjust from evidence. Keep one writer and preserve unrelated code. Finish runnable behavior with live after evidence from the same path and conditions as the before evidence. Passing tests alone is insufficient.

## 5. Review and finish

Always inspect and review the generated code directly in its full diff and caller context against the issue, design, checks, and before/after evidence. Keep routine post-change review in the parent. Read [Interrogate](../../interrogate/SKILL.md) only when the user explicitly requests independent review, or when concrete security, data-loss, concurrency, irreversible-boundary risk, or unresolved evidence-based disagreement requires independent judgment. Verify every material finding, fix confirmed findings, then rerun affected checks and the live recipe after the final edit.

Return changed paths, exact checks, live before/after evidence, review disposition, and remaining gaps. Never report runnable behavior as verified without live after evidence; report the exact blocked prerequisite instead.
