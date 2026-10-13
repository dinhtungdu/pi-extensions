# OptChat session fork

OptChat's persistent binary summary tree, with optional activation and profiles. New sessions start **off**. Ordinary Pi chatting, context, cache warming and compaction remain available while off. No background agents, connected windows or automatic profile picker at startup.

Install this local package instead of upstream `pi-optchat`:

```sh
pi install /absolute/path/to/pi-extensions/packages/optchat
```

Do not load both packages: they use the same command and memory-tool names.

```text
/optchat status
/optchat                     # TUI: main menu; RPC: status
/optchat on                  # TUI: choose/create a profile; RPC: reuse binding or use session-local memory
/optchat on alfred           # explicitly open/create a named profile
/optchat profile             # explicitly open the profile picker in the TUI
/optchat model openai-codex/gpt-6-luna
/optchat model               # TUI model + reasoning picker
/optchat settings            # memory options, saved immediately
/optchat import              # history preview, append/rebuild, pause/resume/discard
/optchat instructions        # profile AGENTS.md editor
/optchat browse              # readable HTML snapshot of memory
/optchat usage               # token/cost accounting by period and model
/optchat activity            # memory size, pending summaries and errors
/optchat off                 # release memory; restore native context and compaction
```

The on/off selection survives resume of this Pi session. A different new session starts off; `/optchat on alfred` continues Alfred's saved memory after its previous owner releases it. One writer per profile: a busy profile is refused rather than joined through a background agent. A session remains associated with its chosen profile; use a new Pi session to select another.

Enabling starts recording **subsequent messages**, without backfilling earlier session history. Messages sent while off remain in Pi's transcript but are not added to the profile. Existing upstream `optchat.profile` bindings auto-open in RPC/print/JSON mode for compatibility; TUI sessions without an explicit saved on/off setting stay off. `--optchat-profile alfred` explicitly enables a profile in any mode.

Profiles use the existing `~/.optchat/profiles/` format, including imported memory generations, images, inbox recovery, configuration and usage accounting. `OPTCHAT_HOME` overrides the root. Legacy subagent configuration keys are retained for storage compatibility, but no subagents are loaded or resumed. Profiles with pending subagent reports must finish those operations in upstream OptChat before using this fork.

The original importer supports Claude Code, Claude Code memories, Codex, Pi/OMP and ChatGPT exports. It previews source size, duplicates and compression cost before confirmation. Append preserves existing IDs/summaries; rebuild reorders and recompresses the combined history. A new generation is activated only after successful compression, and the old generation stays intact. A paused import blocks profile chatting until resumed or discarded; `/optchat off` still permits ordinary Pi chatting. The import workflow keeps the same Pi session instead of creating a new one. Cancel/discard never deletes the original memory.

The settings and model pages, instructions editor, HTML memory browser, usage/activity panels, and local Git checkpoints are retained. Settings expose only memory/compressor controls; usage estimates are based on API prices, not subscription billing. New main-model usage records count only OptChat runs; existing ledger history is retained. Checkpoints commit profile files locally after completed turns, imports and shutdown; they never push. The browser export contains original profile history, so treat it as private.

New profiles prefer `openai-codex/gpt-6-luna` for compression if registered, otherwise the current Pi model. The notification shows the exact selection. Enabling authorizes compression calls on new messages; summary generation uses the host's model registry and credentials. Existing profiles keep their compressor configuration. Cancellation or compressor failure stops the current inference; the next prompt can retry once summaries recover. Persistence failures keep inference stopped until corrected. `/optchat off` returns to ordinary Pi, and `/optchat model` can correct the compressor selection.

The completed old-history view stays frozen during each tool loop. Before each new submitted prompt, the fork awaits required summaries inside the accepted run, after RPC startup acknowledgement. The upstream long-turn refresh remains available. Only `zoom`, `date`, and optionally `search` are exposed while active; Pi's own tools stay available.

`src/vendor/` contains unchanged memory, import, browser and checkpoint files from upstream pi-optchat 0.8.4. `src/ui/` adapts its menu, settings and inspector to omit subagent controls. `UPSTREAM.json` records provenance and original file hashes. See `LICENSE` and `THIRD_PARTY_NOTICES.md` for Jonas Silva's implementation and Victor Taelin's recipe attribution. The separate entry point removes the automatic profile picker at startup, agents and connected windows.

From the parent checkout, run `node scripts/check-optchat.mjs` and `node scripts/test-optchat.mjs`. They use the installed Pi 1.1 host and disposable offline fixtures.
