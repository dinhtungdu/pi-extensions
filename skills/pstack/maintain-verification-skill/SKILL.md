---
name: maintain-verification-skill
description: "Keep a project's verification CLI and feature map aligned with recent product changes and confirmed live behavior."
disable-model-invocation: true
---

# Maintain verification skill

1. Locate the project verification skill, usually `.pi/skills/verify-*/`. If none exists, use `/skill:create-verification-skill`.
2. Inspect product changes since the last maintenance point and map them to affected feature entries. Do not rescan every feature by default.
3. Reconcile the feature index, linked pages, CLI help, selectors, commands, and expected evidence. For a large map, use one read-only `bounded` child on explicitly affected sections.
4. Run the skill's doctor command, then drive affected features serially against the real app. Preserve screenshots, terminal output, responses, logs, or state changes that prove behavior.
5. Fix confirmed documentation or harness drift inside the verification skill. Rerun every changed recipe. Report product failures separately.
6. Run a full feature sweep only when explicitly requested, after a major product rewrite, or when repeated drift shows incremental maintenance is insufficient.

Return changed paths, recent changes covered, live evidence, product failures, and untested surfaces.
