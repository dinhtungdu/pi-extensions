# Performance issue

1. Reproduce the real slow path and capture a baseline trace or profile. Record workload, environment, and variance.
2. Identify where time or allocation is actually spent. Do not optimize from source shape alone.
3. Define one target metric and guardrails for correctness and secondary regressions. Use `/skill:architect` only for a cross-boundary redesign.
4. Delegate the bounded change with `agent: "poteto-agent"` and `role: "perf-issue"`.
5. Capture a post-fix trace under the same conditions. Compare distributions, not one lucky run.
6. Run correctness checks and report tradeoffs, measurement limits, and retained calibration knobs for real hardware.

No measured improvement means no performance fix.
