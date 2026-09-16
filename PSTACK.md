# Pstack Pi port

This is the discoverable provenance and maintenance record for the pstack resources under `skills/pstack/` and their Pi adapter at `extensions/pstack/index.ts`.

## Provenance

| Source | Pinned revision | Snapshot |
|---|---|---|
| Primary upstream, `cursor/plugins` `pstack/` | `c1c0a32802223f4be824112dd83d33ad29a8b26c` | 47 skill directories |
| Pi reference, `kkgogogo17/pi-pstack` | `14da130e7aac196d355fa70706b06d5b4d71e095` | 44 skill directories |

The current upstream is the content baseline. The reference informed native Pi integration only; it is older and was not copied wholesale.

At the pinned revisions, upstream has three skills absent from the reference: `make-bot-ui`, `principle-attack-the-premise`, and `principle-test-behavior-not-implementation`. Across all files, upstream has 35 paths absent from the reference, the reference has 7 paths absent from upstream, 95 common paths differ, and 28 common paths are byte-identical.

Upstream is MIT licensed, Copyright © 2026 Lauren Tan. Its exact notice is retained at `licenses/pstack-MIT.txt`.

## Local integration

- `package.json` discovers all 47 adapted skill directories through `skills/pstack/`.
- `extensions/pstack/index.ts` owns sticky `/poteto-mode`, `/setup-pstack`, model-role configuration, current-workspace session listing, and bounded background child Pi execution. Child startup is offline; read-only tasks receive only read/grep/find/ls tools. `pstack_tasks` exposes session-local inspection and cancellation, while a compact widget and completion message provide visibility.
- `agents/pstack/` contains the two bundled child prompts.
- `skills/pstack/poteto-mode/references/pi-port.md` is the runtime authority/capability contract applied to imported workflows.
- Existing theme, Codemode, goal, Codex, Discord, tool-visibility, voice, Git, browser, and Manager behavior remains owned by existing project machinery.

Deliberate omissions: the upstream plugin manifest, guide/assets, Benny automation pack, and `poteto-mode/scripts/` orchestration/PR-watch/worktree-delete machinery. The reference's duplicate todo state is omitted because this package already has `/goal` and Manager owns tracked task state. The child runner supports only bundled agents and bounded single/parallel batches in the parent cwd; unused chain mode, arbitrary child cwd, persistence/resume, and project/user agent overrides are omitted. The product-specific `make-bot-ui` skill reports its capability unavailable instead of faking it. No update daemon, patch framework, automatic publication, or global installation is included.

## Weekly agent maintenance

Manager owns the weekly cron notification and routes the agent: reuse active task ownership when appropriate, otherwise create a new bounded update task. The assigned agent must use that task's current checkout only. Never resurrect an archived lease/session, overlap another writer, modify crontab/Manager, or push/create a PR/merge/install globally.

1. Read the active task snapshot and repository policy. Confirm the checkout and branch have no unrelated work.
2. Compare only the primary upstream `pstack/` subtree from the pinned revision to its new head. Separately inspect reference changes for useful Pi adaptation ideas:

   ```sh
   tmp="$(mktemp -d)"
   git clone --filter=blob:none https://github.com/cursor/plugins.git "$tmp/cursor-plugins"
   git -C "$tmp/cursor-plugins" diff --stat c1c0a32802223f4be824112dd83d33ad29a8b26c..origin/main -- pstack
   git -C "$tmp/cursor-plugins" diff c1c0a32802223f4be824112dd83d33ad29a8b26c..origin/main -- pstack

   git clone --filter=blob:none https://github.com/kkgogogo17/pi-pstack.git "$tmp/pi-pstack"
   git -C "$tmp/pi-pstack" diff --stat 14da130e7aac196d355fa70706b06d5b4d71e095..origin/main -- agents extensions skills README.md package.json
   git -C "$tmp/pi-pstack" diff 14da130e7aac196d355fa70706b06d5b4d71e095..origin/main -- agents extensions skills README.md package.json
   ```

3. Review semantic changes. Manually adapt useful upstream behavior to Pi. Preserve local command names, session state, model registry use, child isolation, Manager/publication authority, and existing package integrations. Do not bulk-overwrite adapted files.
4. Update both pinned revisions and drift notes in this file, plus the source revisions in `skills/pstack/poteto-mode/references/pi-port.md`. Retain the upstream license unchanged.
5. Run checks:

   ```sh
   npm run check
   npm run lint
   npm run test:pstack
   npm run test:codex-fast
   npm run test:discord
   npm run test:tool-visibility
   npm pack --dry-run
   ```

   `test:pstack` checks all 47 skill resources, recursive package filtering, internal Markdown links, unsupported vocabulary, license hash, multiline sticky state, concurrent configuration, delegated preflight/success/failure/cancellation/policy isolation, offline startup, and a fresh Pi load/command smoke.

6. Inspect `git diff --check`, the full diff, and `git status --short`. Commit intended files only:

   ```sh
   git add PSTACK.md package.json extensions/pstack agents/pstack skills/pstack licenses/pstack-MIT.txt scripts/test-pstack.mjs
   git commit -m "feat: update pstack port"
   ```

7. Record the new commit and check results through the active Manager task. Stop without push, PR creation, merge, task lifecycle change, or global activation.
