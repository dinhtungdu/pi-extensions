import { fileURLToPath } from "node:url";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	loadVoiceConfig,
	missingRuntimeFiles,
	updateVoiceConfig,
	voiceCacheDir,
	type VoiceComponent,
	type VoiceInputMode,
} from "./config.js";
import { VoiceFooterController } from "./footer.js";
import { voiceResponseSystemPrompt } from "./response-style.js";
import { VoiceRuntime } from "./runtime.js";

const SETUP_SCRIPT = fileURLToPath(new URL("../../scripts/setup-voice.mjs", import.meta.url));
const UNINSTALL_SCRIPT = fileURLToPath(new URL("../../scripts/uninstall-voice.mjs", import.meta.url));

type VoiceComponentTarget = VoiceComponent | "all";

const COMPONENT_OPTIONS: Array<{ label: string; value: VoiceComponentTarget }> = [
	{ label: "Speech output only (TTS)", value: "tts" },
	{ label: "Speech input only (STT)", value: "stt" },
	{ label: "Speech input + output", value: "all" },
];

export default function voiceExtension(pi: ExtensionAPI) {
	let runtime: VoiceRuntime | undefined;
	let unsubscribeTerminalInput: (() => void) | undefined;
	const footer = new VoiceFooterController(pi);

	function stopRuntime(): void {
		runtime?.stop();
		runtime = undefined;
		footer.deactivate();
	}

	function startRuntime(ctx: ExtensionContext): boolean {
		stopRuntime();
		const config = loadVoiceConfig();
		const missing = missingRuntimeFiles(config);
		if (missing.length) {
			ctx.ui.notify(`voice setup incomplete; run /voice setup (missing ${missing[0]})`, "error");
			return false;
		}
		footer.activate(ctx);
		runtime = new VoiceRuntime(pi, ctx, config, (phase) => footer.setPhase(phase));
		runtime.start();
		return true;
	}

	pi.on("session_start", (_event, ctx) => {
		stopRuntime();
		if (!ctx.hasUI) return;
		if (ctx.mode === "tui") {
			unsubscribeTerminalInput?.();
			unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
				runtime?.onTerminalInput(data);
				return undefined;
			});
		}
	});

	pi.on("session_shutdown", () => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		runtime?.stop();
		runtime = undefined;
		footer.dispose();
	});

	pi.on("input", (event, ctx) => {
		runtime?.onUserInput(ctx, event.source !== "extension");
		return { action: "continue" };
	});

	pi.on("before_agent_start", (event) => {
		const systemPrompt = voiceResponseSystemPrompt(event.systemPrompt, runtime !== undefined);
		if (systemPrompt) return { systemPrompt };
	});

	pi.on("agent_start", (_event, ctx) => runtime?.onAgentStart(ctx));
	pi.on("agent_end", (event, ctx) => {
		const interrupted =
			ctx.signal?.aborted ||
			event.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted");
		if (interrupted) runtime?.onAgentInterrupted(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => runtime?.onAgentSettled(ctx));
	pi.on("tool_execution_start", (_event, ctx) => runtime?.onToolActivity(ctx));
	pi.on("tool_execution_end", (_event, ctx) => runtime?.onToolActivity(ctx));

	pi.on("message_start", (event, ctx) => {
		if (event.message.role === "assistant") runtime?.onAssistantStart(ctx);
	});

	pi.on("message_update", (event, ctx) => {
		if (
			event.message.role === "assistant" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			runtime?.onAssistantText(event.assistantMessageEvent.delta, ctx);
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") {
			runtime?.onAssistantEnd(ctx, event.message.stopReason === "aborted");
		}
	});

	async function configureDevice(ctx: ExtensionContext): Promise<void> {
		const config = loadVoiceConfig();
		const result = await pi.exec(config.ffmpegPath, [
			"-hide_banner",
			"-f",
			"avfoundation",
			"-list_devices",
			"true",
			"-i",
			"",
		]);
		const output = `${result.stdout}\n${result.stderr}`;
		const audioSection = output.split("AVFoundation audio devices:")[1] ?? "";
		const devices = [
			{ value: "default", label: "System default microphone" },
			...[...audioSection.matchAll(/\[(\d+)]\s+([^\r\n]+)/g)].map((match) => ({
				value: match[2]!.trim(),
				label: `${match[1]}: ${match[2]!.trim()}`,
			})),
		];
		const selected = await ctx.ui.select(
			"Voice microphone",
			devices.map((device) => device.label),
		);
		if (!selected) return;
		const device = devices.find((candidate) => candidate.label === selected);
		if (!device) return;
		updateVoiceConfig({ inputDevice: device.value });
		ctx.ui.notify(`voice: microphone set to ${device.label}`, "info");
		if (runtime) startRuntime(ctx);
	}

	async function chooseComponent(ctx: ExtensionContext, action: "setup" | "uninstall"): Promise<VoiceComponentTarget | undefined> {
		const selected = await ctx.ui.select(
			`Voice ${action}`,
			COMPONENT_OPTIONS.map((option) => option.label),
		);
		return COMPONENT_OPTIONS.find((option) => option.label === selected)?.value;
	}

	async function runSetup(ctx: ExtensionContext, target: VoiceComponentTarget): Promise<void> {
		const setupArgs = target === "stt" ? ["--stt-only"] : target === "tts" ? ["--tts-only"] : [];
		const label = target === "all" ? "speech input and output" : target === "stt" ? "speech input" : "speech output";
		const result = await ctx.ui.custom<{ code: number; stdout: string; stderr: string } | null>(
			(tui, theme, _keybindings, done) => {
				const loader = new BorderedLoader(tui, theme, `Installing ${label}…`);
				loader.onAbort = () => done(null);
				void pi
					.exec(process.execPath, [SETUP_SCRIPT, ...setupArgs], { signal: loader.signal })
					.then(done)
					.catch((error) => done({ code: 1, stdout: "", stderr: String(error) }));
				return loader;
			},
		);
		if (!result) {
			ctx.ui.notify("voice setup cancelled", "warning");
			return;
		}
		if (result.code !== 0) {
			const details = result.stderr.trim().split("\n").slice(-4).join("\n");
			ctx.ui.notify(`voice setup failed: ${details || `exit ${result.code}`}`, "error");
			return;
		}
		let config = loadVoiceConfig();
		if (missingRuntimeFiles(config, ["stt"]).length && config.inputMode !== "external") {
			updateVoiceConfig({ inputMode: "external" });
			config = loadVoiceConfig();
		}
		const missing = missingRuntimeFiles(config);
		ctx.ui.notify(
			missing.length
				? `voice ${label} setup complete; another required component is missing—run /voice status`
				: `voice ${label} setup complete; run /voice on to start it`,
			missing.length ? "warning" : "info",
		);
	}

	async function runUninstall(ctx: ExtensionContext, target: VoiceComponentTarget): Promise<void> {
		const description = target === "all"
			? `Delete ${voiceCacheDir()}?\n\nThis removes all downloaded models, workers, build files, and the Python environment.`
			: `Remove the local ${target.toUpperCase()} model, worker, and generated files?`;
		const confirmed = await ctx.ui.confirm(`Uninstall voice ${target}?`, `${description}\n\nVoice configuration is preserved.`);
		if (!confirmed) return;

		const restartOutput = runtime !== undefined && target === "stt";
		stopRuntime();
		ctx.ui.notify(`removing voice ${target} data…`, "info");
		const result = await pi.exec(process.execPath, [UNINSTALL_SCRIPT, target]);
		if (result.code !== 0) {
			const details = result.stderr.trim().split("\n").slice(-4).join("\n");
			ctx.ui.notify(`voice uninstall failed: ${details || `exit ${result.code}`}`, "error");
			return;
		}
		if (target === "stt" || target === "all") updateVoiceConfig({ inputMode: "external" });
		if (restartOutput) startRuntime(ctx);
		ctx.ui.notify(`voice ${target} data uninstalled; configuration preserved`, "info");
	}

	function setInputMode(mode: VoiceInputMode, ctx: ExtensionContext): void {
		const config = loadVoiceConfig();
		if (mode !== "external" && missingRuntimeFiles(config, ["stt"]).length) {
			ctx.ui.notify("voice speech input is not installed; run /voice setup stt", "error");
			return;
		}
		updateVoiceConfig({ inputMode: mode });
		runtime?.setContext(ctx);
		runtime?.setInputMode(mode);
		const message = mode === "push-to-talk"
			? "voice: push-to-talk mode; press F8, then speak"
			: mode === "always-on"
				? "voice: always-on mode"
				: "voice: external input mode; use your dictation app";
		ctx.ui.notify(message, "info");
	}

	function startPushToTalk(ctx: ExtensionContext): void {
		if (loadVoiceConfig().inputMode === "external") {
			ctx.ui.notify("voice: internal speech input is disabled; use your dictation app", "info");
			return;
		}
		if (!runtime && !startRuntime(ctx)) return;
		runtime?.setContext(ctx);
		if (runtime?.armPushToTalk()) updateVoiceConfig({ inputMode: "push-to-talk" });
	}

	async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const command = args.trim().toLowerCase() || "status";
		if (command === "on" || command === "start") {
			if (startRuntime(ctx)) ctx.ui.notify("voice enabled for this session", "info");
			return;
		}
		if (command === "off") {
			stopRuntime();
			ctx.ui.notify("voice disabled", "info");
			return;
		}
		if (command === "stop" || command === "interrupt") {
			if (!runtime) {
				ctx.ui.notify("voice is off", "warning");
				return;
			}
			runtime.interruptSpeech("voice stop command", true);
			return;
		}
		if (command === "talk" || command === "push") {
			startPushToTalk(ctx);
			return;
		}
		if (command === "mode" || command.startsWith("mode ")) {
			let requested = command.slice(4).trim();
			if (!requested) {
				requested = (await ctx.ui.select("Voice input mode", ["push-to-talk", "always-on", "external"])) ?? "";
			}
			if (requested === "push" || requested === "ptt") requested = "push-to-talk";
			if (requested === "always" || requested === "hands-free") requested = "always-on";
			if (requested === "output" || requested === "tts" || requested === "dictation") requested = "external";
			if (requested !== "push-to-talk" && requested !== "always-on" && requested !== "external") {
				ctx.ui.notify("Usage: /voice mode [push-to-talk|always-on|external]", "warning");
				return;
			}
			setInputMode(requested, ctx);
			return;
		}
		if (command === "setup" || command.startsWith("setup ")) {
			const requested = command.slice(5).trim();
			const target = requested ? requested as VoiceComponentTarget : await chooseComponent(ctx, "setup");
			if (!target) return;
			if (target !== "stt" && target !== "tts" && target !== "all") {
				ctx.ui.notify("Usage: /voice setup [stt|tts|all]", "warning");
				return;
			}
			await runSetup(ctx, target);
			return;
		}
		if (command === "uninstall" || command.startsWith("uninstall ")) {
			const requested = command.slice(9).trim();
			const target = requested ? requested as VoiceComponentTarget : await chooseComponent(ctx, "uninstall");
			if (!target) return;
			if (target !== "stt" && target !== "tts" && target !== "all") {
				ctx.ui.notify("Usage: /voice uninstall [stt|tts|all]", "warning");
				return;
			}
			await runUninstall(ctx, target);
			return;
		}
		if (command === "test") {
			if (!runtime) {
				ctx.ui.notify("voice is off; run /voice on first", "warning");
				return;
			}
			runtime.testOutput();
			return;
		}
		if (command === "device" || command === "devices") {
			await configureDevice(ctx);
			return;
		}
		if (command === "status") {
			const config = loadVoiceConfig();
			const missing = missingRuntimeFiles(config);
			const stt = missingRuntimeFiles(config, ["stt"]).length ? "missing" : "ready";
			const tts = missingRuntimeFiles(config, ["tts"]).length ? "missing" : "ready";
			ctx.ui.notify(
				runtime
					? `voice: ${runtime.status()}`
					: `voice: off; mode=${config.inputMode}; STT=${stt}; TTS=${tts}; setup=${missing.length ? "incomplete" : "ready"}`,
				missing.length ? "warning" : "info",
			);
			return;
		}
		ctx.ui.notify("Usage: /voice [on|off|talk|stop|mode|status|setup|uninstall|device|test]", "warning");
	}

	pi.registerCommand("voice", {
		description: "Control local hands-free speech input and output",
		getArgumentCompletions: (prefix) => {
			const values = [
				"on",
				"off",
				"talk",
				"stop",
				"mode push-to-talk",
				"mode always-on",
				"mode external",
				"status",
				"setup stt",
				"setup tts",
				"setup all",
				"uninstall stt",
				"uninstall tts",
				"uninstall all",
				"device",
				"test",
			];
			const matches = values.filter((value) => value.startsWith(prefix));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: handleCommand,
	});

	pi.registerShortcut("ctrl+shift+v", {
		description: "Toggle local voice mode",
		handler: async (ctx) => {
			await handleCommand(runtime ? "off" : "on", ctx);
		},
	});

	const pushToTalkShortcut = {
		description: "Capture one push-to-talk utterance",
		handler: (ctx: ExtensionContext) => startPushToTalk(ctx),
	};
	pi.registerShortcut("f8", pushToTalkShortcut);
	pi.registerShortcut("ctrl+alt+v", pushToTalkShortcut);

	pi.registerShortcut("ctrl+alt+s", {
		description: "Stop voice playback immediately",
		handler: (ctx) => {
			runtime?.setContext(ctx);
			runtime?.interruptSpeech("voice stop shortcut", true);
		},
	});
}
