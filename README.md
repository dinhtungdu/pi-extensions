# pi-extensions

Pi extensions:

- `auto-dark-mode` — macOS dark/light theme switching
- `codemode` — Cloudflare-Codemode-style JS tool orchestration for pi built-in tools
- `goal` — Codex-style persisted goals with `/goal`, goal tools, and hidden continuation
- `voice` — local hands-free STT/TTS for Apple Silicon with streaming speech and speaker barge-in

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
			"extensions": ["extensions/auto-dark-mode.ts", "extensions/code-mode.ts", "extensions/goal.ts", "extensions/voice/index.ts"],
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

## Voice

Apple Silicon macOS only. Audio, STT, and TTS stay local; Pi's selected LLM provider remains independent.

Stack:

- microphone/playback: FFmpeg AVFoundation + ffplay
- streaming STT/end-of-utterance: `parakeet.cpp` with `realtime_eou_120m-v1-q8_0`
- streaming TTS: Qwen3-TTS 1.7B CustomVoice 6-bit with the Aiden preset through an isolated `mlx-audio`/MLX environment
- speaker barge-in: microphone/playback correlation with one second of microphone preroll

Requirements:

```bash
xcode-select --install # if Command Line Tools are missing
brew install cmake ffmpeg
# Install uv if missing: https://docs.astral.sh/uv/
```

Build workers and download roughly 2.8 GB of models:

```bash
npm run setup:voice
npm run test:voice # local TTS -> local STT self-test
npm run uninstall:voice # remove models, workers, builds, and the voice Python environment
```

Then, inside Pi:

```text
/voice setup      # build workers and download models
/voice uninstall  # remove all generated local voice data
/voice device              # choose microphone
/voice mode push-to-talk   # ignore microphone until explicitly armed
/voice talk                # capture one utterance
/voice mode always-on      # restore hands-free listening
/voice on
/voice test                # speak without calling the LLM
/voice stop                # immediately stop playback and abort current work
/voice status
/voice off
```

`/voice uninstall` asks for confirmation, disables voice, and removes `~/.pi/agent/cache/pi-voice` while preserving `~/.pi/agent/voice.json`. The npm command performs the same removal without an interactive confirmation.

`Ctrl+Shift+V` toggles voice mode. Press `F8` once and speak for push-to-talk (`Ctrl+Alt+V` and `/voice talk` are aliases). This enables voice, switches input mode, and arms capture even if voice was off or always-on. Capture closes automatically at end-of-utterance. Terminals do not expose reliable key-release events, so this is one-shot rather than hold-to-talk. If speech does not begin within 10 seconds, capture disarms. Background audio is ignored while disarmed.

`Ctrl+Alt+S`, `/voice stop`, any typed follow-up, or—while always-on—saying “stop”/“Pi stop” interrupts playback immediately. The first microphone launch triggers the macOS microphone permission prompt. Grant access to the terminal application running Pi.

Configuration: `~/.pi/agent/voice.json`. Useful overrides:

```json
{
	"enabled": true,
	"announceReady": true,
	"inputMode": "always-on",
	"inputDevice": "0",
	"ttsVoice": "Aiden",
	"ttsInstruction": "Speak naturally in a calm, conversational tone.",
	"micThreshold": 0.006,
	"residualThreshold": 0.62,
	"bargeInFrames": 5,
	"maxEchoDelayMs": 2500,
	"maxSpokenCharacters": 800,
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

Always-on mode cannot identify who is speaking. While Pi is thinking or running tools, normal background speech is ignored; only a stop phrase or push-to-talk can interrupt that work. Speaker barge-in remains active during playback. Use push-to-talk in noisy or shared rooms. If playback interrupts itself, increase `bargeInFrames` or `residualThreshold`; if it misses you, lower `micThreshold` or `residualThreshold`.

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
