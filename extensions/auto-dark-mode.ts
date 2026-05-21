/**
 * Auto-switches pi's theme based on macOS system appearance.
 *
 * Config files are merged in order, with project config overriding global:
 *   ~/.pi/agent/auto-dark-mode.json
 *   <cwd>/.pi/auto-dark-mode.json
 *
 * Example config:
 * {
 *   "darkTheme": "dark",
 *   "lightTheme": "light",
 *   "intervalMs": 2000,
 *   "notify": false
 * }
 */

import { exec } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const execAsync = promisify(exec);

type Appearance = "dark" | "light";

interface Config {
	darkTheme: string;
	lightTheme: string;
	intervalMs: number;
	notify: boolean;
}

const CONFIG_FILE = "auto-dark-mode.json";
const MIN_INTERVAL_MS = 500;

const DEFAULT_CONFIG: Config = {
	darkTheme: "dark",
	lightTheme: "light",
	intervalMs: 2000,
	notify: false,
};

function globalConfigPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", CONFIG_FILE);
}

function readJsonObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};

	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch (error) {
		console.error(`auto-dark-mode: failed to read ${path}: ${String(error)}`);
		return {};
	}
}

function toPartialConfig(raw: Record<string, unknown>): Partial<Config> {
	const config: Partial<Config> = {};

	if (typeof raw.darkTheme === "string" && raw.darkTheme.trim()) {
		config.darkTheme = raw.darkTheme.trim();
	}
	if (typeof raw.lightTheme === "string" && raw.lightTheme.trim()) {
		config.lightTheme = raw.lightTheme.trim();
	}
	if (typeof raw.intervalMs === "number" && Number.isFinite(raw.intervalMs)) {
		config.intervalMs = Math.max(MIN_INTERVAL_MS, Math.floor(raw.intervalMs));
	}
	if (typeof raw.notify === "boolean") {
		config.notify = raw.notify;
	}

	return config;
}

function loadConfig(cwd: string): Config {
	return {
		...DEFAULT_CONFIG,
		...toPartialConfig(readJsonObject(globalConfigPath())),
		...toPartialConfig(readJsonObject(projectConfigPath(cwd))),
	};
}

function writeConfigValue(cwd: string, key: "darkTheme" | "lightTheme", value: string): string {
	const target = existsSync(projectConfigPath(cwd)) ? projectConfigPath(cwd) : globalConfigPath();
	const current = readJsonObject(target);
	const next = { ...current, [key]: value };

	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${JSON.stringify(next, null, "\t")}\n`, "utf8");

	return target;
}

async function getMacAppearance(): Promise<Appearance | undefined> {
	if (process.platform !== "darwin") return undefined;

	try {
		const { stdout } = await execAsync(
			"osascript -e 'tell application \"System Events\" to tell appearance preferences to return dark mode'",
		);
		return stdout.trim() === "true" ? "dark" : "light";
	} catch {
		return undefined;
	}
}

function themeForAppearance(appearance: Appearance, config: Config): string {
	return appearance === "dark" ? config.darkTheme : config.lightTheme;
}

function formatStatus(appearance: Appearance, themeName: string): string {
	return `auto-theme:${appearance}->${themeName}`;
}

async function syncTheme(ctx: ExtensionContext, config: Config, state: { appearance?: Appearance; themeName?: string }): Promise<void> {
	const appearance = await getMacAppearance();
	if (!appearance) {
		ctx.ui.setStatus("auto-dark-mode", "auto-theme:unsupported");
		return;
	}

	const themeName = themeForAppearance(appearance, config);
	if (appearance === state.appearance && themeName === state.themeName) return;

	const result = ctx.ui.setTheme(themeName);
	if (!result.success) {
		ctx.ui.setStatus("auto-dark-mode", `auto-theme:error ${themeName}`);
		ctx.ui.notify(`auto-dark-mode: failed to set theme '${themeName}': ${result.error ?? "unknown error"}`, "error");
		return;
	}

	state.appearance = appearance;
	state.themeName = themeName;
	ctx.ui.setStatus("auto-dark-mode", formatStatus(appearance, themeName));

	if (config.notify) {
		ctx.ui.notify(`auto-dark-mode: ${appearance} -> ${themeName}`, "info");
	}
}

export default function autoDarkMode(pi: ExtensionAPI) {
	let intervalId: ReturnType<typeof setInterval> | undefined;
	let running = false;
	const state: { appearance?: Appearance; themeName?: string } = {};

	async function runSync(ctx: ExtensionContext, config: Config): Promise<void> {
		if (running) return;
		running = true;
		try {
			await syncTheme(ctx, config, state);
		} finally {
			running = false;
		}
	}

	function stop(): void {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		stop();
		const config = loadConfig(ctx.cwd);
		await runSync(ctx, config);

		intervalId = setInterval(() => {
			void runSync(ctx, config);
		}, config.intervalMs);
	});

	pi.on("session_shutdown", () => {
		stop();
	});

	pi.registerCommand("auto-theme", {
		description: "Show or configure automatic dark/light theme switching",
		getArgumentCompletions: (prefix) => {
			const commands = ["status", "pick", "dark ", "light "];
			const matches = commands.filter((command) => command.startsWith(prefix));
			return matches.length ? matches.map((value) => ({ value, label: value.trim() || value })) : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;

			const [command, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const config = loadConfig(ctx.cwd);
			const availableThemes = ctx.ui.getAllThemes().map((theme) => theme.name);

			if (command === "dark" || command === "light") {
				const themeName = rest.join(" ").trim();
				if (!themeName) {
					ctx.ui.notify(`Usage: /auto-theme ${command} <theme>`, "warning");
					return;
				}
				if (!ctx.ui.getTheme(themeName)) {
					ctx.ui.notify(`auto-dark-mode: unknown theme '${themeName}'`, "error");
					return;
				}

				const key = command === "dark" ? "darkTheme" : "lightTheme";
				const path = writeConfigValue(ctx.cwd, key, themeName);
				ctx.ui.notify(`auto-dark-mode: saved ${command} theme '${themeName}' to ${path}`, "info");
				state.appearance = undefined;
				await runSync(ctx, loadConfig(ctx.cwd));
				return;
			}

			if (command === "pick") {
				const darkTheme = await ctx.ui.select("Dark mode theme", availableThemes);
				if (!darkTheme) return;
				const lightTheme = await ctx.ui.select("Light mode theme", availableThemes);
				if (!lightTheme) return;

				writeConfigValue(ctx.cwd, "darkTheme", darkTheme);
				const path = writeConfigValue(ctx.cwd, "lightTheme", lightTheme);
				ctx.ui.notify(`auto-dark-mode: saved themes to ${path}`, "info");
				state.appearance = undefined;
				await runSync(ctx, loadConfig(ctx.cwd));
				return;
			}

			if (command && command !== "status") {
				ctx.ui.notify("Usage: /auto-theme [status|pick|dark <theme>|light <theme>]", "warning");
				return;
			}

			const appearance = await getMacAppearance();
			const target = appearance ? themeForAppearance(appearance, config) : "unsupported";
			ctx.ui.notify(
				`auto-dark-mode: ${appearance ?? "unsupported"} -> ${target} (dark=${config.darkTheme}, light=${config.lightTheme}, interval=${config.intervalMs}ms)`,
				"info",
			);
		},
	});
}
