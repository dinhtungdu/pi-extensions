import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PACKAGE_FOOTER_STATUS_KEYS } from "./footer-status.js";

export const CODEX_FAST_STATUS_KEY = PACKAGE_FOOTER_STATUS_KEYS.codexFast;
export const CODEX_FAST_STATUS_ICON = "⚡";
export const CODEX_FAST_CONFIG_FILE = "codex-fast.json";

function configPath(): string {
	return join(getAgentDir(), CODEX_FAST_CONFIG_FILE);
}

function loadEnabled(): boolean {
	const path = configPath();
	if (!existsSync(path)) return false;

	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const enabled = (parsed as { enabled?: unknown }).enabled;
			if (typeof enabled === "boolean") return enabled;
		}
		console.error(`codex-fast: ignored invalid config ${path}`);
	} catch (error) {
		console.error(`codex-fast: failed to read ${path}: ${String(error)}`);
	}
	return false;
}

function saveEnabled(enabled: boolean): string {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ enabled }, null, "\t")}\n`, "utf8");
	return path;
}

function isOpenAICodex(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai-codex" && ctx.model.api === "openai-codex-responses";
}

export default function codexFastExtension(pi: ExtensionAPI): void {
	let enabled = false;

	function syncStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			CODEX_FAST_STATUS_KEY,
			enabled && isOpenAICodex(ctx) ? CODEX_FAST_STATUS_ICON : undefined,
		);
	}

	pi.on("session_start", (_event, ctx) => {
		enabled = loadEnabled();
		syncStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		syncStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (
			!enabled ||
			!isOpenAICodex(ctx) ||
			!event.payload ||
			typeof event.payload !== "object" ||
			Array.isArray(event.payload)
		) {
			return;
		}
		return { ...event.payload, service_tier: "priority" };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(CODEX_FAST_STATUS_KEY, undefined);
	});

	pi.registerCommand("fast", {
		description: "Enable, disable, or show persistent OpenAI Codex Fast mode",
		getArgumentCompletions: (prefix) => {
			const values = ["on", "off", "status", "toggle"];
			const matches = values.filter((value) => value.startsWith(prefix));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase() || "status";
			if (command === "status") {
				const active = enabled && isOpenAICodex(ctx);
				ctx.ui.notify(
					`Codex Fast mode: ${enabled ? "on" : "off"}${active ? " (active)" : ""}; config: ${configPath()}`,
					"info",
				);
				return;
			}
			if (command !== "on" && command !== "off" && command !== "toggle") {
				ctx.ui.notify("Usage: /fast [on|off|status|toggle]", "warning");
				return;
			}

			const nextEnabled = command === "toggle" ? !enabled : command === "on";
			try {
				const path = saveEnabled(nextEnabled);
				enabled = nextEnabled;
				syncStatus(ctx);
				ctx.ui.notify(`Codex Fast mode ${enabled ? "enabled" : "disabled"}; saved to ${path}`, "info");
			} catch (error) {
				ctx.ui.notify(`codex-fast: failed to save config: ${String(error)}`, "error");
			}
		},
	});
}
