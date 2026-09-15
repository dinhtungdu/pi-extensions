# Runtime forensics

Diagnose a live process with evidence; do not fix unless asked.

1. Use an authorized tool available for the matching surface to capture the real signal: CPU profile, heap snapshot, trace, logs, or thread dump.
2. For a large artifact, delegate read-only reduction to `poteto-agent`; keep only findings and artifact paths in the parent context.
3. Form a mechanism and confirm it with non-destructive observation or narrowly scoped instrumentation. Do not hot-patch production or a user's live session.
4. Map the finding to source file, symbol, and line. A hot frame without source mapping is not a complete diagnosis.
5. Return capture conditions, reduced finding, confirmation method, source location, artifacts, and uncertainty.

Hand confirmed causes to bug-fix or performance issue.
