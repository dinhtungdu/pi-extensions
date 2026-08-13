# pi-extensions

Pi extensions:

- `auto-dark-mode` — macOS dark/light theme switching
- `codemode` — Cloudflare-Codemode-style JS tool orchestration for pi built-in tools
- `goal` — Codex-style persisted goals with `/goal`, goal tools, and hidden continuation
- `codex-fast` — persistently toggle OpenAI Codex Fast mode and show `⚡` while active
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
			"extensions": ["extensions/auto-dark-mode.ts", "extensions/code-mode.ts", "extensions/goal.ts", "extensions/codex-fast.ts", "extensions/discord/index.ts", "extensions/tool-visibility/index.ts", "extensions/voice/index.ts"],
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
pi -e ./extensions/codex-fast.ts
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

## OpenAI Codex fast mode

For `openai-codex` models using the Codex Responses API, enabled Fast mode sets `service_tier: "priority"`. Other providers and APIs are unchanged. The footer shows `⚡` before the Discord status while Fast mode applies.

```text
/fast on
/fast off
/fast status
/fast toggle
```

The setting persists across sessions in `~/.pi/agent/codex-fast.json`. Default: enabled. It can also be edited directly:

```json
{
	"enabled": false
}
```

Direct config edits take effect on next session or `/reload`.

## Discord bridge

When configured, the Discord extension connects automatically only for sessions whose cwd is `~/workspace`, `~/worktrees`, or a descendant of either directory. Elsewhere it stays off by default; run `/discord reconnect` to enable the current session explicitly without changing the default for other sessions. `/discord setup` also connects the current session after saving configuration. Extension clients race-safely spawn a bundled detached child process, which independently owns the only Discord gateway connection while Pi clients register their cwd and session over authenticated local IPC. No Pi process owns the gateway, and the child survives whichever Pi process launched or reconfigured it. There is no daemon or system service to install or manage; the child exits automatically after every Pi client disconnects. It keeps one durable text channel per project and one durable thread per Pi session. A Git main checkout and its linked worktrees share the main repository channel; non-Git directories keep using their normalized working directory. Git detection is bounded and optional, so unavailable or malformed Git results safely fall back to that working directory. Project channels use the slugged project basename; only additional identities with the same slug receive a short deterministic path hash. Existing project-channel records are retained, resuming a session reuses its thread and reopens it when archived, and channels and threads are never deleted. `the-manager` middle-manager sessions also idempotently add the configured guild owner to that existing session thread so it stays visible in the owner's sidebar; retained primary workers and fresh workers are excluded.

While another Pi client keeps the relay alive, an offline middle-manager mapping with a Manager-issued wake-only descriptor can make one bounded Supervisor wake request after durably queuing a Discord message. Failures keep the queue and post a manual-reconnect warning. Discord content never selects Manager identity, endpoint, capability, command, or arguments; generic offline sessions remain queue-only.

New thread names prefer the Pi session display name, then an explicit title from `TASK.md` at the current checkout/worktree root, then `pi-session-<first-8-session-id>`. A `title:` in leading YAML-style frontmatter takes precedence over the first `#` heading. Discovery reads at most 16 KiB from a regular UTF-8 file and ignores missing, malformed, oversized, binary, or symlinked metadata. Explicit and task-derived names remain capped at 100 characters. Existing threads are reused without renaming.

Bot setup:

1. Enable the privileged Message Content intent in the Discord developer portal.
2. Invite the bot with the `bot` and `applications.commands` scopes plus View Channels, Read Message History, Send Messages, Add Reactions, Create Public Threads, Manage Threads, and Manage Channels permissions.
3. Run `/discord setup`, or create `~/.pi/agent/discord-bridge/config.json`:

```json
{
	"token": "...",
	"guildId": "...",
	"categoryId": "..."
}
```

