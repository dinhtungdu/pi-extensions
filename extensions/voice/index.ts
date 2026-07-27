import { fileURLToPath } from "node:url";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadVoiceConfig, missingRuntimeFiles, updateVoiceConfig } from "./config.js";
import { VoiceRuntime } from "./runtime.js";

const SETUP_SCRIPT = fileURLToPath(new URL("../../scripts/setup-voice.mjs", import.meta.url));

export default function voiceExtension(pi: ExtensionAPI) {
	let runtime: VoiceRuntime | undefined;

	function stopRuntime(): void {
		runtime?.stop();
		runtime = undefined;
	}

	function startRuntime(ctx: ExtensionContext): boolean {
		stopRuntime();
		const config = loadVoiceConfig();
		const missing = missingRuntimeFiles(config);
		if (missing.length) {
			ctx.ui.notify(`voice setup incomplete; run /voice setup (missing ${missing[0]})`, "error");
			return false;
		}
		runtime = new VoiceRuntime(pi, ctx, config);
		runtime.start();
		return true;
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (loadVoiceConfig().enabled) startRuntime(ctx);
	});

	pi.on("session_shutdown", () => {
		stopRuntime();
	});

	pi.on("input", (_event, ctx) => {
		runtime?.onUserInput(ctx);
		return { action: "continue" };
	});

	pi.on("agent_start", (_event, ctx) => runtime?.onAgentStart(ctx));
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
		if (event.message.role === "assistant") runtime?.onAssistantEnd(ctx);
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
		const devices = [...audioSection.matchAll(/\[(\d+)]\s+([^\r\n]+)/g)].map((match) => ({
			value: match[1]!,
			label: `${match[1]}: ${match[2]!.trim()}`,
		}));
		if (!devices.length) {
			ctx.ui.notify("voice: no AVFoundation microphones found", "error");
			return;
		}
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

	async function runSetup(ctx: ExtensionContext): Promise<void> {
		const result = await ctx.ui.custom<{ code: number; stdout: string; stderr: string } | null>(
			(tui, theme, _keybindings, done) => {
				const loader = new BorderedLoader(tui, theme, "Building voice workers and downloading models…");
				loader.onAbort = () => done(null);
				void pi
					.exec(process.execPath, [SETUP_SCRIPT], { signal: loader.signal })
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
		ctx.ui.notify("voice setup complete", "info");
		if (loadVoiceConfig().enabled) startRuntime(ctx);
	}

	async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		const command = args.trim().toLowerCase() || "status";
		if (command === "on" || command === "start") {
			if (startRuntime(ctx)) {
				const path = updateVoiceConfig({ enabled: true });
				ctx.ui.notify(`voice enabled (${path})`, "info");
			}
			return;
		}
		if (command === "off") {
			stopRuntime();
			updateVoiceConfig({ enabled: false });
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
		if (command === "setup") {
			await runSetup(ctx);
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
			ctx.ui.notify(
				runtime
					? `voice: ${runtime.status()}`
					: `voice: off; configured=${config.enabled}; setup=${missing.length ? `missing ${missing.length} files` : "ready"}`,
				missing.length ? "warning" : "info",
			);
			return;
		}
		ctx.ui.notify("Usage: /voice [on|off|stop|status|setup|device|test]", "warning");
	}

	pi.registerCommand("voice", {
		description: "Control local hands-free speech input and output",
		getArgumentCompletions: (prefix) => {
			const values = ["on", "off", "stop", "status", "setup", "device", "test"];
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

	pi.registerShortcut("ctrl+alt+s", {
		description: "Stop voice playback immediately",
		handler: (ctx) => {
			runtime?.setContext(ctx);
			runtime?.interruptSpeech("voice stop shortcut", true);
		},
	});
}
