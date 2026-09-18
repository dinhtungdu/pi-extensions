---
name: automate-me
description: "Mine recent Pi sessions for repeated manual work worth deleting, documenting, or automating. Proposes first and never auto-installs automation."
disable-model-invocation: true
---

# Automate Me

1. Scope the workspace and time window. Default to seven days.
2. Use `$PI_SESSION_FILE` and `pstack_sessions`; never scan another project's sessions.
3. Read a small set directly. For many sessions, partition them across at most two read-only `mechanical` children with explicit paths.
4. Count concrete repeated sequences, corrections, and handoffs. Reject one-offs and work already covered by a native command, installed skill, extension, or script.
5. Rank candidates by frequency times time or error cost. Prefer deletion, documentation, or a tiny existing-skill edit before new automation.
6. Present proposals and wait for explicit selection. Do not create or install anything automatically.

Return evidence counts and paths, trigger, minimum workflow, existing alternatives, expected benefit, and why automation is justified.
