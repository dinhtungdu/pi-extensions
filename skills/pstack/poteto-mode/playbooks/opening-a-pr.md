# Opening a pull request

Read the repository's Git skill before any Git or forge operation. Exact user/task authority is required for push and pull-request creation; implementation authority alone is not publication authority.

1. Inspect branch, base, worktree cleanliness, and the full diff.
2. Run required tests and lint. Use `/skill:interrogate` and `/skill:no-comments` when proportionate. Resolve confirmed blockers.
3. Keep unrelated changes out. Commit only intended files under the repository's commit policy.
4. Write a concise title and description: intent, key change, checks, and known limits. Use `/skill:technical-writing`, then `/skill:unslop`.
5. If publication authority is absent, return the prepared branch, commit, title, body, and checks to the parent. Stop there.
6. If authority is explicit, the retained parent pushes and creates the ready PR with the repository's selected forge. Verify the resulting URL, base, head SHA, and non-draft state.

Children may review or prepare text. They never push or mutate the PR. Do not merge, enable auto-merge, or post comments unless separately authorized.
