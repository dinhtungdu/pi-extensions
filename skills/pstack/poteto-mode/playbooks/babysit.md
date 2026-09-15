# Babysit

Monitor one already-authorized external process or pull request without changing it.

1. Pin the object and immutable identifier: PR head SHA, job ID, deployment revision, or equivalent.
2. Define terminal success and failure states before watching.
3. Use native bounded job monitoring or read-only forge/API polling. Avoid busy loops and do not use an unbounded child agent.
4. On each event, re-read authoritative state. Notification text is only a wake-up signal.
5. Stop on terminal state, changed identity, revoked credentials, or a decision requiring new authority.

Do not push, rerun, merge, approve, comment, deploy, or clean up. Return the final state, evidence, elapsed watch scope, and exact next action.
