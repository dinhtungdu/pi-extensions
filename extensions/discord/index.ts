import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
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
import { resolveProjectContext } from "./project-identity.js";
import { discoverTaskTitle } from "./task-title.js";
import { PACKAGE_FOOTER_STATUS_KEYS } from "../footer-status.js";
import { ManagerTaskSummaryProducer } from "./manager-task-summary.js";
import { ManagerControlExecutor } from "./manager-controls.js";
import {
	MAX_MODEL_CATALOGUE_ITEMS,
	MAX_SESSION_CONTROL_TEXT_LENGTH,
	boundedControlResult,
	isManagerTaskAction,
	modelChoiceValue,
	type ManagerProjectCatalogueEntry,
	type ManagerTaskCatalogueEntry,
	type PiManagerControlRequest,
	type PiModelCatalogueEntry,
	type PiSessionControlRequest,
	type PiSessionControlResult,
} from "./controls.js";

const STATUS_KEY = PACKAGE_FOOTER_STATUS_KEYS.discord;
const STATUS_CONNECTED = "💬";
const STATUS_RECONNECTING = "🔄";
const STATUS_ERROR = "⚠️";
const ACCEPTED_INBOUND_ENTRY = "discord-bridge-inbound-accepted";
export const MANAGER_CONTROL_RESULT_ENTRY = "discord-manager-control-result";

interface ManagerControlResultEntryData {
	action: Exclude<PiManagerControlRequest["action"], "ask">;
	taskId?: string;
	ok: boolean;
	message: string;
}

function compactEntry(text: string) {
	return {
		render: (width: number) => [truncateToWidth(text, width)],
		invalidate() {},
	};
}

type ConfigLoader = () => Promise<DiscordBridgeConfig | null>;

