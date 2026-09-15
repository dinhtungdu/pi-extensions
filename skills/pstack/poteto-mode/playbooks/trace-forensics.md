# Trace forensics

Analyze an existing fixed artifact; do not recapture or edit code.

1. Identify format, provenance, capture conditions, and the appropriate available parser.
2. Delegate large-artifact reduction to one read-only `poteto-agent` when it protects parent context. Do not build a database unless ordinary parser queries cannot answer the question.
3. Find the dominant samples/call path, retainer chain, blocked thread, or event sequence relevant to the report.
4. Resolve symbols to source file, function, and line. If the artifact lacks symbols, report that gap.
5. Compare with a paired baseline when available. Without one, label the result as the strongest supported hypothesis rather than a confirmed regression.

Return artifact, format, reduced evidence, source attribution, and confidence. Route confirmed causes to bug-fix or performance issue.
