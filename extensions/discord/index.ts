import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DiscordBridge, inboundMessageId, stripInboundMarker, type BridgeSession } from "./bridge.js";
import { SettledReplyCollector, type SettledReply } from "./outbound-images.js";
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
import { ManagerPresentationProducer, type ManagerPresentation } from "./manager-presentation.js";
import { ManagerPresentationControlExecutor } from "./manager-presentation-controls.js";
import { managerWakeRegistration } from "./manager-wake.js";
import { acceptedManagerTaskSnapshot, type ManagerTaskSnapshot } from "./manager-task-snapshot.js";
import { isManagerTaskTerminal, type ManagerTaskTerminal } from "./manager-task-terminal.js";
import {
	MAX_MODEL_CATALOGUE_ITEMS,
	boundedControlResult,
	modelChoiceValue,
	type PiModelCatalogueEntry,
	type PiSessionControlRequest,
	type PiSessionControlResult,
} from "./controls.js";

const STATUS_KEY = PACKAGE_FOOTER_STATUS_KEYS.discord;
const STATUS_CONNECTED = "💬";
const STATUS_RECONNECTING = "🔄";
const STATUS_ERROR = "⚠️";
const ACCEPTED_INBOUND_ENTRY = "discord-bridge-inbound-accepted";
const MANAGER_SUMMARY_COMMAND = "/github-refresh-reconcile";

interface ManagerSummaryTurn {
	origin: "tui" | "discord";
	awaitingInput: boolean;
	started: boolean;
	ended: boolean;
	failed: boolean;
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

export function shouldSubscribeOwnerToTaskLeadThread(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment.THE_MANAGER_ROLE === "task-lead";
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
	environment?: NodeJS.ProcessEnv;
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
	const environment = dependencies.environment ?? process.env;
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
		let presentationProducer: ManagerPresentationProducer | undefined;
		let managerSummaryTurn: ManagerSummaryTurn | undefined;
		let desiredPresentation: ManagerPresentation | undefined;
		let publishingPresentation: Promise<void> | undefined;
		let presentationPublishRequested = false;
		let desiredTaskSnapshot: ManagerTaskSnapshot | undefined;
		let publishingTaskSnapshot: Promise<void> | undefined;
		let taskSnapshotPublishRequested = false;
		const pendingTaskTerminals = new Map<string, ManagerTaskTerminal>();
		let publishingTaskTerminals: Promise<void> | undefined;
		let currentCtx: ExtensionContext | undefined;
		let operation: Promise<void> = Promise.resolve();
		const inboundAcceptanceTimers = new Set<ReturnType<typeof setTimeout>>();
		const settledReplies = new SettledReplyCollector();

		const deliverSettledReplies = async (replies: readonly SettledReply[], ctx: ExtensionContext): Promise<void> => {
			if (!bridge) return;
			for (const reply of replies) try {
				await bridge.enqueueAssistantMessage(reply.messageId, reply.text, reply.images, reply.responseTo);
			} catch (error) {
				ctx.ui.notify(`Discord assistant-message mirror failed: ${errorMessage(error)}`, "error");
			}
		};

		const unsubscribeTaskSnapshots = pi.events.on("manager:task-snapshot", (value) => {
			const snapshot = acceptedManagerTaskSnapshot(environment, value);
			if (!snapshot || desiredTaskSnapshot?.revision === snapshot.revision) return;
			desiredTaskSnapshot = snapshot;
			if (currentCtx) publishTaskSnapshot(currentCtx);
		});
		const unsubscribeTaskTerminals = pi.events.on("manager:task-terminal", (value) => {
			if (!isManagerTaskTerminal(value) ||
				(currentCtx && !shouldPublishManagerTaskSummary(currentCtx.cwd)) || pendingTaskTerminals.has(value.revision)) return;
			pendingTaskTerminals.set(value.revision, structuredClone(value));
			if (currentCtx) publishTaskTerminals(currentCtx);
		});

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
			const managerWake = managerWakeRegistration(environment);
			return {
				checkoutRoot: project.checkoutRoot,
				session: {
					cwd: project.projectIdentity,
					projectIdentityResolved: true,
					sessionId: ctx.sessionManager.getSessionId(),
					sessionName: pi.getSessionName() ?? await discoverTaskTitle(project.checkoutRoot),
					...(managerWake !== undefined ? { managerWake } : {}),
					...(environment.THE_MANAGER_ROLE === "task-lead" && environment.THE_MANAGER_TASK_ID
						? { managerTaskSnapshotTaskId: environment.THE_MANAGER_TASK_ID } : {}),
					...(shouldSubscribeOwnerToTaskLeadThread(environment) ? { subscribeOwnerToThread: true as const } : {}),
				},
			};
		}

