# Hillclimb

1. Build a representative deterministic-enough case that reproduces the complaint. If it cannot reproduce, fix the evaluation first.
2. Choose one metric, improvement direction, correctness floor, minimum attempts, and stop predicate.
3. Capture a baseline. Change one hypothesis at a time so the evidence remains attributable.
4. Delegate each bounded iteration with `agent: "poteto-agent"` and `role: "hillclimb"`. Parallel hypotheses require isolated paths and identical evaluation conditions.
5. Keep an append-only decision trail with `/skill:show-me-your-work` for long runs. Revert regressions instead of rationalizing them.
6. Stop at the predicate, exhausted credible hypotheses, or a real user decision. Verify the winning result against held-out or real-world cases.

Return the baseline, iteration table, winning change, checks, variance, and ceiling.
