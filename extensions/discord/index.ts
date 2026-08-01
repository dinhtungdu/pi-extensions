import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DiscordBridge, inboundMessageId, stripInboundMarker, type BridgeSession } from "./bridge.js";
import {
	DISCORD_CONFIG_FILE,
	type DiscordBridgeConfig,
	type RelayPaths,
	loadDiscordConfig,
	relayPaths,
	saveDiscordConfig,
} from "./config.js";
import { DiscordStateStore } from "./state.js";
import { DiscordJsTransport, type DiscordTransport } from "./transport.js";
import { runRelayChild } from "./relay-child.js";
import { launchRelayChild } from "./relay-launcher.js";
import { resolveProjectIdentity } from "./project-identity.js";
import { PACKAGE_FOOTER_STATUS_KEYS } from "../footer-status.js";

const STATUS_KEY = PACKAGE_FOOTER_STATUS_KEYS.discord;
const STATUS_CONNECTED = "💬";
const STATUS_RECONNECTING = "🔄";
const STATUS_ERROR = "⚠️";
const ACCEPTED_INBOUND_ENTRY = "discord-bridge-inbound-accepted";

type ConfigLoader = () => Promise<DiscordBridgeConfig | null>;

export interface DiscordExtensionDependencies {
	loadConfig?: ConfigLoader;
	saveConfig?: (config: Omit<DiscordBridgeConfig, "epoch"> | DiscordBridgeConfig) => Promise<void>;
	paths?: RelayPaths;
	createStateStore?: () => DiscordStateStore;
	createTransport?: () => DiscordTransport;
	launchRelay?: () => Promise<void>;
	restartRelay?: (expectedPid: number, expectedNonce?: string) => Promise<void>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createDiscordExtension(dependencies: DiscordExtensionDependencies = {}) {
	const loadConfig = dependencies.loadConfig ?? (() => loadDiscordConfig());
	const saveConfig = dependencies.saveConfig ?? ((config) => saveDiscordConfig(config));
	const paths = dependencies.paths ?? relayPaths();
	const createStateStore = dependencies.createStateStore ?? (() => new DiscordStateStore());
	const createTransport = dependencies.createTransport ?? (() => new DiscordJsTransport());
	let inProcessRelay: Promise<boolean> | undefined;
	const launchRelay = dependencies.launchRelay ?? (dependencies.createStateStore || dependencies.createTransport
		? async () => {
			if (!inProcessRelay) {
				inProcessRelay = runRelayChild(paths, { createStateStore, createTransport }).finally(() => {
					inProcessRelay = undefined;
				});
			}
		}
		: () => launchRelayChild(paths));

	return function discordExtension(pi: ExtensionAPI): void {
		let bridge: DiscordBridge | undefined;
		let operation: Promise<void> = Promise.resolve();
		const inboundAcceptanceTimers = new Set<ReturnType<typeof setTimeout>>();

		async function sessionFrom(ctx: ExtensionContext): Promise<BridgeSession> {
			return {
				cwd: await resolveProjectIdentity(ctx.cwd),
				projectIdentityResolved: true,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionName: pi.getSessionName(),
			};
		}

		function setConnectedStatus(ctx: ExtensionContext): void {
			const status = bridge?.status();
			ctx.ui.setStatus(
				STATUS_KEY,
				status?.connected ? STATUS_CONNECTED : undefined,
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
				ctx.ui.setStatus(STATUS_KEY, STATUS_ERROR);
				ctx.ui.notify(errorMessage(error), "error");
				return;
			}
			if (!config) {
				if (notifyMissing) ctx.ui.notify(`Discord bridge is not configured. Run /discord setup. Config: ${DISCORD_CONFIG_FILE}`, "warning");
				return;
			}

			const candidate = new DiscordBridge(
				config,
				await sessionFrom(ctx),
				{
					onUserText(text) {
						if (ctx.isIdle()) pi.sendUserMessage(text);
						else pi.sendUserMessage(text, { deliverAs: "followUp" });
					},
					onError(error) {
						ctx.ui.setStatus(STATUS_KEY, STATUS_ERROR);
						ctx.ui.notify(`Discord bridge: ${error.message}`, "error");
					},
					onStatus(status) {
						ctx.ui.setStatus(
							STATUS_KEY,
							status.connected ? STATUS_CONNECTED : STATUS_RECONNECTING,
						);
					},
				},
				{
					paths,
					reloadConfig: async () => (await loadConfig()) ?? config!,
					launchRelay,
					...(dependencies.restartRelay ? { restartRelay: dependencies.restartRelay } : {}),
				},
			);
			const acceptedIds = ctx.sessionManager.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === ACCEPTED_INBOUND_ENTRY)
				.map((entry) => (entry as { data?: { messageId?: unknown } }).data?.messageId)
				.filter((id): id is string => typeof id === "string");
			candidate.restoreAcceptedInbound(acceptedIds);
			try {
				bridge = candidate;
				await candidate.start();
				setConnectedStatus(ctx);
			} catch (error) {
				await candidate.stop().catch(() => {});
				bridge = undefined;
				ctx.ui.setStatus(STATUS_KEY, STATUS_ERROR);
				ctx.ui.notify(`Discord bridge failed: ${errorMessage(error)}`, "error");
			}
		}

		function serialize(action: () => Promise<void>): Promise<void> {
			const next = operation.then(action, action);
			operation = next.catch(() => {});
			return next;
		}

		async function restartRelay(ctx: ExtensionCommandContext): Promise<void> {
			const active = bridge;
			const previousPid = active?.status().leaderPid;
			if (!active || !previousPid) {
				ctx.ui.notify("Discord relay restart failed: bridge is disconnected; run /discord reconnect first", "error");
				return;
			}
			try {
				const status = await active.restartRelay();
				ctx.ui.notify(`Discord relay restarted: PID ${previousPid} replaced by PID ${status.leaderPid}`, "info");
			} catch (error) {
				ctx.ui.notify(`Discord relay restart failed: ${errorMessage(error)}`, "error");
			}
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
			for (const timer of inboundAcceptanceTimers) clearTimeout(timer);
			inboundAcceptanceTimers.clear();
			await serialize(() => stopBridge(ctx));
		});

