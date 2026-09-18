# Feature

1. Define the user-visible outcome, non-goals, affected boundary, and proof.
2. Read the current flow and callers. Use `/skill:how` only when the mechanism remains unclear.
3. Reuse existing helpers and native platform behavior. Use the smallest domain shape that supports the outcome.
4. Work directly when local. For a substantial but well-specified change, delegate one end-to-end `bounded` writer with exact checks. Use `complex` for cross-boundary ambiguity.
5. Use the prototype playbook when the experience is open and `/skill:architect` for a hard-to-reverse public boundary.
6. Inspect the diff, run lint and focused tests, then exercise the real user path with the project's verification skill when present.

Return changed paths, checks, live evidence, and limits. Publication remains parent-only.
