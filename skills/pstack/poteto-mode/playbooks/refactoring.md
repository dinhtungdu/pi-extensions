# Refactoring

1. State the behavior that must remain unchanged and pin it with an existing integration test or one small characterization check.
2. Read every caller, string reference, config key, and documentation back-reference affected by the move or rename.
3. Choose the smallest target shape. No compatibility shim or parallel old/new API unless explicitly required.
4. Delegate one mechanical writer with `agent: "poteto-agent"` and `role: "feature, refactoring"`, exact paths, rename map, and behavior pin.
5. Move in small steps that keep the pin green. Migrate all callers, then delete the old API in the same wave.
6. Inspect the full diff, search for stale names, run lint and relevant tests, and report anything intentionally left.

Do not smuggle behavior changes into a refactor.
