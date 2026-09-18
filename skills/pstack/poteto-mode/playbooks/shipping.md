# Shipping

Shipping changes external state. Exact authority is required for commits, pushes, pull requests, merges, releases, deploys, and cleanup.

1. Inspect the branch, base, worktree, intended commits, full diff, and required repository policy.
2. Run lint, tests, and live verification. Use one independent `complex` review only when the change is risky or the user requests it.
3. Prepare a concise title and description with intent, key changes, checks, and limits. Use `/skill:technical-writing` when installed.
4. Without publication authority, return the prepared branch, commit plan, title, body, and evidence. Stop.
5. With explicit authority, the parent performs each external action and verifies its URL, SHA, state, and result before the next action.
6. Re-read remote state immediately before merges or releases. Authority for one action never implies another.

Children may inspect or prepare text. They do not publish or mutate external state.
