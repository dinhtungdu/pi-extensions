---
name: recall
description: "Reconstruct recent working context from Pi sessions, live repository state, and available shared evidence. Use for recall my work on X, catch me up, what have I been working on, where did I leave off, or before resuming work."
disable-model-invocation: true
---

# Recall

Return a tight current-state brief, not a transcript dump.

1. **Scope.** Pin topic, workspace, and time window (default seven days). Never widen "recent" to all history or cross workspaces silently. If the user already supplied a complete state capsule, use it and skip mining.
2. **Sessions.** Use `$PI_SESSION_FILE` for the active transcript. Call `pstack_sessions` for earlier sessions in this working directory. For one or two candidates, read directly. For more, call one parallel `subagent` with each `poteto-agent` assigned explicit returned session paths, `role: "judgment and prose"`, and `readonly: true`.
3. **Shared record.** When the topic names a feature, bug, file, or subsystem, use `/skill:why` to search available read-only source control, ticket, document, chat, observability, and error evidence. Report unavailable integrations as gaps. Skip this for pure activity recall with no named target.
4. **Live truth.** Verify surfaced branches, commits, pull requests, files, checks, and tickets with authorized read-only tools. History is not current state.
5. **Synthesize.** Keep only decisions, artifacts, failed approaches, recurring symptoms, open work, and the next concrete move. Cite Pi session files and shared-record identifiers.

## Output contract

- **Capsule:** at most five bullets
- **Threads:** one line each, prefixed with `[merged #N]`, `[open PR #N]`, `[in flight <branch>]`, `[verified, uncommitted]`, `[reverted #N]`, or `[planned, not started]`
- **Problems:** at most five recurring or blocking issues
- **Next move:** one concrete highest-value action

Keep adjacent threads out unless they block the named topic. Sanitize private context before public output and pass prose through `/skill:unslop`.
