# Worktree cleanup

Cleanup is destructive. Inspect first; delete only with exact authority.

1. Read the repository's Git skill.
2. List registered worktrees, branches, running processes, dirty files, unpushed commits, and linked task/PR state.
3. Classify each candidate: safe, retained, or blocked. A merged PR does not prove a dirty worktree is disposable.
4. Without cleanup authority, return the inventory and recommended commands. Stop.
5. With authority, remove one confirmed-safe target at a time using native Git commands, never manual directory deletion. Re-list state after each removal.

Never touch another task checkout, active process, uncommitted work, canonical Manager state, simulators, caches, or credentials unless they were explicitly included.
