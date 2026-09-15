---
name: maintain-verification-skill
description: "Keep a project's verification skill and feature map honest through parallel source review and one serial live pass. Use for /skill:maintain-verification-skill or audit the verification skill."
disable-model-invocation: true
---

# Maintain a Verification Skill

Edit only the verification skill directory. Product regressions are reported, never hidden by documentation changes.

1. Locate the project-local verification skill, usually `.pi/skills/verify-*/`. Ask only when several candidates exist; if none, use `/skill:create-verification-skill`.
2. Reconcile the feature index with sibling files.
3. Call one parallel `subagent` with a `poteto-agent` task per feature and `readonly: true`. Each task cites source behavior, likely documentation drift, and one live recipe. Use isolated child context; children do not drive the shared app or edit.
4. Verify material source claims. Sweep recent user-facing changes for concrete missing features.
5. Follow the skill's own launch, doctor, drive, evidence, and cleanup instructions serially. Exercise every mapped feature. Preserve evidence across cleanup and clean only processes/state this run created.
6. Fix confirmed documentation, map, or harness drift inside the skill directory. Re-drive every harness fix. Report product failures separately.
7. Run frontmatter/link/resource checks and one final live proof.

Outcome is `clean`, `changed`, or `blocked`, with per-feature source/live evidence. Prepare a commit or PR description only when requested. Push and PR creation remain parent-only and require exact authority.