function isDescendantPath(root: string, candidate: string): boolean {
	const pathFromRoot = relative(resolve(root), resolve(candidate));
	return pathFromRoot !== "" && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

export function shouldAutoStartDiscordBridge(cwd: string, home = homedir()): boolean {
	return [join(home, "workspace"), join(home, "worktrees")].some((root) => isDescendantPath(root, cwd));
}

export function shouldPublishManagerTaskSummary(checkoutRoot: string): boolean {
	return basename(resolve(checkoutRoot)) === "the-manager";
}

export interface DiscordExtensionDependencies {
	loadConfig?: ConfigLoader;
	saveConfig?: (config: Omit<DiscordBridgeConfig, "epoch"> | DiscordBridgeConfig) => Promise<void>;
	paths?: RelayPaths;
	createStateStore?: () => DiscordStateStore;
	createTransport?: () => DiscordTransport;
	launchRelay?: () => Promise<void>;
	restartRelay?: (expectedPid: number, expectedNonce?: string) => Promise<void>;
	autoStartForCwd?: (cwd: string) => boolean;
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
	const autoStartForCwd = dependencies.autoStartForCwd ?? shouldAutoStartDiscordBridge;
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
		try {
			pi.registerEntryRenderer<ManagerControlResultEntryData>(MANAGER_CONTROL_RESULT_ENTRY, (entry, _options, theme) => {
				try {
					const data: unknown = entry.data;
					if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid manager control result");
					const result = data as Partial<ManagerControlResultEntryData>;
					if (!isManagerTaskAction(result.action) || typeof result.ok !== "boolean" ||
						typeof result.message !== "string" || !result.message ||
						result.message.length > MAX_SESSION_CONTROL_TEXT_LENGTH ||
						(result.taskId !== undefined && (typeof result.taskId !== "string" || result.taskId.length > 100 ||
							!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.taskId)))) {
						throw new Error("invalid manager control result");
					}
					const status = result.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const task = result.taskId ? ` @${result.taskId}` : "";
					const message = result.message.replace(/\s+/g, " ");
					return compactEntry(`${status} ${theme.fg("accent", `/m ${result.action}${task}`)} — ${message}`);
				} catch {
					return compactEntry("⚠ /m result unavailable");
				}
			});
		} catch {
			// History rendering is optional; manager controls must remain available without it.
		}

		let bridge: DiscordBridge | undefined;
		let taskSummaryProducer: ManagerTaskSummaryProducer | undefined;
		let managerTaskCatalogue: ManagerTaskCatalogueEntry[] = [];
		let managerProjectCatalogue: ManagerProjectCatalogueEntry[] = [];
		let desiredTaskSummary: string | undefined;
		let publishingTaskSummary: Promise<void> | undefined;
		let taskSummaryPublishRequested = false;
		let operation: Promise<void> = Promise.resolve();
		const inboundAcceptanceTimers = new Set<ReturnType<typeof setTimeout>>();

		function modelCatalogue(ctx: ExtensionContext): PiModelCatalogueEntry[] {
			const scoped = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
			const models = ctx.model ? [ctx.model, ...scoped] : scoped;
			const seen = new Set<string>();
			const catalogue: PiModelCatalogueEntry[] = [];
			for (const model of models) {
				const entry = { provider: model.provider, id: model.id, name: model.name || model.id };
				const key = `${entry.provider}\0${entry.id}`;
				if (seen.has(key) || entry.provider.length > 100 || entry.id.length > 200 || entry.name.length > 200 || modelChoiceValue(entry).length > 100) continue;
				seen.add(key);
				catalogue.push(entry);
				if (catalogue.length >= MAX_MODEL_CATALOGUE_ITEMS) break;
			}
			return catalogue;
		}

		async function executeSessionControl(
			request: PiSessionControlRequest,
			ctx: ExtensionContext,
		): Promise<PiSessionControlResult> {
			const action = request.action;
			if (action.type === "status") {
				const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
				return {
					ok: true,
					message: [
						`Pi session: ${ctx.isIdle() ? "idle" : "busy"}`,
						`Model: ${model}`,
						`Thinking: ${pi.getThinkingLevel()}`,
						`Queued messages: ${ctx.hasPendingMessages() ? "yes" : "no"}`,
					].join("\n"),
				};
			}
			if (action.type === "model") {
				if (!ctx.isIdle()) return { ok: false, message: "Model cannot change while Pi is busy." };
				const model = ctx.modelRegistry.find(action.provider, action.modelId);
				if (!model || !modelCatalogue(ctx).some((entry) => entry.provider === action.provider && entry.id === action.modelId)) {
					return { ok: false, message: `Model is unavailable: ${action.provider}/${action.modelId}` };
				}
				if (!await pi.setModel(model)) return { ok: false, message: `No configured authentication for ${action.provider}/${action.modelId}.` };
				return { ok: true, message: `Model set to ${action.provider}/${action.modelId}. This updates Pi's persisted default.` };
			}
			if (action.type === "thinking") {
				if (!ctx.isIdle()) return { ok: false, message: "Thinking level cannot change while Pi is busy." };
				pi.setThinkingLevel(action.level);
				return { ok: true, message: `Thinking set to ${pi.getThinkingLevel()}. This updates Pi's persisted default.` };
			}
			if (action.type === "steer") {
				pi.sendUserMessage(action.text, { deliverAs: "steer" });
				return { ok: true, message: "Steering message queued." };
			}
			if (action.type === "followup") {
				pi.sendUserMessage(action.text, { deliverAs: "followUp" });
				return { ok: true, message: "Follow-up message queued." };
			}
			if (ctx.isIdle()) return { ok: false, message: "Pi is idle; there is no active turn to abort." };
			ctx.abort();
			return { ok: true, message: "Abort requested; queued messages were not discarded." };
		}

		async function sessionFrom(ctx: ExtensionContext): Promise<{ session: BridgeSession; checkoutRoot: string }> {
			const project = await resolveProjectContext(ctx.cwd);
			return {
				checkoutRoot: project.checkoutRoot,
				session: {
					cwd: project.projectIdentity,
					projectIdentityResolved: true,
					sessionId: ctx.sessionManager.getSessionId(),
					sessionName: pi.getSessionName() ?? await discoverTaskTitle(project.checkoutRoot),
				},
			};
		}

		function publishTaskSummary(ctx: ExtensionContext): void {
			if (!desiredTaskSummary || !bridge?.status().projectSummaries) return;
			if (publishingTaskSummary) {
				taskSummaryPublishRequested = true;
				return;
			}
			publishingTaskSummary = (async () => {
				do {
					taskSummaryPublishRequested = false;
					const active = bridge;
					const summary = desiredTaskSummary;
					if (!active || !summary || !active.status().projectSummaries) return;
					try {
						await active.publishProjectSummary(summary);
					} catch (error) {
						ctx.ui.notify(`Discord task-summary update deferred: ${errorMessage(error)}`, "warning");
						return;
					}
				} while (taskSummaryPublishRequested);
			})().finally(() => {
				publishingTaskSummary = undefined;
				if (taskSummaryPublishRequested) publishTaskSummary(ctx);
			});
		}

		function setConnectedStatus(ctx: ExtensionContext): void {
			const status = bridge?.status();
			ctx.ui.setStatus(
				STATUS_KEY,
				status?.connected ? STATUS_CONNECTED : undefined,
			);
		}

		async function stopBridge(ctx: ExtensionContext): Promise<void> {
			taskSummaryProducer?.stop();
			taskSummaryProducer = undefined;
			managerTaskCatalogue = [];
			managerProjectCatalogue = [];
			desiredTaskSummary = undefined;
			taskSummaryPublishRequested = false;
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

			const { session, checkoutRoot } = await sessionFrom(ctx);
			let managerExecutor: ManagerControlExecutor | undefined;
			try {
				managerExecutor = await ManagerControlExecutor.create(checkoutRoot);
			} catch (error) {
				ctx.ui.notify(`Discord manager controls disabled: ${errorMessage(error)}`, "warning");
			}
			const publishManagerTaskSummary = shouldPublishManagerTaskSummary(checkoutRoot);
			const managerProducer = await ManagerTaskSummaryProducer.create(checkoutRoot, {
				onSummary(summary) {
					if (!publishManagerTaskSummary) return;
					desiredTaskSummary = summary;
					publishTaskSummary(ctx);
				},
				onCatalogues(tasks, projects) {
					managerTaskCatalogue = tasks;
					managerProjectCatalogue = projects;
					void bridge?.updateManagerCatalogues(tasks, projects).catch((error) => {
						ctx.ui.notify(`Discord manager catalogue update deferred: ${errorMessage(error)}`, "warning");
					});
				},
				onError(error) {
					ctx.ui.notify(`Discord task-summary producer: ${error.message}`, "warning");
				},
			});
			const candidate = new DiscordBridge(
				config,
				session,
				{
					onUserMessage(content) {
						if (ctx.isIdle()) pi.sendUserMessage(content);
						else pi.sendUserMessage(content, { deliverAs: "followUp" });
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
						if (status.connected) publishTaskSummary(ctx);
					},
					supportsImageInput: () => ctx.model?.input?.includes("image") === true,
					modelCatalogue: () => modelCatalogue(ctx),
					onControl: (request) => executeSessionControl(request, ctx),
					...(managerExecutor && managerProducer ? {
						managerTaskCatalogue: () => managerTaskCatalogue,
						managerProjectCatalogue: () => managerProjectCatalogue,
						onManagerControl: async (request) => {
							let result: PiSessionControlResult;
							try {
								result = boundedControlResult(await managerExecutor!.execute(
									request,
									managerTaskCatalogue,
									managerProjectCatalogue,
									(message) => {
										if (ctx.isIdle()) pi.sendUserMessage(message);
										else pi.sendUserMessage(message, { deliverAs: "followUp" });
									},
								));
							} catch (error) {
								result = boundedControlResult({ ok: false, message: errorMessage(error) });
							}
							if (request.action !== "ask") {
								try {
									pi.appendEntry<ManagerControlResultEntryData>(MANAGER_CONTROL_RESULT_ENTRY, {
										action: request.action,
										...(request.taskId ? { taskId: request.taskId } : {}),
										...result,
									});
								} catch {
									// Session history is best-effort and must not alter the Discord result.
								}
								managerProducer.requestRefresh(0);
							}
							return result;
						},
					} : {}),
				},
				{
					paths,
					reloadConfig: async () => (await loadConfig()) ?? config!,
					launchRelay,
					...(dependencies.restartRelay ? { restartRelay: dependencies.restartRelay } : {}),
				},
			);
			const acceptedMessages = ctx.sessionManager.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === ACCEPTED_INBOUND_ENTRY)
				.map((entry) => (entry as { data?: { messageId?: unknown; hasImages?: unknown } }).data)
				.filter((data): data is { messageId: string; hasImages?: unknown } => typeof data?.messageId === "string")
				.map((data) => ({ messageId: data.messageId, hasImages: data.hasImages === true }));
			candidate.restoreAcceptedInbound(acceptedMessages);
			try {
				bridge = candidate;
				await candidate.start();
				setConnectedStatus(ctx);
				taskSummaryProducer = managerProducer;
				taskSummaryProducer?.start();
			} catch (error) {
				managerProducer?.stop();
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
			await serialize(() => autoStartForCwd(ctx.cwd) ? startBridge(ctx, false) : stopBridge(ctx));
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
			const hasImages = acceptingBridge.hasInboundImages(messageId);
			// Pi 0.83 persists the user message immediately after message_end handlers return.
			const timer = setTimeout(() => {
				inboundAcceptanceTimers.delete(timer);
				pi.appendEntry(ACCEPTED_INBOUND_ENTRY, { messageId, hasImages });
				void acceptingBridge.confirmInboundAccepted(messageId).catch((error) => {
					ctx.ui.notify(`Discord inbound acknowledgement deferred: ${errorMessage(error)}`, "warning");
				});
			}, 0);
			inboundAcceptanceTimers.add(timer);
		});

		pi.on("agent_settled", async (_event, ctx) => {
			try {
				await bridge?.settleAgentRun();
			} catch (error) {
				ctx.ui.notify(`Discord settled-image cleanup deferred: ${errorMessage(error)}`, "warning");
			}
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
					const activationHint = autoStartForCwd(ctx.cwd)
						? ""
						: "\nAutomatic activation is limited to subdirectories of ~/workspace and ~/worktrees. Run /discord reconnect to enable this session.";
					ctx.ui.notify(
						status?.connected
							? `Discord bridge connected through local relay PID ${status.leaderPid}\nProject channel: ${status.channelId}\nSession thread: ${status.threadId}`
							: `Discord bridge disconnected\nConfig: ${DISCORD_CONFIG_FILE}${activationHint}`,
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
