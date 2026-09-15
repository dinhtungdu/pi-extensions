# Feature

1. Read the request, repository policy, affected flow, and every caller of the boundary being changed. Define observable acceptance and non-goals.
2. Use `/skill:how` for unfamiliar runtime flow and `/skill:why` only when history changes the design. Use `/skill:architect` for a real cross-boundary choice.
3. Choose the smallest domain shape that makes invalid states difficult. Reuse existing helpers and native platform features before adding abstractions or dependencies.
4. Delegate one bounded writer with `agent: "poteto-agent"` and `role: "feature, refactoring"`, naming exact files, behavior, authority, and checks. Use `/skill:arena` only when multiple valid shapes materially differ.
5. Inspect the diff and every affected caller. Run lint plus the smallest behavior check that fails without the feature. Exercise the real surface when the feature is user-facing.
6. Correct failures and review findings. Keep unrelated cleanup out.

Return changed paths, acceptance evidence, checks, and limits. Publication remains parent-only.
