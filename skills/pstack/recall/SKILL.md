---
name: recall
description: "Reconstruct recent working context from Pi sessions, live repository state, and available shared evidence. Use for catch-up, resuming work, or finding where a task stopped."
disable-model-invocation: true
---

# Recall

Return a tight current-state brief, not a transcript dump.

1. Pin topic, workspace, and time window. Default to seven days. Use a supplied state capsule instead of mining again.
2. Use `$PI_SESSION_FILE` and `pstack_sessions`. Read one or two candidate sessions directly. For more, partition them across at most two read-only `mechanical` children with explicit paths.
3. Use `/skill:why` only when a named feature, bug, or subsystem needs shared historical evidence.
4. Verify surfaced branches, commits, pull requests, files, checks, and tickets against current read-only state. History is not current truth.
5. Keep decisions, artifacts, failed approaches, recurring symptoms, open work, and the next action. Sanitize private context before public output.

Return at most five capsule bullets, one line per active thread, at most five problems, and one highest-value next move.
