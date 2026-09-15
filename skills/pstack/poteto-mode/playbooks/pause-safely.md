# Pause safely

Pause only on explicit user direction or a real stop condition.

1. Finish the current atomic step or revert it. Cancel active child processes. Do not leave a knowingly broken partial edit.
2. Inspect and report worktree, jobs, checks, and external state. Take no push, PR, merge, cleanup, or lifecycle action merely to pause.
3. Commit only when the active task grants commit authority and repository policy allows a checkpoint. Otherwise leave exact changed paths and diff state.
4. Write a compact resume note when context may be lost: intent, decisions, verified work, current state, next action, key paths, and gotchas. Use an existing Manager context update when active; otherwise a user-requested file or `/tmp/<slug>-resume.md`.

Return what is durable, whether the tree is clean, active jobs, and the first action on resume.