`categoryId` is optional; omit it to create project channels at the guild root. A configured category that is missing, belongs to another guild, or is not a category fails startup explicitly instead of silently falling back to the root. `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, and `DISCORD_CATEGORY_ID` override file values.

Mappings, per-thread Discord cursors, pending inbound messages, ordered outbound messages, and recent IDs are stored in `~/.pi/agent/discord-bridge/state.json`. Project-channel mappings are permanent. While the relay runs and during graceful replacement, completed lifecycle records and inactive clean session mappings older than 30 days are compacted; active or registering sessions, queued inbound/outbound work, retained-image cleanup, and unfinished lifecycle coordination are never pruned, and at least the latest 100 sessions always remain. Recent deduplication IDs stay capped at 2,000. Legacy state receives compatible activity timestamps without a state-version migration. Relay ownership, its Unix socket/named pipe, effective-config authority, and a generated 256-bit IPC token live in the same mode-0700 directory; token and Unix socket are mode 0600. State and configuration writes are atomic and cross-process locked. Extension clients automatically launch a bundled child process that owns the sole gateway while any Pi client remains; no service installation or manual daemon is required. Environment overrides participate in the authoritative monotonic configuration epoch, so a changed effective configuration atomically replaces the child gateway and remains authoritative if the updating Pi process exits. The child exits after a bounded zero-client grace period. IPC queues are memory-bounded and respect socket backpressure. Inactive sessions receive queued messages when they register again. The relay exposes one durable inbound head at a time and advances only after Pi persists and acknowledges that message, so recovered and newly arriving messages enter Pi's native follow-up path in exact order. If every Pi process was closed, the next relay fetches messages after each registering session's durable cursor where Discord history APIs permit. Outbound chunks use Discord's enforced nonce deduplication, remain queued until Discord confirms them, retry transient failures with bounded backoff, and retarget safely when registration recreates a deleted thread.

The bridge ignores bot messages and duplicate Discord IDs, and extension-injected Pi input is not echoed back. Each chunk of interactive Pi user input starts with `👨‍💻: ` and otherwise preserves the input unchanged; long input is split at code-point boundaries and every chunk repeats the prefix. RPC/non-interactive input is mirrored byte-for-byte unchanged. Discord messages received while Pi is active use Pi 0.83's normal `followUp` queue. Inbound Discord captions and image-only messages preserve that routing and inject up to four JPEG, PNG, GIF, or WebP files through Pi 0.83's native image content. Every downloaded image also gets a bounded, quoted local-path reference in the text. If the selected model lacks image input, the bridge sends no native image content and adds an explicit warning while retaining those usable paths for the run. The detached relay alone downloads from Discord's HTTPS attachment CDN, with 8 MiB per-image, 16 MiB per-message, and 128 MiB aggregate spool limits, MIME/signature/length checks, three bounded attempts, and no redirects. It persists only bounded metadata and private relay-owned file paths. Permanent attachment rejection becomes a queued warning and advances the durable cursor; transient exhaustion leaves the cursor before the gap and retries catch-up with capped backoff without blocking registration. Unsupported attachments are never silent. The authenticated Pi client revalidates paths and files before base64 encoding. Acknowledgement removes the delivery queue entry but retains files until the associated run settles; cleanup then removes retained metadata before safely deleting files. Pending and acknowledged files survive client/relay restarts, while old clients remain text-only and cannot acknowledge native image messages until upgraded. For Discord-originated prompts, the bot replaces only its own lifecycle reaction: 👀 queued, 🤔 running, ⚙️ using tools, then ✅ settled or ❌ failed/aborted. Each accepted turn also creates one bot-owned `Working...` message in its exact mapped thread. Final assistant delivery carries the accepted Discord message IDs; only successful delivery of every response chunk deletes those exact indicators. Failed delivery keeps them visible and queued retry work cannot delete another turn's indicator. Reaction failures do not block prompts or replies. Thinking, tools, progress, attachments, and intermediate responses are not forwarded. Every bot-created or edited message suppresses Discord link embeds, including control replies.

During each settled request, native image blocks from finalized Pi tool results are attached once to its last eligible final text response; earlier eligible replies remain text-only, and images are dropped when no final text exists. Every reply stays byte-for-byte unchanged; thinking, tool text, progress, user images, Markdown references, and paths are never interpreted as outbound attachments. The relay accepts at most four unique JPEG, PNG, GIF, or WebP images within a 10 MiB total, validates canonical base64, MIME signatures, and size, then persists only mode-0600 relay snapshots and safe digest metadata. Images use relay-generated filenames and attach to the first lossless Unicode-safe text chunk. Missing or corrupt snapshots omit only affected files without changing text. Multipart upload is attempted at most once; uncertain failure is abandoned without text fallback, while later replies continue. Older relays remain text-only without changing response text.

The relay registers guild-scoped `/pi` controls for mapped session threads. Replies are ephemeral, controls are rejected for unmapped or offline sessions, and model autocomplete filters a bounded catalogue cached when the Pi client registers or reconnects. `/pi model` and `/pi thinking` are idle-only and use Pi's native APIs, so they also update Pi's persisted global defaults. `/pi abort` requests cancellation through Pi's queue-preserving abort API; it does not claim the turn already stopped.

```text
/pi status
/pi model <model>
/pi thinking <off|minimal|low|medium|high|xhigh|max>
/pi steer <message>
/pi followup <message>
/pi abort
```

Verified live `the-manager` session threads also expose only the guild-scoped `/m` command. Manager autocomplete and execution stay bound to the invoking mapped thread; project channels, arbitrary threads, offline sessions, stale catalogue entries, and ordinary Pi sessions fail closed.

```text
/m handoff <task>
/m takeback <task>
/m archive <task>
/m merge-and-archive <task>
/m reconcile-pr [task]
/m ask <target> <request>
```

When Pi runs from a `the-manager` checkout, the extension watches canonical Manager data changes and requests the complete opaque `summary-render` presentation with the Manager's 10,000-character bound. Discord only paginates that returned content: it preserves every content character, appends bounded batch revision/page metadata, and keeps each message within 2,000 characters. Presentations with Manager-owned `action_controls` use Discord Components V2 and place each action at its Manager-supplied UTF-16 `after` offset; Discord never parses summary Markdown. Ready direct-landing tasks may expose **Merge & archive** beneath their associated text. First valid click executes `task-merge-and-archive` through Manager Supervisor with no second confirmation. Pull-request landing tasks receive no Manager action. Exact summary revision, delivered source-message identity, and Manager-owned action descriptor fence execution. **Refresh & Reconcile** remains after summary content. Presentations without `action_controls` retain their existing control layout for backward compatibility. Replacement sends every new page first, then deletes prior bot-authored summary pages. A failed send preserves the last-good batch and triggers best-effort cleanup of partial new pages. Batch discovery uses reserved metadata in the dedicated Manager project channel; unrelated human and bot messages are never deleted.

Desired presentation state and final control-message identity remain durable across relay restarts, but reconciliation still begins only after the elected producer for the matching Manager project publishes a fresh canonical snapshot. Registration alone, unrelated relay startup, and unrelated project sessions cannot revive persisted text. Concurrent eligible sessions keep one relay-elected writer, and every reconciliation step remains fenced by exact client generation and summary revision. Owner retirement settles old-generation work before promotion, strips controls by replacing the batch, and prevents stale side effects from overtaking newer state. Relay reconnection requests a fresh canonical presentation instead of replaying cached client text. Bounded backoff retries failed reconciliation without blocking Manager mutations. Producers submit only Manager-owned opaque content, global controls, and per-task action descriptors; relay derives the project channel from authenticated session registration and performs pagination and descriptor placement only.

Manager-owned `manager:task-terminal` events are transported unchanged to exactly one durable session mapping with same task identity. This canonical durable receipt is sole terminal-content and thread-closure source; presentation controls return ordinary results and never synthesize terminal payloads. Relay state records desired receipt and nonce before sending, records successful send before locking, then locks before archiving. Delivery is durable at-least-once: duplicate Manager events are no-ops after desired state exists, but Discord may contain a duplicate receipt when it accepted a send and the relay failed before recording that message ID. Restart retries unfinished send, lock, and archive stages; lock and archive mutations are idempotent. Terminal mappings reject reconnect, inbound delivery, wake, and new outbound messages; malformed, unmapped, ambiguous, and cross-task events fail closed.

Commands:

```text
/discord setup       # configure the bridge
/discord status      # inspect this client's connection
/discord reconnect   # enable/reconnect this Pi session
/discord restart     # safely replace the detached relay for every active client
```

`/discord restart` gracefully signals only the relay whose PID and process identity still match the authenticated connection and ownership lease. It refuses malformed, missing, inaccessible, changed, or PID-reused ownership records rather than risking another process. Shutdown and replacement waiting are bounded; it never escalates to a destructive forced kill. All active Pi clients reconnect automatically and converge on one replacement gateway.

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
