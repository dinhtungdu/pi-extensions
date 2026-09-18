# Investigation and forensics

Investigation is read-only unless the user separately asks for a fix.

1. Pin the question, source, time window, and evidence needed to distinguish hypotheses.
2. Search directly for a narrow question. For independent code or evidence slices, use at most two read-only `bounded` or `complex` children.
3. For a fixed large trace, profile, heap snapshot, log, or transcript, use one `mechanical` reducer only when the parser and output contract are explicit. Keep artifact paths, not raw payloads, in parent context.
4. Resolve runtime evidence to source files and symbols. Compare with a baseline when available.
5. Confirm the mechanism with non-destructive observation or narrow instrumentation. Missing symbols, integrations, or provenance are explicit gaps.

Return the question, evidence, strongest supported mechanism, source locations, confidence, artifacts, and next check. Hand confirmed causes to bug-fix or performance.