		function publishPresentation(ctx: ExtensionContext): void {
			if (!desiredPresentation || !bridge?.status().managerPresentation) return;
			if (publishingPresentation) {
				presentationPublishRequested = true;
				return;
			}
			publishingPresentation = (async () => {
				do {
					presentationPublishRequested = false;
					const active = bridge;
					const presentation = desiredPresentation;
					if (!active || !presentation || !active.status().managerPresentation) return;
					try {
						await active.publishManagerPresentation(presentation);
					} catch (error) {
						ctx.ui.notify(`Discord manager-presentation update deferred: ${errorMessage(error)}`, "warning");
						return;
					}
				} while (presentationPublishRequested);
			})().finally(() => {
				publishingPresentation = undefined;
				if (presentationPublishRequested) publishPresentation(ctx);
			});
		}

		function publishTaskSnapshot(ctx: ExtensionContext): void {
			if (!desiredTaskSnapshot || !bridge?.status().connected) return;
			if (publishingTaskSnapshot) {
				taskSnapshotPublishRequested = true;
				return;
			}
			publishingTaskSnapshot = (async () => {
				do {
					taskSnapshotPublishRequested = false;
					const active = bridge;
					const snapshot = desiredTaskSnapshot;
					if (!active || !snapshot || !active.status().connected) return;
					try {
						await active.publishManagerTaskSnapshot(snapshot);
					} catch (error) {
						ctx.ui.notify(`Discord manager task-snapshot update deferred: ${errorMessage(error)}`, "warning");
						return;
					}
				} while (taskSnapshotPublishRequested);
			})().finally(() => {
				publishingTaskSnapshot = undefined;
				if (taskSnapshotPublishRequested) publishTaskSnapshot(ctx);
			});
		}

