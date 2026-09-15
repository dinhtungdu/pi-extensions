# Investigation

Investigation is read-only. Use `/skill:how` for current behavior and `/skill:why` for motivation/history. For independent slices, use one parallel `subagent` call with `readonly: true` on every task and verify the returned claims.

Return either the How structure (overview, concepts, flow, locations, gotchas) or a recommendation with alternatives and tradeoffs. Cite source paths and external identifiers. Report missing evidence instead of guessing.

Do not edit, open a PR, or launch a long watcher. If the answer leads to a code change, hand it to the matching feature, bug-fix, refactoring, or performance playbook.
