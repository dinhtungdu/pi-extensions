# pi-extensions

Pi extensions:

- `auto-dark-mode` — macOS dark/light theme switching
- `codemode` — Cloudflare-Codemode-style JS tool orchestration for pi built-in tools
- `goal` — Codex-style persisted goals with `/goal`, goal tools, and hidden continuation
- `discord` — automatic Discord project channels and Pi session threads with bidirectional text mirroring
- `tool-visibility` — hide/show all tool execution rows without changing tools, messages, or session history
- `voice` — local hands-free STT/TTS for Apple Silicon with streaming speech and deterministic keyboard interruption

## Install

All extensions from GitHub:

```bash
pi install git:github.com/dinhtungdu/pi-extensions
```

Selected extensions only:

```json
{
	"packages": [
		{
			"source": "git:github.com/dinhtungdu/pi-extensions",
			"extensions": ["extensions/auto-dark-mode.ts", "extensions/code-mode.ts", "extensions/goal.ts", "extensions/discord/index.ts", "extensions/tool-visibility/index.ts", "extensions/voice/index.ts"],
			"skills": [],
			"prompts": [],
			"themes": []
		}
	]
}
```

Put that in `~/.pi/agent/settings.json` for global install, or `.pi/settings.json` for project-local install. If already installed, replace the plain package string with the object form.

Local development:

```bash
pi -e ./extensions/auto-dark-mode.ts
pi -e ./extensions/code-mode.ts
pi -e ./extensions/goal.ts
pi -e ./extensions/discord/index.ts
pi -e ./extensions/tool-visibility/index.ts
pi -e ./extensions/voice/index.ts
pi install /path/to/pi-extensions
```

## Codemode

Registers tool: `codemode`.

Use for multi-step logic over active built-in pi tools:

```js
async () => {
	const files = await codemode.ls({ path: "." });
	const matches = await codemode.grep({ pattern: "TODO", path: ".", limit: 20 });
	return { files, matches };
}
```

Notes:

- Exposes only active built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.
- JavaScript only. No TypeScript syntax.
- Local Node worker/vm isolation, not Cloudflare Workers security. Do not run hostile code. Tiny sandbox, not Fort Knox.
- Output truncated to pi defaults; full output saved to temp when needed.

## Goal

Registers command: `/goal`.

Commands:

```text
/goal <objective>
/goal <objective> --budget 100000
/goal status
/goal pause
/goal resume
/goal clear
```

Registers tools: `get_goal`, `create_goal`, `update_goal`.

Notes:

- `/goal <objective>` persists the goal, then submits the objective so the agent starts immediately.
- Active goals auto-continue with hidden continuation messages until `update_goal({ status: "complete" })`, `/goal pause`, `/goal clear`, budget exhaustion, or a no-tool continuation.
- Goal state is stored in the pi session branch via custom entries; it survives reload/resume/fork.
- Objectives should include scope, success criteria, constraints, and verification commands.

## Discord bridge

The Discord extension connects automatically when configured. The first active Pi process becomes the local relay leader and owns the only Discord gateway connection; other Pi processes register their cwd and session over authenticated local IPC. The relay is bundled in the extension—there is no daemon or system service to install. Leadership fails over when the owner exits. It keeps one durable text channel per working directory and one durable thread per Pi session. Resuming a session reuses its thread and reopens it when archived; channels and threads are never deleted.

Bot setup:

1. Enable the privileged Message Content intent in the Discord developer portal.
2. Invite the bot with View Channels, Read Message History, Send Messages, Create Public Threads, Manage Threads, and Manage Channels permissions.
3. Run `/discord setup`, or create `~/.pi/agent/discord-bridge/config.json`:

```json
{
	"token": "...",
	"guildId": "...",
	"categoryId": "..."
}
```