		function publishTaskTerminals(ctx: ExtensionContext): void {
			if (!bridge?.status().connected || publishingTaskTerminals || !shouldPublishManagerTaskSummary(ctx.cwd)) return;
			publishingTaskTerminals = (async () => {
				while (bridge?.status().connected && pendingTaskTerminals.size > 0) {
					const [revision, terminal] = pendingTaskTerminals.entries().next().value!;
					try {
						const accepted = await bridge.publishManagerTaskTerminal(terminal);
						if (!accepted) {
							ctx.ui.notify(`Discord manager task-terminal rejected by relay for task ${terminal.taskId}`, "warning");
						}
					} catch (error) {
						ctx.ui.notify(`Discord manager task-terminal delivery deferred: ${errorMessage(error)}`, "warning");
						return;
					}
					if (pendingTaskTerminals.get(revision)?.revision === terminal.revision) pendingTaskTerminals.delete(revision);
				}
			})().finally(() => {
				publishingTaskTerminals = undefined;
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
			managerSummaryTurn = undefined;
			presentationProducer?.stop();
			presentationProducer = undefined;
			desiredPresentation = undefined;
			presentationPublishRequested = false;
			taskSnapshotPublishRequested = false;
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
			let presentationExecutor: ManagerPresentationControlExecutor | undefined;
			try {
				presentationExecutor = await ManagerPresentationControlExecutor.create(checkoutRoot);
			} catch (error) {
				ctx.ui.notify(`Discord manager-presentation controls disabled: ${errorMessage(error)}`, "warning");
			}
			const publishManagerTaskSummary = shouldPublishManagerTaskSummary(checkoutRoot);
			if (!publishManagerTaskSummary) pendingTaskTerminals.clear();
			const managerPresentationProducer = publishManagerTaskSummary ? await ManagerPresentationProducer.create(checkoutRoot, {
				onPresentation(presentation) {
					desiredPresentation = presentation;
					publishPresentation(ctx);
				},
				onUnavailable(error) {
					ctx.ui.notify(`Discord manager-presentation producer: ${error.message}`, "warning");
				},
			}) : undefined;
			const candidate = new DiscordBridge(
				config,
				{
					...session,
					...(publishManagerTaskSummary ? { managerTaskSummaryProducer: true as const } : {}),
				},
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
						if (status.connected) {
							presentationProducer?.requestRefresh(0);
							publishTaskSnapshot(ctx);
							publishTaskTerminals(ctx);
						}
					},
					supportsImageInput: () => ctx.model?.input?.includes("image") === true,
					modelCatalogue: () => modelCatalogue(ctx),
					onControl: (request) => executeSessionControl(request, ctx),
					...(managerPresentationProducer ? {
						onManagerPresentationControl: async (request) => {
							if (request.command === "task-merge-and-archive" && request.actionControl) {
								if (!presentationExecutor) return { ok: false, message: "Manager lifecycle controls are unavailable." };
								const result = boundedControlResult(await presentationExecutor.executeMerge(
									request.actionControl.taskId,
								));
								managerPresentationProducer.requestRefresh(0);
								return result;
							}
							if (request.command !== "github-refresh-reconcile") {
								return { ok: false, message: "Manager presentation control is unsupported." };
							}
							if (managerSummaryTurn || !ctx.isIdle()) {
								return { ok: false, message: "Refresh & Reconcile is already running; retry when the manager is idle." };
							}
							managerSummaryTurn = {
								origin: "discord", awaitingInput: true, started: false, ended: false, failed: false,
							};
							try {
								pi.sendUserMessage(MANAGER_SUMMARY_COMMAND);
								return { ok: true, message: "Refresh & Reconcile started in the manager Pi session." };
							} catch (error) {
								managerSummaryTurn = undefined;
								const message = `Refresh & Reconcile was not accepted: ${errorMessage(error)}`;
								ctx.ui.notify(message, "error");
								return boundedControlResult({ ok: false, message });
							}
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
				publishTaskSnapshot(ctx);
				publishTaskTerminals(ctx);
				presentationProducer = managerPresentationProducer;
				presentationProducer?.start();
			} catch (error) {
				managerPresentationProducer?.stop();
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

		pi.on("session_start", (_event, ctx) => {
			currentCtx = ctx;
			void serialize(() => autoStartForCwd(ctx.cwd) ? startBridge(ctx, false) : stopBridge(ctx));
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			settledReplies.settle();
			unsubscribeTaskSnapshots();
			unsubscribeTaskTerminals();
			for (const timer of inboundAcceptanceTimers) clearTimeout(timer);
			inboundAcceptanceTimers.clear();
			await serialize(() => stopBridge(ctx));
			if (currentCtx === ctx) currentCtx = undefined;
		});

		pi.on("input", async (event, ctx) => {
			if (event.text === MANAGER_SUMMARY_COMMAND && presentationProducer) {
				if (event.source === "extension") {
					if (managerSummaryTurn?.origin !== "discord" || !managerSummaryTurn.awaitingInput) {
						ctx.ui.notify("Refresh & Reconcile command rejected; retry manually.", "warning");
						return { action: "handled" };
					}
					managerSummaryTurn.awaitingInput = false;
				} else {
					if (managerSummaryTurn || !ctx.isIdle()) {
						ctx.ui.notify("Refresh & Reconcile is already running; retry when the manager is idle.", "warning");
						return { action: "handled" };
					}
					managerSummaryTurn = {
						origin: "tui", awaitingInput: false, started: false, ended: false, failed: false,
					};
				}
			}
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
			if (managerSummaryTurn && !managerSummaryTurn.awaitingInput) managerSummaryTurn.started = true;
			bridge?.beginAgentRun(inboundMessageId(event.prompt));
		});

		pi.on("agent_start", async (_event, ctx) => {
			try {
				await bridge?.agentStarted();
			} catch (error) {
				ctx.ui.notify(`Discord working indicator deferred: ${errorMessage(error)}`, "warning");
			}
		});

		pi.on("message_start", async (event, ctx) => {
			if (event.message.role !== "user") return;
			const text = typeof event.message.content === "string"
				? event.message.content
				: event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			try {
				await bridge?.userMessageStarted(inboundMessageId(text));
			} catch (error) {
				ctx.ui.notify(`Discord working indicator deferred: ${errorMessage(error)}`, "warning");
			}
		});

		pi.on("tool_execution_start", () => {
			bridge?.toolStarted();
		});

		pi.on("agent_end", (event, ctx) => {
			bridge?.agentEnded(event.messages, ctx.signal?.aborted === true);
			if (!managerSummaryTurn?.started) return;
			const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
			managerSummaryTurn.ended = true;
			managerSummaryTurn.failed = ctx.signal?.aborted === true || lastAssistant?.stopReason === "aborted" ||
				lastAssistant?.stopReason === "error";
		});

		pi.on("message_end", async (event, ctx) => {
			if (event.message.role === "assistant") {
				settledReplies.recordAssistant(event.message, bridge?.assistantResponseIds() ?? []);
				return;
			}
			if (event.message.role === "toolResult") {
				settledReplies.recordToolResult(event.message);
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
			let settlementFailure: unknown;
			try {
				await deliverSettledReplies(settledReplies.settle(), ctx);
				await bridge?.settleAgentRun();
			} catch (error) {
				settlementFailure = error;
				ctx.ui.notify(`Discord settled-image cleanup deferred: ${errorMessage(error)}`, "warning");
			}
			const turn = managerSummaryTurn;
			if (!turn?.started) return;
			try {
				if (settlementFailure) throw settlementFailure;
				if (!turn.ended || turn.failed) throw new Error("Refresh & Reconcile turn did not complete successfully");
				if (!presentationProducer) throw new Error("manager presentation producer is unavailable");
				desiredPresentation = await presentationProducer.renderCurrent();
				publishPresentation(ctx);
			} catch (error) {
				ctx.ui.notify(`Discord manager-summary update failed; retry manually: ${errorMessage(error)}`, "error");
			} finally {
				if (managerSummaryTurn === turn) managerSummaryTurn = undefined;
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
