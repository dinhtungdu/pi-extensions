# Engineering standard

- Start from the user-visible outcome. Restate an ambiguous report before changing code.
- Read the real flow and every caller of the boundary being changed. Use history only when motivation changes the decision.
- Reproduce bugs and performance problems before fixing them. Fix the shared cause, not one reported symptom.
- Choose data structures and public call sites before implementation detail. Validate external input at boundaries and trust internal types.
- Make illegal states difficult to represent. Do not lie to the type system.
- Delete dead paths and unnecessary compatibility before adding machinery. Prefer direct code over wrappers, factories, and speculative options.
- If work repeats, build a small rerunnable command, codemod, fixture, or verification recipe instead of repeating hand work.
- Give concurrent writers separate state. Make retryable operations converge after interruption.
- Break large work into units that leave the repository valid and end with one observable check.
- Test behavior through the interface users call. After tests pass, exercise the real artifact and inspect the actual side effect.
- Preserve accessibility, security controls, and error handling that prevents data loss. Simplicity never excuses removing them.
- Keep unrelated cleanup out. Report missing evidence instead of filling gaps with confidence.
