import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DiscordBridge, type BridgeSession } from "./bridge.js";
import {
	DISCORD_CONFIG_FILE,
	type DiscordBridgeConfig,
	loadDiscordConfig,
	saveDiscordConfig,
} from "./config.js";
import { DiscordStateStore } from "./state.js";
import { DiscordJsTransport, type DiscordTransport } from "./transport.js";

const STATUS_KEY = "discord-bridge";

type ConfigLoader = () => Promise<DiscordBridgeConfig | null>;

export interface DiscordExtensionDependencies {
	loadConfig?: ConfigLoader;
	saveConfig?: (config: DiscordBridgeConfig) => Promise<void>;
	createStateStore?: () => DiscordStateStore;
	createTransport?: () => DiscordTransport;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createDiscordExtension(dependencies: DiscordExtensionDependencies = {}) {
	const loadConfig = dependencies.loadConfig ?? (() => loadDiscordConfig());
	const saveConfig = dependencies.saveConfig ?? ((config) => saveDiscordConfig(config));
	const createStateStore = dependencies.createStateStore ?? (() => new DiscordStateStore());
	const createTransport = dependencies.createTransport ?? (() => new DiscordJsTransport());

	return function discordExtension(pi: ExtensionAPI): void {
		let bridge: DiscordBridge | undefined;
		let operation: Promise<void> = Promise.resolve();

		function sessionFrom(ctx: ExtensionContext): BridgeSession {
			return {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionName: pi.getSessionName(),
			};
		}

		function setConnectedStatus(ctx: ExtensionContext): void {
			const status = bridge?.status();
			ctx.ui.setStatus(
				STATUS_KEY,
				status?.connected ? `Discord ${status.channelId}/${status.threadId}` : undefined,
			);
		}

		async function stopBridge(ctx: ExtensionContext): Promise<void> {
			const active = bridge;
			bridge = undefined;
			await active?.stop();
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}

		async function startBridge(ctx: ExtensionContext, notifyMissing: boolean): Promise<void> {
			await stopBridge(ctx);
			let config: DiscordBridgeConfig | null;
			try {
				config = await loadConfig();
			} catch (error) {
				ctx.ui.setStatus(STATUS_KEY, "Discord error");
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}
			if (!config) {
				if (notifyMissing) ctx.ui.notify(`Discord bridge is not configured. Run /discord setup. Config: ${DISCORD_CONFIG_FILE}`, "warning");
				return;
			}

			const candidate = new DiscordBridge(
				config,
				sessionFrom(ctx),
				createStateStore(),
				createTransport(),
				{
					onUserText(text) {
						if (ctx.isIdle()) pi.sendUserMessage(text);
						else pi.sendUserMessage(text, { deliverAs: "followUp" });
					},
					onError(error) {
						ctx.ui.notify(`Discord bridge: ${error.message}`, "error");
					},
				},
			);
			try {
				bridge = candidate;
				await candidate.start();
				setConnectedStatus(ctx);
			} catch (error) {
				bridge = undefined;
				ctx.ui.setStatus(STATUS_KEY, "Discord error");
				ctx.ui.notify(`Discord bridge failed: ${errorMessage(error)}`, "error");
			}
		}

		function serialize(action: () => Promise<void>): Promise<void> {
			const next = operation.then(action, action);
			operation = next.catch(() => {});
			return next;
		}

		async function setup(ctx: ExtensionCommandContext): Promise<void> {
			let existing: DiscordBridgeConfig | null = null;
			try {
				existing = await loadConfig();
			} catch {
				// Setup replaces an unreadable configuration only after collecting a complete valid replacement.
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(`Edit ${DISCORD_CONFIG_FILE} or set DISCORD_TOKEN and DISCORD_GUILD_ID.`, "warning");
				return;
			}
			const tokenInput = await ctx.ui.input(
				existing ? "Discord bot token (leave blank to keep current token)" : "Discord bot token",
			);
			const token = tokenInput?.trim() || existing?.token;
			if (!token) return;
			const guildInput = await ctx.ui.input("Discord guild ID", existing?.guildId ?? "");
			const guildId = guildInput?.trim();
			if (!guildId) return;
			const categoryInput = await ctx.ui.input(
				"Discord category ID (optional; blank creates project channels at guild root)",
				existing?.categoryId ?? "",
			);
			const categoryId = categoryInput?.trim() || undefined;
			try {
				await saveConfig({ token, guildId, categoryId });
				ctx.ui.notify(`Discord bridge config saved to ${DISCORD_CONFIG_FILE}`, "info");
				await startBridge(ctx, true);
			} catch (error) {
				ctx.ui.notify(`Discord bridge setup failed: ${errorMessage(error)}`, "error");
			}
		}

		pi.on("session_start", async (_event, ctx) => {
			await serialize(() => startBridge(ctx, false));
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			await serialize(() => stopBridge(ctx));
		});

		pi.on("input", async (event, ctx) => {
			if (event.source === "extension" || !bridge) return { action: "continue" };
			try {
				await bridge.mirrorUserText(event.text);
			} catch (error) {
				ctx.ui.notify(`Discord user-message mirror failed: ${errorMessage(error)}`, "error");
			}
			return { action: "continue" };
		});

		pi.on("before_agent_start", () => {
			bridge?.beginAgentRun();
		});

		pi.on("message_end", (event) => {
			bridge?.captureAssistantMessage(event.message);
		});

		pi.on("agent_settled", async (_event, ctx) => {
			try {
				await bridge?.flushSettledAssistant();
			} catch (error) {
				ctx.ui.notify(`Discord assistant-message mirror failed: ${errorMessage(error)}`, "error");
			}
		});

		pi.registerCommand("discord", {
			description: "Configure or inspect the automatic Discord project/session bridge",
			getArgumentCompletions: (prefix) => {
				const values = ["setup", "status", "reconnect"];
				const matches = values.filter((value) => value.startsWith(prefix));
				return matches.length ? matches.map((value) => ({ value, label: value })) : null;
			},
			handler: async (args, ctx) => {
				const command = args.trim().toLowerCase() || "status";
				if (command === "setup") {
					await serialize(() => setup(ctx));
					return;
				}
				if (command === "reconnect") {
					await serialize(() => startBridge(ctx, true));
					return;
				}
				if (command === "status") {
					const status = bridge?.status();
					ctx.ui.notify(
						status?.connected
							? `Discord bridge connected\nProject channel: ${status.channelId}\nSession thread: ${status.threadId}`
							: `Discord bridge disconnected\nConfig: ${DISCORD_CONFIG_FILE}`,
						"info",
					);
					return;
				}
				ctx.ui.notify("Usage: /discord [setup|status|reconnect]", "warning");
			},
		});
	};
}

export default createDiscordExtension();
