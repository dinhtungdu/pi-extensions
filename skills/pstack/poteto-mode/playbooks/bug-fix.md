# Bug fix

1. Reproduce the symptom with the smallest realistic case. Keep one regression check when it is cheap and behavior-focused.
2. Trace every caller of the likely boundary and form competing mechanisms. Do not patch the report's surface blindly.
3. Confirm the root mechanism with runtime or source evidence.
4. Fix directly when local. Otherwise delegate one end-to-end `complex` worker for diagnosis, implementation, and verification. Use `bounded` only when the cause is already proved.
5. Rerun the reproduction, sibling paths, and nearby regressions. Remove temporary instrumentation.
6. Exercise the real surface when available and report any path not covered.

A passing test without a demonstrated pre-fix failure is weak evidence.