		pi.on("input", async (event, ctx) => {
			if (event.source === "extension" || !bridge) return { action: "continue" };
			try {
				await bridge.mirrorUserText(event.text, event.source === "interactive");
			} catch (error) {
				ctx.ui.notify(`Discord user-message mirror failed: ${errorMessage(error)}`, "error");
			}
			return { action: "continue" };
		});

		pi.on("context", (event) => ({
			messages: event.messages.map((message) => {
				if (message.role !== "user") return message;
				if (typeof message.content === "string") return { ...message, content: stripInboundMarker(message.content) };
				return {
					...message,
					content: message.content.map((part) => part.type === "text" ? { ...part, text: stripInboundMarker(part.text) } : part),
				};
			}),
		}));

		pi.on("before_agent_start", (event) => {
			bridge?.beginAgentRun(inboundMessageId(event.prompt));
		});

		pi.on("agent_start", () => {
			bridge?.agentStarted();
		});

		pi.on("message_start", (event) => {
			if (event.message.role !== "user") return;
			const text = typeof event.message.content === "string"
				? event.message.content
				: event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			bridge?.userMessageStarted(inboundMessageId(text));
		});

		pi.on("tool_execution_start", () => {
			bridge?.toolStarted();
		});

		pi.on("agent_end", (event, ctx) => {
			bridge?.agentEnded(event.messages, ctx.signal?.aborted === true);
		});

		pi.on("message_end", (event, ctx) => {
			if (event.message.role === "assistant") {
				bridge?.captureAssistantMessage(event.message);
				return;
			}
			if (event.message.role !== "user" || !bridge) return;
			const text = typeof event.message.content === "string"
				? event.message.content
				: event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			const messageId = inboundMessageId(text);
			if (!messageId) return;
			const acceptingBridge = bridge;
			// Pi 0.83 persists the user message immediately after message_end handlers return.
			const timer = setTimeout(() => {
				inboundAcceptanceTimers.delete(timer);
				pi.appendEntry(ACCEPTED_INBOUND_ENTRY, { messageId });
				void acceptingBridge.confirmInboundAccepted(messageId).catch((error) => {
					ctx.ui.notify(`Discord inbound acknowledgement deferred: ${errorMessage(error)}`, "warning");
				});
			}, 0);
			inboundAcceptanceTimers.add(timer);
		});

		pi.on("agent_settled", async (_event, ctx) => {
			bridge?.settleAgentRun();
			try {
				await bridge?.flushSettledAssistant();
			} catch (error) {
				ctx.ui.notify(`Discord assistant-message mirror failed: ${errorMessage(error)}`, "error");
			}
		});

		pi.registerCommand("discord", {
			description: "Configure or inspect the automatic Discord project/session bridge",
			getArgumentCompletions: (prefix) => {
				const values = ["setup", "status", "reconnect", "restart"];
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
				if (command === "restart") {
					await serialize(() => restartRelay(ctx));
					return;
				}
				if (command === "status") {
					const status = bridge?.status();
					ctx.ui.notify(
						status?.connected
							? `Discord bridge connected through local relay PID ${status.leaderPid}\nProject channel: ${status.channelId}\nSession thread: ${status.threadId}`
							: `Discord bridge disconnected\nConfig: ${DISCORD_CONFIG_FILE}`,
						"info",
					);
					return;
				}
				ctx.ui.notify("Usage: /discord [setup|status|reconnect|restart]", "warning");
			},
		});
	};
}

export default createDiscordExtension();