`categoryId` is optional; omit it to create project channels at the guild root. A configured category that is missing, belongs to another guild, or is not a category fails startup explicitly instead of silently falling back to the root. `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, and `DISCORD_CATEGORY_ID` override file values.

Mappings, per-thread Discord cursors, pending inbound messages, and recent IDs are stored in `~/.pi/agent/discord-bridge/state.json`. Relay ownership, its Unix socket/named pipe, and a generated 256-bit IPC token live in the same mode-0700 directory; token and Unix socket are mode 0600. State writes are atomic and cross-process locked. Inactive sessions receive queued messages when they register again. If every Pi process was closed, the next relay fetches messages after each registering session's durable cursor where Discord history APIs permit.

The bridge ignores bot messages and duplicate Discord IDs, and extension-injected Pi input is not echoed back. Discord messages received while Pi is active use Pi 0.83's normal `followUp` queue. Assistant text is sent only after `agent_settled`; thinking, tools, progress, attachments, and intermediate responses are not forwarded.

Commands:

```text
/discord setup
/discord status
/discord reconnect
```

There is intentionally no user or app allowlist. Discord channel/thread permissions are the access boundary, so restrict them appropriately.

## Tool visibility

Tool rows are visible by default. The extension changes only TUI rendering: tools still execute, stream, complete, and remain unchanged in messages, results, and session history. Existing and future rows—including custom tools and image results—return immediately when shown. While tool rows are hidden, the compact presentation also removes collapsed thinking-only placeholders; expanded thinking and assistant text stay visible.

```text
/tools                  # toggle
/tools hide             # hide tool rows
/tools show             # show tool rows
/tools status
/tools diagnostics      # report shim/version state
```

The footer stays clear while tool rows are shown. When tool rows are put away, narrow/mobile terminals get the compact `🧰` status. Toggle notifications and `/tools status` provide the verbose state. Pi's working indicator and Escape cancellation remain untouched.

Pi has no public global tool-row visibility API, and its hidden-thinking label still reserves transcript rows. `extensions/tool-visibility/visibility-shim.ts` contains isolated compatibility patches for Pi 0.82.1 and newer. Thinking suppression marks collapsed labels through Pi's public UI API and filters that marker from rendered rows; it does not inspect assistant private state. Patch installation fully preflights both renderers and rolls back partial installation failures. The shim forwards all render arguments, shares patches across duplicate/reloaded instances, and restores the original methods on shutdown when safe. A version below 0.82.1 or incompatible runtime shape leaves compact rendering unchanged and raises a visible compatibility error; use `/tools diagnostics` to inspect it.

## Voice

Apple Silicon macOS only. Audio, STT, and TTS stay local; Pi's selected LLM provider remains independent.

Stack:

- microphone/playback: FFmpeg AVFoundation + ffplay
- streaming STT/end-of-utterance: `parakeet.cpp` with `realtime_eou_120m-v1-q8_0`
- streaming TTS: Qwen3-TTS 1.7B CustomVoice 6-bit with the Aiden preset through an isolated `mlx-audio`/MLX environment

Requirements for the full stack:

```bash
xcode-select --install # STT build only; if Command Line Tools are missing
brew install cmake     # STT build only
brew install ffmpeg    # ffmpeg for STT capture; ffplay for TTS playback
# Install uv for TTS: https://docs.astral.sh/uv/
```

TTS-only setup does not require Xcode, CMake, FFmpeg microphone capture, or microphone permission. It still requires `uv` and `ffplay`.

Build workers and download roughly 2.8 GB of models:

```bash
npm run setup:voice                         # STT + TTS
npm run setup:voice -- --tts-only           # TTS only; use an external dictation app
npm run setup:voice -- --stt-only           # add or repair STT only
npm run test:voice                           # local TTS -> local STT self-test
npm run uninstall:voice -- stt               # remove only Parakeet/STT
npm run uninstall:voice -- tts               # remove only Qwen/TTS
npm run uninstall:voice                      # remove all generated voice data
```

Then, inside Pi:

```text
/voice setup [stt|tts|all]      # choose or install specific components
/voice uninstall [stt|tts|all]  # choose or remove specific components
/voice device                   # choose microphone
/voice on
/voice test                     # speak without calling the LLM
/voice stop                     # immediately stop playback and abort current work
/voice status
/voice off
```

Bare `/voice setup` and `/voice uninstall` show a component selector. If STT is not installed, voice automatically runs TTS only without microphone capture; VoiceInk, macOS Dictation, or another input method can insert text normally. Removing STT while voice is active restarts TTS without microphone capture. Removing all generated data deletes `~/.pi/agent/cache/pi-voice`. Every uninstall variant preserves `~/.pi/agent/voice.json`.

Voice starts off in every new session. `/voice on` and `/voice off` only affect the current session; that choice is not stored in configuration.

When enabled, voice adds a compact colored `🎙` to Pi's extension-status footer row. Pi owns placement and truncation, so the status stays readable alongside other extensions on narrow/mobile terminals. Voice mode also asks the model for concise, conversational, listening-friendly responses; disabling voice automatically restores the normal written response style.

`Ctrl+Shift+V` toggles voice mode. When STT is not installed, VoiceInk, macOS Dictation, or another input method owns speech input and inserts text into Pi normally.

Microphone audio cannot interrupt thinking or playback. Press `Escape` to stop voice playback; if an agent response is active, Pi aborts it too. `Ctrl+Alt+S`, `/voice stop`, or a typed follow-up also interrupts playback explicitly. The first microphone launch triggers the macOS microphone permission prompt. Grant access to the terminal application running Pi. Voice uses the macOS default microphone unless you select a specific device with `/voice device`. If the microphone disappears, capture retries in the background and follows a newly available system default without putting voice mode into an error state.

A TTS-only installation does not launch the Parakeet worker, FFmpeg microphone capture, or request microphone permission. The Qwen TTS model is still required.

Configuration: `~/.pi/agent/voice.json`. Useful overrides:

```json
{
	"announceReady": true,
	"inputDevice": "default",
	"ttsVoice": "Aiden",
	"ttsInstruction": "Speak naturally in a calm, conversational tone.",
	"maxSpokenCharacters": 400,
	"transcriptCleanup": false,
	"cleanupModel": "current",
	"cleanupMinChars": 160,
	"cleanupTimeoutMs": 2500
}
```

Aiden is Qwen3-TTS's native English premium preset; output does not clone a macOS system voice. `ttsInstruction` controls delivery style.

Transcript cleanup is opt-in. When `transcriptCleanup` is enabled, short transcripts receive conservative local filler/restart cleanup. Transcripts at least `cleanupMinChars` long also use a standalone model request. `cleanupModel: "current"` reuses Pi's selected model and resolved `/login` or API-key authentication; `"provider/model"` selects another model already configured in Pi. Credentials are never copied into `voice.json`.

Model cleanup receives only the transcript and cleanup instructions—no conversation history, tools, project context, or agent system prompt. A cloud model sends transcript text to that provider, consumes its quota, and adds latency. Timeout, authentication failure, invalid output, or modification of protected technical text falls back to the raw transcript. Keep `transcriptCleanup: false` for fully local STT/TTS privacy.

The setup pins and builds MIT-licensed `parakeet.cpp`, installs MIT-licensed `mlx-audio` in an isolated environment, and downloads model weights from Hugging Face. Parakeet GGUF weights are CC-BY-4.0; Qwen3-TTS has its own model license. No unlicensed `pibot` source is copied.

Hands-free input cannot identify who is speaking. While Pi is thinking, running tools, or speaking, all microphone audio is ignored. Listening resumes after playback and a short cooldown, so speaker echo cannot become user input. In noisy or shared rooms, use VoiceInk or another explicit dictation input instead.

## Auto dark mode config

Global: `~/.pi/agent/auto-dark-mode.json`
Project override: `<cwd>/.pi/auto-dark-mode.json`

```json
{
	"darkTheme": "dark",
	"lightTheme": "light",
	"intervalMs": 2000,
	"notify": false
}
```

Project config overrides global config.

## Commands

- `/auto-theme` or `/auto-theme status` — show current mapping
- `/auto-theme pick` — choose dark/light themes interactively
- `/auto-theme dark <theme>` — save dark-mode theme
- `/auto-theme light <theme>` — save light-mode theme

If project config exists, commands write there; otherwise they write global config.
