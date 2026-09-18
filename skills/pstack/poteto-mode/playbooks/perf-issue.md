# Performance

1. Reproduce the real slow path and capture a baseline trace or profile. Record workload, environment, and variance.
2. Find where time or allocation is actually spent. Do not optimize from source shape alone.
3. Define one target metric and correctness guardrails.
4. Use one `complex` worker when diagnosis and implementation form one loop. Use `mechanical` workers only for repeated runs with an exact recipe and isolated data.
5. Change one mechanism at a time. Capture the post-change result under the same conditions and compare distributions.
6. Run correctness checks and exercise the real surface. Retain calibration controls when hardware or workloads vary.

No measured improvement means no performance fix.
