# Pstack Pi port

This repository carries a curated Pi adaptation of pstack. It keeps the workflows that improve engineering quality without assuming unlimited cloud agents, provider-internal infrastructure, or a large model fleet.

## Provenance

| Source | Pinned revision |
|---|---|
| Primary upstream, `cursor/plugins` `pstack/` | `c1c0a32802223f4be824112dd83d33ad29a8b26c` |
| Pi reference, `kkgogogo17/pi-pstack` | `14da130e7aac196d355fa70706b06d5b4d71e095` |

Upstream is MIT licensed, Copyright © 2026 Lauren Tan. Its notice remains at `licenses/pstack-MIT.txt`.

## Curated product

The package ships 14 skills and eight Poteto Mode playbooks. The retained core is:

- project-specific verification CLIs and feature maps
- current-code, historical, and session grounding
- empirical prototypes and architecture sketches
- proportionate independent review
- selective swarms for real coverage or measured samples
- concise teaching, technical writing, reflection, automation discovery, and `/bro`

Fine-grained principle skills are consolidated into `skills/pstack/poteto-mode/references/engineering-standard.md`. Overlapping agent lifecycle, planning, forensics, visual, evaluation, and shipping playbooks are consolidated under eight routes. Product-specific bot UI, duplicate orchestration, generic language/style packs, and provider-scale cloud automation are omitted.

## Model routing

`extensions/pstack/index.ts` routes delegated work by workload instead of 17 workflow-specific roles:

| Route | OpenAI default | Thinking | Intended work |
|---|---|---|---|
| `mechanical` | `openai-codex/gpt-5.6-luna` | medium | fixed extraction, inventory, repeated verification |
| `bounded` | `openai-codex/gpt-5.6-terra` | high | well-specified engineering and exploration |
| `complex` | `openai-codex/gpt-5.6-sol` | high | ambiguous diagnosis, architecture, synthesis |
| `critical` | `openai-codex/gpt-6-astra` | high | consequential boundaries and escalation |

The defaults fall back to the active parent model when unavailable. `/setup-pstack` and `pstack_config` can map any route to any available provider/model or `inherit-parent`. A task-level `model` or `thinking` value overrides the saved route.

The extension also owns sticky `/poteto-mode`, current-workspace session listing, bounded background child execution, cancellation, compact progress UI, and child usage reports. Children start offline without extensions, skills, prompt templates, sessions, or Manager environment variables.

## Maintenance

Upstream is reference material, not a file-count target. Weekly maintenance should compare semantic changes and import only improvements that fit the curated product.

1. Inspect the active task, repository policy, checkout, and unrelated work.
2. Compare upstream from the pinned revision:

   ```sh
   tmp="$(mktemp -d)"
   git clone --filter=blob:none https://github.com/cursor/plugins.git "$tmp/cursor-plugins"
   git -C "$tmp/cursor-plugins" diff c1c0a32802223f4be824112dd83d33ad29a8b26c..origin/main -- pstack
   ```

3. Preserve Pi-native routing, child isolation, authority boundaries, and the curated skill/playbook set. Do not bulk-copy upstream.
4. Update source pins here and in `skills/pstack/poteto-mode/references/pi-port.md` when adopting upstream changes.
5. Run:

   ```sh
   npm run check
   npm run lint
   npm run test:pstack
   npm run test:codex-fast
   npm run test:discord
   npm run test:tool-visibility
   npm pack --dry-run
   git diff --check
   ```

6. Inspect the full diff and status. Commit intended files only. Do not push, create a pull request, merge, publish, or alter Manager state without explicit authority.
