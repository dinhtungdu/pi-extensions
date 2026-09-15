# Orchestrate

Use the existing task manager when the active project has one. Do not create a second ledger, scheduler, inbox, or recovery protocol.

1. Read the active task snapshot, repository policy, and Manager instructions.
2. Split work into the fewest independently verifiable units. Serialize overlapping edits and dependent units.
3. Use registered Manager actions only through `manager`; use `subagent` only for unregistered bounded execution or independent read-only judgment.
4. Give each child a self-contained brief and isolated write surface. Children never mutate Manager state.
5. Drain terminal results, inspect actual artifacts, rerun decisive checks, and record canonical outcomes once.
6. Keep lifecycle and publication actions with the user/retained parent.

If no task manager is active, use a short in-chat checklist. Do not build orchestration infrastructure for one task.
