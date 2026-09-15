# Bug fix

1. Reproduce the symptom with the smallest realistic case. Preserve it as a regression check when non-trivial.
2. Read every caller of the function or boundary likely involved. Use `/skill:how` for flow and `/skill:why` for regression history. Form competing hypotheses and eliminate them with runtime evidence; do not patch the report's surface blindly.
3. Confirm one root mechanism. Use `/skill:architect` only if the fix crosses a meaningful boundary.
4. Delegate a bounded writer with `agent: "poteto-agent"` and `role: "bug-fix"`. Name exact scope, reproduction, invariant, and checks.
5. Inspect the diff, rerun the reproduction and nearby regressions, and remove temporary instrumentation.
6. Verify sibling callers route through the shared fix. Report any path not covered.

A passing test without a demonstrated pre-fix failure is weak evidence. Publication remains parent-only.
