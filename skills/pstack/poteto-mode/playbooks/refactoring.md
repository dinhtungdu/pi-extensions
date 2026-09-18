# Refactoring

1. State the behavior that must remain unchanged and pin it with an existing integration check or one small characterization check.
2. Read callers, string references, configuration, and documentation affected by the move.
3. Choose the smallest target shape. Do not keep parallel old and new internal APIs unless compatibility is explicit.
4. Use one `bounded` writer for a long mechanical migration. Use `complex` only when ownership or boundaries must change.
5. Migrate callers and delete the old path in the same wave. Keep the behavior pin green.
6. Search for stale names, inspect the full diff, run lint and relevant tests, then verify the real behavior.

Do not hide behavior changes inside a refactor.
