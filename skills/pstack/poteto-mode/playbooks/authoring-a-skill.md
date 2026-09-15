# Authoring a skill

Read Pi's installed Agent Skills documentation completely before changing a skill. Follow linked authoring/validation guidance.

1. Confirm a skill is needed; prefer an existing skill, native capability, or small documentation correction.
2. Define concrete trigger phrases and one bounded job.
3. Use lowercase hyphenated `name`, a precise third-person `description`, and the smallest workflow that works.
4. Put detail in linked references only when progressive disclosure helps. Keep all links relative and resolvable.
5. Convert sibling skill invocations to `/skill:<name>`.
6. Test discovery, frontmatter, links, and representative trigger/negative-trigger cases. Run any available validator.
7. Install project-local work under `.pi/skills/` or package-owned skill paths; use `~/.pi/agent/skills/` only when the user explicitly wants a personal global skill.

Never auto-install a transcript-derived skill. `/skill:reflect` and `/skill:automate-me` require user approval first.
