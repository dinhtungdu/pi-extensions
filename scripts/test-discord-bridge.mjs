#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createConnection, createServer } from "node:net";
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ChannelType, MessageFlags } from "discord.js";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".discord-bridge-test-"));
const dataDir = await mkdtemp(join(tmpdir(), "pi-discord-bridge-data-"));
const originalFetch = globalThis.fetch;
let compatibilityDirectory;

function compileExtensions() {
	const compile = spawnSync(
		join(root, "node_modules", ".bin", "tsc"),
		["--noEmit", "false", "--rootDir", ".", "--outDir", output],
		{ cwd: root, encoding: "utf8" },
	);
	if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`.trim());
}

async function waitFor(predicate, description) {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (await predicate()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

function reactionSequence(messageId) {
	return FakeGateway.lifecycleReactionEvents
		.filter((event) => event.messageId === messageId)
		.map((event) => event.reaction);
}

class FakeGateway {
	static instances = [];
	static activeConnections = 0;
	static maximumActiveConnections = 0;
	static catchUpByThread = new Map();
	static nonceResults = new Map();
	static failSendAt = undefined;
	static failOnceTexts = new Set();
	static sendAttempts = new Map();
	static sendAttemptTimes = new Map();
	static deletedThreads = new Set();
	static lifecycleReactions = new Map();
	static lifecycleReactionEvents = [];
	static failLifecycleOnce = new Set();
	static hangLifecycleFor = new Set();
	static channelMessages = new Map();
	static summaryEvents = [];
	static failDeleteOnce = new Set();
	static failEditOnce = new Set();

	connected = false;
	listeners = new Set();
	terminalListeners = new Set();
	controlListeners = new Set();
	autocompleteListeners = new Set();
	managerControlListeners = new Set();
	managerAutocompleteListeners = new Set();
	presentationControlListeners = new Set();
	projectRequests = [];
	threadRequests = [];
	sent = [];
	threadCounter = 0;

	constructor() {
		FakeGateway.instances.push(this);
	}

	async connect(config) {
		this.config = config;
		this.connected = true;
		FakeGateway.activeConnections++;
		FakeGateway.maximumActiveConnections = Math.max(
			FakeGateway.maximumActiveConnections,
			FakeGateway.activeConnections,
		);
	}

	async disconnect() {
		if (!this.connected) return;
		this.connected = false;
		FakeGateway.activeConnections--;
	}

	onMessage(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onSessionControl(listener) {
		this.controlListeners.add(listener);
		return () => this.controlListeners.delete(listener);
	}

	onModelAutocomplete(listener) {
		this.autocompleteListeners.add(listener);
		return () => this.autocompleteListeners.delete(listener);
	}

	onManagerControl(listener) {
		this.managerControlListeners.add(listener);
		return () => this.managerControlListeners.delete(listener);
	}

	onManagerAutocomplete(listener) {
		this.managerAutocompleteListeners.add(listener);
		return () => this.managerAutocompleteListeners.delete(listener);
	}

	onPresentationControl(listener) {
		this.presentationControlListeners.add(listener);
		return () => this.presentationControlListeners.delete(listener);
	}

	async executePresentationControl(request) {
		const listener = this.presentationControlListeners.values().next().value;
		return listener ? listener(request) : { ok: false, message: "presentation controls unavailable" };
	}

	async executeControl(request) {
		const listener = this.controlListeners.values().next().value;
		return listener
			? listener(request)
			: { ok: false, message: "Discord relay is not ready for Pi session controls." };
	}

	modelAutocomplete(channelId, prefix) {
		return this.autocompleteListeners.values().next().value?.(channelId, prefix) ?? [];
	}

	async executeManagerControl(request) {
		const listener = this.managerControlListeners.values().next().value;
		return listener
			? listener(request)
			: { ok: false, message: "Discord relay is not ready for manager controls." };
	}

	managerAutocomplete(channelId, prefix, kind = "task") {
		return this.managerAutocompleteListeners.values().next().value?.(channelId, prefix, kind) ?? [];
	}

	async ensureProjectChannel(request) {
		this.projectRequests.push(request);
		return request.mappedChannelId ?? `channel-${this.projectRequests.length}`;
	}

	async ensureSessionThread(request) {
		this.threadRequests.push(request);
		if (request.mappedThreadId && !FakeGateway.deletedThreads.has(request.mappedThreadId)) return request.mappedThreadId;
		return `thread-${++this.threadCounter}-${request.name.slice(-8)}`;
	}

	async fetchMessagesAfter(threadId, afterId) {
		return (FakeGateway.catchUpByThread.get(threadId) ?? []).filter((message) => {
			if (!afterId) return true;
			try {
				return BigInt(message.id) > BigInt(afterId);
			} catch {
				return message.id > afterId;
			}
		});
	}

	async setLifecycleReaction(channelId, messageId, reaction) {
		const key = `${messageId}:${reaction}`;
		if (FakeGateway.hangLifecycleFor.has(key)) return new Promise(() => {});
		if (FakeGateway.failLifecycleOnce.delete(key)) throw new Error("injected Discord reaction failure");
		if (FakeGateway.lifecycleReactions.get(messageId) === reaction) return;
		FakeGateway.lifecycleReactions.set(messageId, reaction);
		FakeGateway.lifecycleReactionEvents.push({ channelId, messageId, reaction, gateway: this });
	}

	async latestMessageId(channelId) {
		return FakeGateway.channelMessages.get(channelId)?.at(-1)?.id;
	}

	async editOwnText(channelId, messageId, text) {
		if (FakeGateway.failEditOnce.delete(messageId)) throw new Error("injected Discord edit failure");
		const message = (FakeGateway.channelMessages.get(channelId) ?? []).find((candidate) => candidate.id === messageId);
		if (!message || !message.botOwned) throw new Error("summary message is missing or not bot-owned");
		message.text = text;
		FakeGateway.summaryEvents.push({ type: "edit", channelId, messageId, text });
	}

	async editOwnPresentation(channelId, messageId, presentation) {
		if (FakeGateway.failEditOnce.delete(messageId)) throw new Error("injected Discord edit failure");
		const message = (FakeGateway.channelMessages.get(channelId) ?? []).find((candidate) => candidate.id === messageId);
		if (!message || !message.botOwned) throw new Error("summary message is missing or not bot-owned");
		message.text = presentation.content;
		message.presentation = structuredClone(presentation);
		FakeGateway.summaryEvents.push({ type: "edit", channelId, messageId, text: presentation.content, presentation: structuredClone(presentation) });
	}

	async deleteOwnText(channelId, messageId) {
		if (FakeGateway.failDeleteOnce.delete(messageId)) throw new Error("injected Discord delete failure");
		const messages = FakeGateway.channelMessages.get(channelId) ?? [];
		const index = messages.findIndex((message) => message.id === messageId);
		if (index < 0) return;
		if (!messages[index].botOwned) throw new Error("summary message is not bot-owned");
		messages.splice(index, 1);
		FakeGateway.summaryEvents.push({ type: "delete", channelId, messageId });
	}

	async sendPresentation(channelId, presentation, nonce) {
		const messageId = await this.sendText(channelId, presentation.content, nonce);
		const message = (FakeGateway.channelMessages.get(channelId) ?? []).find((candidate) => candidate.id === messageId);
		if (message) message.presentation = structuredClone(presentation);
		return messageId;
	}

	async sendText(channelId, text, nonce) {
		if (typeof nonce !== "string" || !nonce || nonce.length > 25) {
			throw new Error("Discord API error 50035: NONCE_TYPE_TOO_LONG");
		}
		FakeGateway.sendAttempts.set(text, (FakeGateway.sendAttempts.get(text) ?? 0) + 1);
		const attemptTimes = FakeGateway.sendAttemptTimes.get(text) ?? [];
		attemptTimes.push(Date.now());
		FakeGateway.sendAttemptTimes.set(text, attemptTimes);
		if (FakeGateway.failOnceTexts.delete(text)) throw new Error("injected transient Discord send failure");
		if (FakeGateway.deletedThreads.has(channelId)) throw new Error("Unknown Channel");
		const existing = FakeGateway.nonceResults.get(nonce);
		if (existing) return existing;
		if (FakeGateway.failSendAt === this.sent.length) throw new Error("injected Discord send failure");
		const id = `sent-${FakeGateway.nonceResults.size + 1}`;
		this.sent.push({ channelId, text, nonce, id });
		const messages = FakeGateway.channelMessages.get(channelId) ?? [];
		messages.push({ id, text, botOwned: true });
		FakeGateway.channelMessages.set(channelId, messages);
		FakeGateway.summaryEvents.push({ type: "send", channelId, messageId: id, text });
		FakeGateway.nonceResults.set(nonce, id);
		return id;
	}

	onTerminalError(listener) {
		this.terminalListeners.add(listener);
		return () => this.terminalListeners.delete(listener);
	}

	terminal(error = new Error("injected terminal gateway failure")) {
		for (const listener of this.terminalListeners) listener(error);
	}

	async emit(message) {
		await Promise.all([...this.listeners].map((listener) => listener(message)));
	}
}

function createExtensionHarness(extension, {
	cwd,
	sessionId,
	sessionName,
	entries = [],
	entryRendererError = false,
	models = [
		{ provider: "openai", id: "gpt-test", name: "GPT Test", input: ["text", "image"] },
		{ provider: "anthropic", id: "claude-test", name: "Claude Test", input: ["text", "image"] },
	],
}) {
	const events = new Map();
	const commands = new Map();
	const entryRenderers = new Map();
	const notifications = [];
	const statuses = [];
	const userMessages = [];
	const userWaiters = [];
	let idle = true;
	let injectionError = false;
	let currentSessionName = sessionName;
	let currentModel = models[0];
	let thinkingLevel = "medium";
	let pendingMessages = false;
	let appendError = false;
	let appendCalls = 0;
	let abortRequests = 0;
	const pi = {
		on(name, handler) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		registerEntryRenderer(customType, renderer) {
			if (entryRendererError) throw new Error("injected entry renderer registration failure");
			entryRenderers.set(customType, renderer);
		},
		sendUserMessage(text, options) {
			if (injectionError) throw new Error("injected Pi acceptance failure");
			const message = { text, options };
			userMessages.push(message);
			userWaiters.shift()?.(message);
		},
		getSessionName() {
			return currentSessionName;
		},
		appendEntry(customType, data) {
			appendCalls++;
			if (appendError) throw new Error("injected custom-entry append failure");
			entries.push({ type: "custom", customType, data });
		},
		async setModel(model) {
			currentModel = model;
			ctx.model = model;
			return true;
		},
		getThinkingLevel() {
			return thinkingLevel;
		},
		setThinkingLevel(level) {
			thinkingLevel = level;
			ctx.thinkingLevel = level;
		},
	};
	const ctx = {
		cwd,
		hasUI: true,
		isIdle: () => idle,
		hasPendingMessages: () => pendingMessages,
		abort: () => { abortRequests++; },
		model: currentModel,
		thinkingLevel,
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => models,
			find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
		},
		sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
		ui: {
			notify: (...args) => notifications.push(args),
			setStatus: (...args) => statuses.push(args),
		},
	};
	extension(pi);
	return {
		commands,
		entryRenderers,
		events,
		notifications,
		statuses,
		userMessages,
		entries,
		setIdle(value) { idle = value; },
		setPendingMessages(value) { pendingMessages = value; },
		setAppendError(value) { appendError = value; },
		appendCalls: () => appendCalls,
		abortRequests: () => abortRequests,
		currentModel: () => currentModel,
		thinkingLevel: () => thinkingLevel,
		setInjectionError(value) { injectionError = value; },
		setSessionName(value) { currentSessionName = value; },
		nextUserMessage() {
			return new Promise((resolveMessage) => userWaiters.push(resolveMessage));
		},
		async emit(name, event = {}) {
			let result;
			for (const handler of events.get(name) ?? []) result = await handler(event, ctx);
			return result;
		},
		async runCommand(name, args = "") {
			return commands.get(name).handler(args, ctx);
		},
	};
}

try {
	compileExtensions();
	const importBuilt = (path) => import(pathToFileURL(join(output, path)));
	const {
		loadDiscordConfig,
		parseDiscordConfig,
		relayPaths,
		saveDiscordConfig,
	} = await importBuilt("extensions/discord/config.js");
	const { PACKAGE_FOOTER_STATUS_KEYS } = await importBuilt("extensions/footer-status.js");
	const {
		DISCORD_SESSION_RETENTION_MS,
		DiscordStateStore,
		MAX_DISCORD_NONCE_LENGTH,
		MAX_RECENT_MESSAGE_IDS,
		MIN_RETAINED_DISCORD_SESSIONS,
	} = await importBuilt("extensions/discord/state.js");
	const { LocalRelayClient } = await importBuilt("extensions/discord/relay-client.js");
	const { resolveProjectContext, resolveProjectIdentity } = await importBuilt("extensions/discord/project-identity.js");
	const { discoverTaskTitle, parseTaskTitle } = await importBuilt("extensions/discord/task-title.js");
	const {
		createDiscordExtension,
		MANAGER_CONTROL_RESULT_ENTRY,
		shouldAutoStartDiscordBridge,
		shouldPublishManagerTaskSummary,
		shouldSubscribeOwnerToWorkerThread,
	} = await importBuilt("extensions/discord/index.js");
	const { managerProjectCatalogue, managerTaskCatalogue, ManagerTaskSummaryProducer } = await importBuilt("extensions/discord/manager-task-summary.js");
	const {
		ManagerPresentationProducer,
		parseManagerPresentationEnvelope,
	} = await importBuilt("extensions/discord/manager-presentation.js");
	const {
		MANAGER_CONTROL_PROCESS_TIMEOUT_MS,
		ManagerControlExecutor,
	} = await importBuilt("extensions/discord/manager-controls.js");
	const {
		isEligibleManagerTaskSummaryProducer,
		negotiatedManagerPresentation,
		LocalRelayHost,
		MANAGER_CONTROL_IPC_TIMEOUT_MS,
	} = await importBuilt("extensions/discord/relay-host.js");
	const { DiscordRelayCore } = await importBuilt("extensions/discord/relay-core.js");
	const { DiscordBridge, inboundMessageId, stripInboundMarker } = await importBuilt("extensions/discord/bridge.js");
	const {
		InboundImageStore,
		INBOUND_IMAGE_DOWNLOAD_ATTEMPTS,
		MAX_INBOUND_IMAGE_BYTES,
		MAX_INBOUND_IMAGE_SPOOL_BYTES,
		MAX_INBOUND_MESSAGE_IMAGE_BYTES,
		MAX_INBOUND_IMAGES,
		TransientInboundImageError,
		loadInboundImages,
	} = await importBuilt("extensions/discord/inbound-images.js");
	const { BoundedSocketWriter, MAX_QUEUED_IPC_FRAMES } = await importBuilt("extensions/discord/ipc-writer.js");
	const { isClientFrame, isServerFrame } = await importBuilt("extensions/discord/protocol.js");
	const {
		MAX_MANAGER_PROJECT_CATALOGUE_ITEMS,
		MAX_MANAGER_TARGET_AUTOCOMPLETE_CHOICES,
		MAX_MANAGER_TASK_AUTOCOMPLETE_CHOICES,
		MAX_MANAGER_TASK_CATALOGUE_ITEMS,
		MAX_MODEL_AUTOCOMPLETE_CHOICES,
		MAX_MODEL_CATALOGUE_ITEMS,
		MAX_SESSION_CONTROL_QUEUE,
		managerTargetAutocompleteChoices,
		managerTaskAutocompleteChoices,
		modelAutocompleteChoices,
	} = await importBuilt("extensions/discord/controls.js");
	const { restartOwnedRelay, tryAcquireLeader } = await importBuilt("extensions/discord/leader.js");
	const {
		assistantText,
		collidingProjectChannelName,
		interactiveUserChunks,
		projectChannelName,
		sessionThreadName,
		splitDiscordText,
	} = await importBuilt("extensions/discord/text.js");
	const {
		assertConfiguredCategory,
		collectChronologicalMessages,
		DiscordInteractionChannelResolver,
		DiscordJsTransport,
		MANAGER_CONTROL_INTERACTION_TIMEOUT_MS,
		managerCommandDefinition,
		presentationComponents,
		replaceOwnLifecycleReaction,
		reuseSessionThread,
		subscribeThreadOwner,
	} = await importBuilt("extensions/discord/transport.js");

	const activationHome = join(dataDir, "activation-home");
	assert.equal(shouldAutoStartDiscordBridge(join(activationHome, "workspace"), activationHome), false,
		"the workspace root must remain off by default");
	assert.equal(shouldAutoStartDiscordBridge(join(activationHome, "worktrees"), activationHome), false,
		"the worktrees root must remain off by default");
	assert.equal(shouldAutoStartDiscordBridge(join(activationHome, "workspace", "project", "src"), activationHome), true,
		"workspace descendants must activate by default");
	assert.equal(shouldAutoStartDiscordBridge(join(activationHome, "worktrees", "project"), activationHome), true,
		"worktree descendants must activate by default");
	assert.equal(shouldAutoStartDiscordBridge(join(activationHome, "workspace-misleading", "project"), activationHome), false,
		"workspace string prefixes must not activate");
	assert.equal(shouldAutoStartDiscordBridge(join(activationHome, "worktrees-old", "project"), activationHome), false,
		"worktrees string prefixes must not activate");
	assert.equal(shouldAutoStartDiscordBridge(join(activationHome, "elsewhere", "project"), activationHome), false,
		"paths outside both roots must remain off by default");
	assert.equal(shouldPublishManagerTaskSummary(join(activationHome, "workspace", "the-manager")), true,
		"the-manager checkout must publish task summaries");
	assert.equal(shouldPublishManagerTaskSummary(join(activationHome, "workspace", "the-manager-copy")), false,
		"other checkouts must not publish task summaries");
	assert.equal(shouldSubscribeOwnerToWorkerThread({
		THE_MANAGER_ROLE: "worker", THE_MANAGER_SESSION_POLICY: "continue",
	}), true, "retained primary workers must request owner subscription");
	assert.equal(shouldSubscribeOwnerToWorkerThread({
		THE_MANAGER_ROLE: "worker", THE_MANAGER_SESSION_POLICY: "fresh",
	}), false, "fresh review workers must not request owner subscription");
	assert.equal(shouldSubscribeOwnerToWorkerThread({ THE_MANAGER_SESSION_POLICY: "continue" }), false,
		"ordinary continued sessions must not request owner subscription");

	let explicitEnableLoads = 0;
	const explicitRelayDirectory = join(dataDir, "explicit-enable-relay");
	const explicitEnable = createExtensionHarness(createDiscordExtension({
		autoStartForCwd: () => false,
		paths: relayPaths(explicitRelayDirectory),
		loadConfig: async () => {
			explicitEnableLoads++;
			return { token: "explicit-token", guildId: "12345", epoch: 1 };
		},
		createStateStore: () => new DiscordStateStore(join(explicitRelayDirectory, "state.json")),
		createTransport: () => new FakeGateway(),
	}), {
		cwd: join(activationHome, "elsewhere"),
		sessionId: "explicit-discord-enable",
		sessionName: "Explicit Discord enable",
	});
	await explicitEnable.emit("session_start", { reason: "startup" });
	assert.equal(explicitEnableLoads, 0, "outside sessions must not load Discord configuration at startup");
	assert.equal(FakeGateway.activeConnections, 0, "outside startup must leave the relay off");
	await explicitEnable.runCommand("discord", "reconnect");
	assert.ok(explicitEnableLoads > 0, "/discord reconnect must load configuration for an outside session");
	assert.deepEqual(explicitEnable.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.discord, "💬"],
		"/discord reconnect must explicitly connect an outside session");
	await explicitEnable.emit("session_shutdown", { reason: "quit" });
	await waitFor(() => FakeGateway.activeConnections === 0, "explicit-enable relay shutdown");

	const primaryRelayDirectory = join(dataDir, "primary-worker-relay");
	const primaryStateFile = join(primaryRelayDirectory, "state.json");
	const primaryGateway = new FakeGateway();
	const primaryWorker = createExtensionHarness(createDiscordExtension({
		environment: { THE_MANAGER_ROLE: "worker", THE_MANAGER_SESSION_POLICY: "continue" },
		paths: relayPaths(primaryRelayDirectory),
		loadConfig: async () => ({ token: "primary-token", guildId: "12345", epoch: 1 }),
		createStateStore: () => new DiscordStateStore(primaryStateFile),
		createTransport: () => primaryGateway,
		autoStartForCwd: () => true,
	}), {
		cwd: "/work/primary-worker",
		sessionId: "retained-primary-worker",
		sessionName: "Retained primary worker",
	});
	await primaryWorker.emit("session_start", { reason: "startup" });
	const primaryMapping = await new DiscordStateStore(primaryStateFile).getSession("retained-primary-worker");
	assert.equal(primaryGateway.threadRequests[0].subscribeOwner, true,
		"retained primary metadata must request owner subscription");
	await primaryWorker.runCommand("discord", "reconnect");
	assert.deepEqual(primaryGateway.threadRequests.at(-1), {
		channelId: primaryMapping.channelId,
		mappedThreadId: primaryMapping.threadId,
		name: sessionThreadName("retained-primary-worker", "Retained primary worker"),
		subscribeOwner: true,
	}, "continued primary reconnect must reuse and resubscribe the exact worker thread");
	assert.equal((await new DiscordStateStore(primaryStateFile).getSession("retained-primary-worker")).threadId,
		primaryMapping.threadId, "continued primary reconnect must not create another thread");
	const primarySteering = primaryWorker.nextUserMessage();
	await primaryGateway.emit({
		id: "primary-steer", channelId: primaryMapping.threadId, content: "steer exact primary", authorBot: false,
	});
	assert.equal(stripInboundMarker((await primarySteering).text), "steer exact primary",
		"owner-visible thread messages must continue steering the exact retained worker");
	await primaryWorker.emit("session_shutdown", { reason: "quit" });
	await waitFor(() => FakeGateway.activeConnections === 0, "primary-worker relay shutdown");

	const freshRelayDirectory = join(dataDir, "fresh-worker-relay");
	const freshGateway = new FakeGateway();
	const freshWorker = createExtensionHarness(createDiscordExtension({
		environment: { THE_MANAGER_ROLE: "worker", THE_MANAGER_SESSION_POLICY: "fresh" },
		paths: relayPaths(freshRelayDirectory),
		loadConfig: async () => ({ token: "fresh-token", guildId: "12345", epoch: 1 }),
		createStateStore: () => new DiscordStateStore(join(freshRelayDirectory, "state.json")),
		createTransport: () => freshGateway,
		autoStartForCwd: () => true,
	}), {
		cwd: "/work/fresh-worker",
		sessionId: "fresh-review-worker",
		sessionName: "Fresh review worker",
	});
	await freshWorker.emit("session_start", { reason: "startup" });
	assert.equal(freshGateway.threadRequests[0].subscribeOwner, undefined,
		"fresh review workers must not subscribe the owner");
	await freshWorker.emit("session_shutdown", { reason: "quit" });
	await waitFor(() => FakeGateway.activeConnections === 0, "fresh-worker relay shutdown");

	assert.deepEqual(parseDiscordConfig({ token: " token ", guildId: "12345", categoryId: "" }), {
		token: "token",
		guildId: "12345",
		epoch: 0,
	});
	assert.throws(
		() => parseDiscordConfig({ token: "token", guildId: "12345", categoryId: "not-an-id" }),
		/categoryId must be a Discord ID/,
	);
	assert.doesNotThrow(() => assertConfiguredCategory(
		{ type: ChannelType.GuildCategory, guildId: "12345" },
		"67890",
		"12345",
	));
	assert.throws(
		() => assertConfiguredCategory({ type: ChannelType.GuildText, guildId: "12345" }, "67890", "12345"),
		/Configured Discord category 67890.*not a category/,
	);
	const removedReactions = [];
	const addedReactions = [];
	const reactionOperations = [];
	await replaceOwnLifecycleReaction([
		{ emoji: { name: "👀" }, me: true, users: { async remove(id) { reactionOperations.push("remove"); removedReactions.push(["👀", id]); } } },
		{ emoji: { name: "🤔" }, me: false, users: { async remove(id) { removedReactions.push(["🤔", id]); } } },
		{ emoji: { name: "🎉" }, me: true, users: { async remove(id) { removedReactions.push(["🎉", id]); } } },
	], "bot-user", "⚙️", async (reaction) => { reactionOperations.push("add"); addedReactions.push(reaction); });
	assert.deepEqual(removedReactions, [["👀", "bot-user"]], "only the bot's prior lifecycle reaction may be removed");
	assert.deepEqual(addedReactions, ["⚙️"]);
	assert.deepEqual(reactionOperations, ["add", "remove"], "the current status must display before stale-reaction cleanup");
	let releaseRateLimitedRemoval;
	let replacementDisplayed = false;
	const rateLimitedReplacement = replaceOwnLifecycleReaction([
		{ emoji: { name: "🤔" }, me: true, users: { remove() { return new Promise((resolve) => { releaseRateLimitedRemoval = resolve; }); } } },
	], "bot-user", "⚙️", async () => { replacementDisplayed = true; });
	await waitFor(() => replacementDisplayed, "replacement display during rate-limited cleanup");
	releaseRateLimitedRemoval();
	await rateLimitedReplacement;
	let addedBeforeRemoveFailure = false;
	await assert.rejects(() => replaceOwnLifecycleReaction([
		{ emoji: { name: "🤔" }, me: true, users: { async remove() { throw new Error("Missing Permissions"); } } },
	], "bot-user", "✅", async () => { addedBeforeRemoveFailure = true; }), /Missing Permissions/);
	assert.equal(addedBeforeRemoveFailure, true, "cleanup failure must not hide the current lifecycle status");
	let removedBeforeAddFailure = false;
	await assert.rejects(() => replaceOwnLifecycleReaction([
		{ emoji: { name: "👀" }, me: true, users: { async remove() { removedBeforeAddFailure = true; } } },
	], "bot-user", "🤔", async () => { throw new Error("reaction API failure"); }), /reaction API failure/);
	assert.equal(removedBeforeAddFailure, false, "a failed replacement must leave the previous lifecycle status visible");
	let reopened = false;
	assert.equal(await reuseSessionThread({
		id: "thread-1",
		parentId: "channel-1",
		archived: true,
		isThread: () => true,
		async setArchived(value) { reopened = value === false; },
	}, "channel-1"), "thread-1");
	assert.equal(reopened, true);
	const subscribedOwners = new Set();
	const ownerSubscriptionCalls = [];
	const ownerThread = {
		guild: { ownerId: "configured-owner" },
		members: { async add(userId) { ownerSubscriptionCalls.push(userId); subscribedOwners.add(userId); } },
	};
	await subscribeThreadOwner(ownerThread);
	await subscribeThreadOwner(ownerThread);
	assert.deepEqual(ownerSubscriptionCalls, ["configured-owner", "configured-owner"]);
	assert.deepEqual([...subscribedOwners], ["configured-owner"], "repeated owner subscription must retain one membership");
	const malformedConfig = join(dataDir, "malformed-config.json");
	await writeFile(malformedConfig, "{oops");
	await assert.rejects(() => loadDiscordConfig(malformedConfig, {}), /Cannot read Discord bridge config/);
	const legacyStateFile = join(dataDir, "legacy-state.json");
	await writeFile(legacyStateFile, JSON.stringify({
		version: 1,
		projects: { "/legacy/project": { channelId: "legacy-channel" } },
		sessions: {
			"legacy-session": {
				cwd: "/legacy/project",
				channelId: "legacy-channel",
				threadId: "legacy-thread",
				lastMessageId: "123",
				pendingMessages: [],
			},
		},
		recentMessageIds: [],
	}));
	const compactionNow = 2_000_000_000_000;
	const legacyStateStore = new DiscordStateStore(legacyStateFile, () => compactionNow);
	const legacyState = await legacyStateStore.load();
	assert.equal(legacyState.sessions["legacy-session"].threadCursors["legacy-thread"], "123");
	assert.deepEqual(legacyState.sessions["legacy-session"].outboundMessages, []);
	assert.deepEqual(legacyState.sessions["legacy-session"].lifecycleMessages, []);
	assert.equal(legacyState.sessions["legacy-session"].lastActiveAt, compactionNow,
		"legacy sessions without activity metadata must receive a safe fresh fallback");
	await legacyStateStore.compact();
	const persistedLegacyState = JSON.parse(await readFile(legacyStateFile, "utf8"));
	assert.equal(persistedLegacyState.version, 1, "activity metadata must remain compatible with version-1 state");
	assert.equal(persistedLegacyState.sessions["legacy-session"].lastActiveAt, compactionNow,
		"legacy fallback activity must persist without a state-version migration");
	assert.equal(persistedLegacyState.projects["/legacy/project"].channelId, "legacy-channel");

	const retentionCutoff = compactionNow - DISCORD_SESSION_RETENTION_MS;
	const compactionSession = (sessionId, lastActiveAt, overrides = {}) => ({
		cwd: `/compaction/${sessionId}`,
		channelId: `channel-${sessionId}`,
		threadId: `thread-${sessionId}`,
		lastActiveAt,
		threadCursors: {},
		pendingMessages: [],
		retainedImages: [],
		outboundMessages: [],
		lifecycleMessages: [],
		...overrides,
	});
	const freshSessions = Object.fromEntries(Array.from({ length: MIN_RETAINED_DISCORD_SESSIONS }, (_, index) => {
		const sessionId = `fresh-${String(index).padStart(3, "0")}`;
		return [sessionId, compactionSession(sessionId, compactionNow - index)];
	}));
	const compactionStateFile = join(dataDir, "compaction-state.json");
	await writeFile(compactionStateFile, JSON.stringify({
		version: 1,
		projects: {
			"/compaction/expired": { channelId: "permanent-expired-project" },
			"/compaction/live": { channelId: "permanent-live-project" },
		},
		sessions: {
			...freshSessions,
			boundary: compactionSession("boundary", retentionCutoff, {
				lifecycleMessages: [{ messageId: "expired-success", channelId: "thread-boundary", status: "succeeded", updatedAt: retentionCutoff - 1 },
					{ messageId: "boundary-failure", channelId: "thread-boundary", status: "failed", updatedAt: retentionCutoff },
					{ messageId: "unfinished", channelId: "thread-boundary", status: "tool", updatedAt: retentionCutoff - 1 }],
			}),
			expired: compactionSession("expired", retentionCutoff - 1),
			"protected-pending": compactionSession("protected-pending", retentionCutoff - 10, {
				pendingMessages: [{ id: "pending-id", content: "deliver me" }],
			}),
			"protected-outbound": compactionSession("protected-outbound", retentionCutoff - 20, {
				outboundMessages: [{
					id: "outbound-id",
					kind: "assistant",
					threadId: "thread-protected-outbound",
					chunks: [{ index: 0, content: "send me", nonce: "bounded-nonce" }],
				}],
			}),
			"protected-lifecycle": compactionSession("protected-lifecycle", retentionCutoff - 30, {
				lifecycleMessages: [{
					messageId: "active-lifecycle",
					channelId: "thread-protected-lifecycle",
					status: "thinking",
					updatedAt: retentionCutoff - 30,
				}],
			}),
			"protected-retained": compactionSession("protected-retained", retentionCutoff - 40, {
				retainedImages: [{
					messageId: "retained-message",
					acknowledgedAt: retentionCutoff - 40,
					images: [{ attachmentId: "12345", localPath: "/tmp/retained.png", mimeType: "image/png", size: 100 }],
				}],
			}),
			"protected-explicit": compactionSession("protected-explicit", retentionCutoff - 50),
		},
		recentMessageIds: Array.from({ length: MAX_RECENT_MESSAGE_IDS + 5 }, (_, index) => `dedupe-${index}`),
	}));
	const compactionStore = new DiscordStateStore(compactionStateFile, () => compactionNow);
	await compactionStore.compact(new Set(["protected-explicit"]));
	const persistedCompacted = JSON.parse(await readFile(compactionStateFile, "utf8"));
	assert.equal(persistedCompacted.recentMessageIds.length, MAX_RECENT_MESSAGE_IDS,
		"the persisted deduplication list must remain strictly capped");
	const compacted = await compactionStore.load();
	assert.equal(compacted.sessions.expired, undefined, "sessions older than the boundary must expire");
	assert.ok(compacted.sessions.boundary, "sessions exactly 30 days old must remain through the boundary");
	assert.ok(compacted.sessions["protected-pending"], "pending inbound delivery must prevent session pruning");
	assert.ok(compacted.sessions["protected-outbound"], "queued outbound delivery must prevent session pruning");
	assert.ok(compacted.sessions["protected-lifecycle"], "unfinished lifecycle coordination must prevent session pruning");
	assert.ok(compacted.sessions["protected-retained"], "retained image cleanup must prevent session pruning");
	assert.equal(compacted.sessions["protected-explicit"].lastActiveAt, compactionNow,
		"explicitly connected or registering sessions must be protected and refreshed atomically");
	assert.deepEqual(compacted.sessions.boundary.lifecycleMessages.map((message) => message.messageId), [
		"boundary-failure", "unfinished",
	], "only completed lifecycle records older than 30 days must expire");
	assert.equal(compacted.projects["/compaction/expired"].channelId, "permanent-expired-project",
		"session compaction must never remove project mappings");
	assert.equal(compacted.recentMessageIds.length, MAX_RECENT_MESSAGE_IDS, "deduplication IDs must remain strictly capped");
	assert.equal(compacted.recentMessageIds[0], "dedupe-5", "deduplication compaction must retain the newest IDs");

	const minimumStateFile = join(dataDir, "minimum-session-state.json");
	const minimumSessions = Object.fromEntries(Array.from({ length: MIN_RETAINED_DISCORD_SESSIONS + 5 }, (_, index) => {
		const sessionId = `minimum-${String(index).padStart(3, "0")}`;
		return [sessionId, compactionSession(sessionId, retentionCutoff - 1_000 + index)];
	}));
	await writeFile(minimumStateFile, JSON.stringify({ version: 1, projects: {}, sessions: minimumSessions, recentMessageIds: [] }));
	const minimumStore = new DiscordStateStore(minimumStateFile, () => compactionNow);
	await minimumStore.compact();
	const minimumState = await minimumStore.load();
	assert.equal(Object.keys(minimumState.sessions).length, MIN_RETAINED_DISCORD_SESSIONS,
		"compaction must always retain the latest 100 sessions");
	assert.equal(minimumState.sessions["minimum-004"], undefined);
	assert.ok(minimumState.sessions["minimum-005"], "the minimum retention set must select sessions by activity time");

	function manualCompactionScheduler() {
		let scheduled;
		return {
			dependencies: {
				scheduleStateCompaction(run) {
					scheduled = run;
					return () => { scheduled = undefined; };
				},
			},
			async run() {
				assert.ok(scheduled, "relay state compaction must be scheduled while running");
				await scheduled();
			},
		};
	}

	const replacementStateFile = join(dataDir, "relay-replacement-compaction.json");
	let replacementNow = compactionNow;
	const replacementAfter31Days = compactionNow + DISCORD_SESSION_RETENTION_MS + 24 * 60 * 60 * 1_000;
	const replacementNewerSessions = Object.fromEntries(Array.from({ length: MIN_RETAINED_DISCORD_SESSIONS }, (_, index) => {
		const sessionId = `replacement-newer-${String(index).padStart(3, "0")}`;
		return [sessionId, compactionSession(sessionId, replacementAfter31Days - index)];
	}));
	await writeFile(replacementStateFile, JSON.stringify({
		version: 1,
		projects: { "/replacement/connected": { channelId: "replacement-channel", name: "connected" } },
		sessions: {
			...replacementNewerSessions,
			"replacement-connected": {
				...compactionSession("replacement-connected", replacementNow),
				cwd: "/replacement/connected",
				channelId: "replacement-channel",
				threadId: "replacement-thread",
				threadCursors: { "replacement-thread": "987654321" },
			},
		},
		recentMessageIds: [],
	}));
	const replacementStore = new DiscordStateStore(replacementStateFile, () => replacementNow);
	const oldReplacementScheduler = manualCompactionScheduler();
	const oldReplacementGateway = new FakeGateway();
	const oldReplacementCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		replacementStore,
		oldReplacementGateway,
		() => {},
		undefined,
		oldReplacementScheduler.dependencies,
	);
	await oldReplacementCore.start();
	await oldReplacementCore.prepareRegistration("replacement-client", "old-generation", {
		cwd: "/replacement/connected",
		projectIdentityResolved: true,
		sessionId: "replacement-connected",
		sessionName: "Replacement connected",
	});
	await oldReplacementCore.activateRegistration("replacement-client", "old-generation", "replacement-connected", () => true);
	replacementNow = replacementAfter31Days;
	await oldReplacementCore.stop();
	const protectedReplacement = await replacementStore.getSession("replacement-connected");
	assert.equal(protectedReplacement.lastActiveAt, replacementAfter31Days,
		"relay shutdown must refresh every connected session before replacement compaction");
	assert.equal(protectedReplacement.threadId, "replacement-thread");
	assert.equal(protectedReplacement.threadCursors["replacement-thread"], "987654321");

	const newReplacementScheduler = manualCompactionScheduler();
	const newReplacementGateway = new FakeGateway();
	const newReplacementCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		replacementStore,
		newReplacementGateway,
		() => {},
		undefined,
		newReplacementScheduler.dependencies,
	);
	await newReplacementCore.start();
	await newReplacementCore.prepareRegistration("replacement-client", "new-generation", {
		cwd: "/replacement/connected",
		projectIdentityResolved: true,
		sessionId: "replacement-connected",
		sessionName: "Replacement connected",
	});
	assert.equal(newReplacementGateway.threadRequests.at(-1).mappedThreadId, "replacement-thread",
		"replacement relay registration must reuse the connected session's thread");
	assert.equal((await replacementStore.getSession("replacement-connected")).threadCursors["replacement-thread"], "987654321",
		"replacement relay registration must preserve connected-session cursors");
	await newReplacementCore.stop();

	const longLivedStateFile = join(dataDir, "long-lived-relay-compaction.json");
	let longLivedNow = compactionNow;
	const longLivedAfter31Days = compactionNow + DISCORD_SESSION_RETENTION_MS + 24 * 60 * 60 * 1_000;
	const longLivedNewerSessions = Object.fromEntries(Array.from({ length: MIN_RETAINED_DISCORD_SESSIONS }, (_, index) => {
		const sessionId = `long-lived-newer-${String(index).padStart(3, "0")}`;
		return [sessionId, compactionSession(sessionId, longLivedAfter31Days - index)];
	}));
	await writeFile(longLivedStateFile, JSON.stringify({
		version: 1,
		projects: {
			"/long-lived/active": { channelId: "long-lived-active-channel", name: "active" },
			"/long-lived/reserved": { channelId: "long-lived-reserved-channel", name: "reserved" },
			"/long-lived/stale": { channelId: "long-lived-stale-channel", name: "stale" },
		},
		sessions: {
			...longLivedNewerSessions,
			"long-lived-active": { ...compactionSession("long-lived-active", longLivedNow), cwd: "/long-lived/active",
				channelId: "long-lived-active-channel", threadId: "long-lived-active-thread" },
			"long-lived-reserved": { ...compactionSession("long-lived-reserved", longLivedNow), cwd: "/long-lived/reserved",
				channelId: "long-lived-reserved-channel", threadId: "long-lived-reserved-thread" },
			"long-lived-stale": { ...compactionSession("long-lived-stale", longLivedNow), cwd: "/long-lived/stale",
				channelId: "long-lived-stale-channel", threadId: "long-lived-stale-thread" },
		},
		recentMessageIds: [],
	}));
	const longLivedStore = new DiscordStateStore(longLivedStateFile, () => longLivedNow);
	const longLivedScheduler = manualCompactionScheduler();
	const longLivedGateway = new FakeGateway();
	const longLivedCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		longLivedStore,
		longLivedGateway,
		() => {},
		undefined,
		longLivedScheduler.dependencies,
	);
	await longLivedCore.start();
	await longLivedCore.prepareRegistration("long-lived-client", "active-generation", {
		cwd: "/long-lived/active", projectIdentityResolved: true, sessionId: "long-lived-active",
	});
	await longLivedCore.activateRegistration("long-lived-client", "active-generation", "long-lived-active", () => true);
	await longLivedCore.prepareRegistration("reserved-client", "reserved-generation", {
		cwd: "/long-lived/reserved", projectIdentityResolved: true, sessionId: "long-lived-reserved",
	});
	longLivedNow = longLivedAfter31Days;
	await longLivedScheduler.run();
	const longLivedCompacted = await longLivedStore.load();
	assert.equal(longLivedCompacted.sessions["long-lived-stale"], undefined,
		"scheduled compaction must prune expired clean sessions without waiting for relay restart");
	assert.equal(longLivedCompacted.sessions["long-lived-active"].lastActiveAt, longLivedAfter31Days,
		"scheduled compaction must protect and refresh active sessions");
	assert.equal(longLivedCompacted.sessions["long-lived-reserved"].lastActiveAt, longLivedAfter31Days,
		"scheduled compaction must protect and refresh reserved/registering sessions");
	assert.equal(longLivedCompacted.projects["/long-lived/stale"].channelId, "long-lived-stale-channel",
		"long-lived relay compaction must preserve project mappings");
	await longLivedCore.stop();

	const managerFixture = join(dataDir, "the-manager");
	await mkdir(join(managerFixture, "bin"), { recursive: true });
	await mkdir(join(managerFixture, "data", "tasks"), { recursive: true });
	await mkdir(join(managerFixture, ".manager", "events"), { recursive: true });
	const managerFixtureScript = [
		'import { readFileSync, writeFileSync } from "node:fs";',
		'import { join } from "node:path";',
		'const command = process.argv[2];',
		'if (command === "status") console.log(readFileSync(join(process.cwd(), "status.json"), "utf8"));',
		'else if (command === "summary-render") { const countPath = join(process.cwd(), "summary-render-count.txt"); let count = 0; try { count = Number(readFileSync(countPath, "utf8")); } catch {} writeFileSync(countPath, String(count + 1)); writeFileSync(join(process.cwd(), "summary-render-args.json"), JSON.stringify(process.argv.slice(2))); console.log(readFileSync(join(process.cwd(), "presentation.json"), "utf8")); }',
		'else if (command === "github-status-refresh") console.log(JSON.stringify({ ok: true, command }));',
		'else if (command === "github-refresh-reconcile") { writeFileSync(join(process.cwd(), "forbidden-direct-command.txt"), "called"); console.log(JSON.stringify({ ok: true, command })); }',
		'else if (command === "task-reconcile-pr" && !process.argv.includes("--task")) { const countPath = join(process.cwd(), "reconcile-count.txt"); let count = 0; try { count = Number(readFileSync(countPath, "utf8")); } catch {} writeFileSync(countPath, String(count + 1)); console.log(JSON.stringify({ ok: true, command, scope: "all", scanned: 0, results: [], summary: { archived: 0, merged: 0, closed: 0, terminal: 0, open: 0, mixed: 0, not_found: 0, failed: 0 } })); }',
		'else {',
		'  const taskPath = process.argv[process.argv.indexOf("--task") + 1];',
		'  const taskId = taskPath.split("/").at(-1).replace(/\\.md$/, "");',
		'  const state = command === "handoff-start" ? { state: "direct", worker_session: "mgr-fixture" } : command === "handoff-return" ? { state: "return-requested", worker_session: "mgr-fixture" } : { archived: true, checkout_mode: "repository", slot_state: null };',
		'  console.log(JSON.stringify({ ok: true, command, task_id: taskId, ...state, replay: false }));',
		'}',
		"",
	].join("\n");
	await writeFile(join(managerFixture, "bin", "manager.mjs"), managerFixtureScript);
	await writeFile(join(managerFixture, "bin", "manager-runtime.mjs"), 'console.log(JSON.stringify({ valid: true }));\n');
	await writeFile(join(managerFixture, "data", "PROJECTS.md"), "---\nprojects:\n  pi-extensions:\n    repository: /tmp/pi-extensions\n    base_ref: origin/main\n    landing_ref: main\n    checkout_mode: repository\n---\n");
	const focusedManagerStatus = {
		ok: true,
		command: "status",
		schema_version: 1,
		summary: { tasks: 3, pending_events: 0, ready_tasks: 1, orphan_events: 0 },
		tasks: [{
			task_id: "discord-manager-task-summary",
			title: "Discord manager task summary",
			project: "pi-extensions",
			status: "ready",
			current_action: "review",
			current_run: "review-3",
		}, {
			task_id: "legacy-task-id",
			project: "wordpress",
			status: "planning",
			current_action: "none",
			current_run: "none",
		}, {
			task_id: "product-filters-drawer-visibility",
			title: "Add Product Filters drawer for @everyone",
			project: "woocommerce",
			status: "active",
			current_action: "implement",
			current_run: "implement-4",
		}],
	};
	assert.deepEqual(managerTaskCatalogue(focusedManagerStatus), [{
		taskId: "discord-manager-task-summary",
		project: "pi-extensions",
		title: "Discord manager task summary",
		status: "ready",
	}, {
		taskId: "legacy-task-id",
		project: "wordpress",
		title: "Legacy Task ID",
		status: "planning",
	}, {
		taskId: "product-filters-drawer-visibility",
		project: "woocommerce",
		title: "Add Product Filters drawer for @everyone",
		status: "active",
	}], "the canonical status snapshot must also produce the manager control catalogue");
	assert.deepEqual(managerTaskAutocompleteChoices(managerTaskCatalogue(focusedManagerStatus), "product filters"), [{
		name: "Add Product Filters drawer for @everyone — woocommerce (@product-filters-drawer-visibility)",
		value: "product-filters-drawer-visibility",
	}], "task autocomplete labels must include title, project, and task ID");
	const focusedProjects = managerProjectCatalogue("---\nprojects:\n  woocommerce:\n    repository: /tmp/woocommerce\n  legacy-task-id:\n    repository: /tmp/collision\n---\n");
	assert.deepEqual(focusedProjects, [{ projectId: "woocommerce" }, { projectId: "legacy-task-id" }]);
	assert.deepEqual(managerTargetAutocompleteChoices(focusedProjects, managerTaskCatalogue(focusedManagerStatus), "legacy"), [{
		name: "Project — Legacy Task Id (legacy-task-id)",
		value: "project:legacy-task-id",
	}, {
		name: "Task — Legacy Task ID — wordpress (@legacy-task-id)",
		value: "task:legacy-task-id",
	}], "ask target autocomplete must preserve collision-safe typed project and task values");
	assert.deepEqual(managerTargetAutocompleteChoices([], [{
		taskId: "completed-task", project: "woocommerce", title: "Completed task", status: "complete",
	}], "completed"), [], "ask targets must include only current active manager tasks");
	const renderedPresentationComponents = presentationComponents({ schemaVersion: 1, revision: "7".repeat(64), content: "opaque",
		controls: [{ id: "github-refresh-reconcile", label: "Exact manager label", style: "secondary", command: "github-refresh-reconcile" }],
		degraded: false, warnings: [] });
	assert.deepEqual(renderedPresentationComponents.map((row) => row.toJSON()), [{ type: 1,
		components: [
			{ type: 2, emoji: undefined, custom_id: `m:${"7".repeat(64)}:github-refresh-reconcile`, label: "Exact manager label", style: 2 },
		] }], "Discord components must preserve the manager label and revision-fenced ID");
	const transportPresentation = { schemaVersion: 1, revision: "8".repeat(64), content: "GitHub: https://example.com/task @everyone",
		controls: [{ id: "github-refresh-reconcile", label: "Refresh", style: "secondary", command: "github-refresh-reconcile" }],
		degraded: false, warnings: [] };
	const presentationSendPayloads = [];
	const presentationEditPayloads = [];
	const presentationTransport = new DiscordJsTransport();
	const presentationMessage = {
		author: { id: "bot-user" },
		async edit(payload) { presentationEditPayloads.push(payload); },
	};
	presentationTransport.readyClient = () => ({ user: { id: "bot-user" } });
	presentationTransport.textChannel = async () => ({
		async send(payload) { presentationSendPayloads.push(payload); return { id: "presentation-message" }; },
		messages: { async fetch(messageId) {
			assert.equal(messageId, "presentation-message");
			return presentationMessage;
		} },
	});
	assert.equal(await presentationTransport.sendPresentation(
		"project-channel", transportPresentation, "presentation-nonce",
	), "presentation-message");
	await presentationTransport.editOwnPresentation("project-channel", "presentation-message", transportPresentation);
	const normalizePresentationPayload = (payload) => ({
		...payload,
		components: payload.components.map((row) => row.toJSON()),
	});
	const expectedPresentationPayload = {
		content: transportPresentation.content,
		components: presentationComponents(transportPresentation).map((row) => row.toJSON()),
		allowedMentions: { parse: [] },
		flags: MessageFlags.SuppressEmbeds,
	};
	assert.deepEqual(normalizePresentationPayload(presentationSendPayloads[0]), {
		...expectedPresentationPayload,
		nonce: "presentation-nonce",
		enforceNonce: true,
	}, "manager presentation creates must suppress embeds without changing content, controls, nonce, or mention safety");
	assert.deepEqual(normalizePresentationPayload(presentationEditPayloads[0]), expectedPresentationPayload,
		"manager presentation edits must retain embed suppression, content, controls, and mention safety");
	const ordinarySendPayloads = [];
	const ordinaryEditPayloads = [];
	const ordinaryMessage = { author: { id: "bot-user" }, async edit(payload) { ordinaryEditPayloads.push(payload); } };
	const ordinaryChannel = {
		isTextBased: () => true,
		isDMBased: () => false,
		async send(payload) { ordinarySendPayloads.push(payload); return { id: "ordinary-message" }; },
		messages: { async fetch() { return ordinaryMessage; } },
	};
	const ordinaryTransport = new DiscordJsTransport();
	ordinaryTransport.readyClient = () => ({ user: { id: "bot-user" }, channels: { async fetch() { return ordinaryChannel; } } });
	ordinaryTransport.textChannel = async () => ordinaryChannel;
	assert.equal(await ordinaryTransport.sendText("session-thread", "ordinary https://example.com", "ordinary-nonce"), "ordinary-message");
	await ordinaryTransport.editOwnText("session-thread", "ordinary-message", "edited ordinary https://example.com");
	assert.deepEqual(ordinarySendPayloads, [{
		content: "ordinary https://example.com",
		nonce: "ordinary-nonce",
		enforceNonce: true,
		allowedMentions: { parse: [] },
	}], "ordinary project and session sends must retain automatic embeds");
	assert.deepEqual(ordinaryEditPayloads, [{
		content: "edited ordinary https://example.com",
		allowedMentions: { parse: [] },
	}], "ordinary edits must retain automatic embeds");
	const managerDefinition = managerCommandDefinition();
	assert.equal(managerDefinition.name, "m");
	const commandRegistrationEvents = [];
	const commandRegistrationTransport = new DiscordJsTransport();
	commandRegistrationTransport.guild = async () => ({
		commands: {
			async fetch() {
				return [{ id: "pi-command", name: "pi" }, { id: "legacy-manager-command", name: "manager" }];
			},
			async delete(id) { commandRegistrationEvents.push(["delete", id]); },
			async edit(id, definition) { commandRegistrationEvents.push(["edit", id, definition.name]); },
			async create(definition) { commandRegistrationEvents.push(["create", definition.name]); },
		},
	});
	await commandRegistrationTransport.registerControls("guild");
	assert.deepEqual(commandRegistrationEvents, [
		["delete", "legacy-manager-command"],
		["edit", "pi-command", "pi"],
		["create", "m"],
	], "command registration must remove /manager instead of retaining a compatibility alias");
	assert.deepEqual(managerDefinition.options.map((option) => option.name), [
		"handoff", "takeback", "archive", "merge-and-archive", "reconcile-pr", "ask",
	]);
	for (const option of managerDefinition.options.slice(0, 4)) {
		assert.deepEqual(option.options.map(({ name, required, autocomplete }) => ({ name, required, autocomplete })), [
			{ name: "task", required: true, autocomplete: true },
		], `${option.name} must retain exactly one required dynamic task option`);
	}
	assert.deepEqual(managerDefinition.options[4].options.map(({ name, required, autocomplete }) => ({ name, required, autocomplete })), [
		{ name: "task", required: false, autocomplete: true },
	], "reconcile-pr must expose exactly one optional dynamic task option");
	assert.deepEqual(managerDefinition.options[5].options.map(({ name, required, autocomplete, maxLength }) => ({
		name, required, autocomplete, maxLength,
	})), [{ name: "target", required: true, autocomplete: true, maxLength: undefined }, {
		name: "request", required: true, autocomplete: undefined, maxLength: 2_000,
	}], "ask must expose only the required dynamic target and bounded request options");
	assert.equal(JSON.stringify(managerDefinition).includes('"status"'), false, "/m must not expose status");
	const canonicalReconcileScanWindowMs = 60_000;
	assert.ok(MANAGER_CONTROL_PROCESS_TIMEOUT_MS > canonicalReconcileScanWindowMs,
		"bridge process timeout must exceed the canonical taskless scan window");
	assert.ok(MANAGER_CONTROL_IPC_TIMEOUT_MS > MANAGER_CONTROL_PROCESS_TIMEOUT_MS,
		"manager IPC timeout must exceed the bridge process timeout");
	assert.ok(MANAGER_CONTROL_INTERACTION_TIMEOUT_MS > MANAGER_CONTROL_IPC_TIMEOUT_MS,
		"Discord interaction timeout must exceed the full bridge and IPC execution envelope");
	const timerTransport = new DiscordJsTransport();
	let timerRequest;
	timerTransport.onManagerControl(async (request) => {
		timerRequest = request;
		return { ok: true, message: "settled" };
	});
	const managerInteractionReplies = [];
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const managerInteractionTimer = { unref() {} };
	let clearedManagerInteractionTimer;
	try {
		globalThis.setTimeout = (_callback, milliseconds) => {
			assert.equal(milliseconds, MANAGER_CONTROL_INTERACTION_TIMEOUT_MS);
			return managerInteractionTimer;
		};
		globalThis.clearTimeout = (timer) => { clearedManagerInteractionTimer = timer; };
		await timerTransport.executeManagerControlInteraction({
			id: "timer-manager-control",
			channelId: "timer-manager-thread",
			async deferReply() {},
			options: {
				getSubcommand: () => "handoff",
				getString: (name, required) => {
					assert.deepEqual([name, required], ["task", true]);
					return "timer-task";
				},
			},
			async editReply(reply) { managerInteractionReplies.push(reply); },
		}, "timer-manager-thread");
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}
	assert.equal(clearedManagerInteractionTimer, managerInteractionTimer,
		"the 180-second Discord interaction timer must clear when manager execution settles");
	assert.deepEqual(timerRequest, {
		requestId: "timer-manager-control",
		channelId: "timer-manager-thread",
		action: "handoff",
		taskId: "timer-task",
	});
	assert.equal(managerInteractionReplies[0].content, "✅ settled");
	await timerTransport.executeManagerControlInteraction({
		id: "reconcile-manager-control",
		channelId: "timer-manager-thread",
		async deferReply() {},
		options: {
			getSubcommand: () => "reconcile-pr",
			getString: (name, required) => {
				assert.deepEqual([name, required], ["task", false]);
				return "timer-task";
			},
		},
		async editReply(reply) { managerInteractionReplies.push(reply); },
	}, "timer-manager-thread");
	assert.deepEqual(timerRequest, {
		requestId: "reconcile-manager-control",
		channelId: "timer-manager-thread",
		action: "reconcile-pr",
		taskId: "timer-task",
	}, "Discord reconcile-pr interactions must retain dynamic task selection");
	await timerTransport.executeManagerControlInteraction({
		id: "reconcile-manager-all",
		channelId: "timer-manager-thread",
		async deferReply() {},
		options: {
			getSubcommand: () => "reconcile-pr",
			getString: (name, required) => {
				assert.deepEqual([name, required], ["task", false]);
				return null;
			},
		},
		async editReply(reply) { managerInteractionReplies.push(reply); },
	}, "timer-manager-thread");
	assert.deepEqual(timerRequest, {
		requestId: "reconcile-manager-all",
		channelId: "timer-manager-thread",
		action: "reconcile-pr",
	}, "taskless Discord reconcile-pr interactions must omit taskId");
	await timerTransport.executeManagerControlInteraction({
		id: "ask-manager-control",
		channelId: "timer-manager-thread",
		async deferReply() {},
		options: {
			getSubcommand: () => "ask",
			getString: (name) => name === "target" ? "project:pi-extensions" : "Inspect it",
		},
		async editReply(reply) { managerInteractionReplies.push(reply); },
	}, "timer-manager-thread");
	assert.deepEqual(timerRequest, {
		requestId: "ask-manager-control",
		channelId: "timer-manager-thread",
		action: "ask",
		target: "project:pi-extensions",
		request: "Inspect it",
	}, "Discord ask interactions must route both required options without task coercion");
	assert.equal(managerInteractionReplies[3].content, "✅ settled");

	let managerStatus = {
		...focusedManagerStatus,
		summary: { tasks: 1, pending_events: 0, ready_tasks: 0, orphan_events: 0 },
		tasks: [{
			task_id: "discord-manager-task-summary",
			title: "Discord @everyone summary",
			project: "pi-extensions",
			status: "active",
			current_action: "implement",
			current_run: "implement-1",
		}],
	};
	const managerWatchListeners = [];
	const producedManagerCatalogues = [];
	const producedProjectCatalogues = [];
	let managerProjectsContent = "---\nprojects:\n  pi-extensions:\n    repository: /tmp/pi-extensions\n---\n";
	const producerErrors = [];
	const managerProducer = await ManagerTaskSummaryProducer.create(managerFixture, {
		onTaskCatalogue: (catalogue) => producedManagerCatalogues.push(catalogue),
		onProjectCatalogue: (catalogue) => producedProjectCatalogues.push(catalogue),
		onError: (error) => producerErrors.push(error),
	}, {
		readStatus: async () => structuredClone(managerStatus),
		readProjects: async () => managerProjectsContent,
		watchDirectory: (_path, listener) => {
			managerWatchListeners.push(listener);
			const watcher = new EventEmitter();
			watcher.close = () => {};
			return watcher;
		},
	});
	assert.ok(managerProducer, "the-manager checkout must activate the canonical status producer");
	managerProducer.start();
	await waitFor(() => producedManagerCatalogues.length === 1 && producedProjectCatalogues.length === 1,
		"initial manager task and project catalogues");
	managerStatus = {
		...managerStatus,
		summary: { tasks: 1, pending_events: 1, ready_tasks: 1, orphan_events: 0 },
		tasks: [{ ...managerStatus.tasks[0], status: "ready", current_action: "review", current_run: "review-1" }],
	};
	managerWatchListeners[0]();
	await waitFor(() => producedManagerCatalogues.length === 2, "task-change manager catalogue");
	assert.equal(producedManagerCatalogues[1][0].status, "ready", "filesystem events must refresh the task autocomplete catalogue without polling");
	managerProjectsContent = "---\nprojects:\n  pi-extensions:\n    repository: /tmp/pi-extensions\n  wordpress:\n    repository: /tmp/wordpress\n---\n";
	managerWatchListeners[2]();
	await waitFor(() => producedProjectCatalogues.length === 3, "project registry manager catalogue refresh");
	assert.deepEqual(producedProjectCatalogues[2], [{ projectId: "pi-extensions" }, { projectId: "wordpress" }],
		"project registry changes must refresh without polling");
	assert.deepEqual(producerErrors, []);
	managerProducer.stop();

	const opaqueContent = "hostile task: ready\nPROJECTS: never parse\ngithub-status.json: {broken}\n@everyone";
	const validPresentationEnvelope = {
		ok: true, command: "summary-render", schema_version: 1, revision: "9".repeat(64), content: opaqueContent,
		controls: [{ id: "github-refresh-reconcile", label: "Manager label", style: "secondary", command: "github-refresh-reconcile" }],
		degraded: true, warnings: ["opaque warning"],
	};
	assert.equal(parseManagerPresentationEnvelope(validPresentationEnvelope).content, opaqueContent, "content must remain byte-for-byte opaque");
	for (const [name, mutation] of [
		["unknown control", { controls: [{ id: "other", label: "Other", style: "secondary", command: "other" }] }],
		["unsupported command", { controls: [{ id: "github-refresh-reconcile", label: "Refresh", style: "secondary", command: "status" }] }],
		["mismatched command", { controls: [{ id: "github-refresh-reconcile", label: "Refresh", style: "secondary", command: "task-reconcile-pr" }] }],
		["bad revision", { revision: "A".repeat(64) }],
		["empty content", { content: "" }],
		["overlong content", { content: "x".repeat(2_001) }],
		["overlong label", { controls: [{ id: "github-refresh-reconcile", label: "x".repeat(81), style: "secondary", command: "github-refresh-reconcile" }] }],
		["unknown style", { controls: [{ id: "github-refresh-reconcile", label: "Refresh", style: "link", command: "github-refresh-reconcile" }] }],
	]) {
		assert.throws(() => parseManagerPresentationEnvelope({ ...validPresentationEnvelope, ...mutation }), /invalid presentation/, name);
	}
	const presentationWatchers = [], producedPresentations = [], presentationErrors = [];
	let renderedEnvelope = validPresentationEnvelope;
	const presentationProducer = await ManagerPresentationProducer.create(managerFixture, {
		onPresentation: (presentation) => producedPresentations.push(presentation),
		onUnavailable: (error) => presentationErrors.push(error),
	}, {
		render: async (verifiedRoot) => {
			assert.equal(verifiedRoot, await realpath(managerFixture));
			return structuredClone(renderedEnvelope);
		},
		watchDirectory: (_path, listener) => {
			presentationWatchers.push(listener);
			const watcher = new EventEmitter();
			watcher.close = () => {};
			return watcher;
		},
	});
	presentationProducer.start();
	await waitFor(() => producedPresentations.length === 1, "initial opaque manager presentation");
	assert.deepEqual(producedPresentations[0], parseManagerPresentationEnvelope(validPresentationEnvelope));
	renderedEnvelope = { ...validPresentationEnvelope, revision: "8".repeat(64), content: "atomic external status result" };
	presentationWatchers[1]();
	await waitFor(() => producedPresentations.length === 2, "atomic data watcher presentation refresh");
	assert.equal(producedPresentations[1].content, "atomic external status result");
	renderedEnvelope = { ...validPresentationEnvelope, content: "" };
	presentationWatchers[0]();
	await waitFor(() => presentationErrors.length === 1, "malformed presentation callback");
	assert.equal(producedPresentations.length, 2, "malformed output must not replace the last valid presentation");
	presentationProducer.stop();
	await writeFile(join(managerFixture, "status.json"), `${JSON.stringify(managerStatus)}\n`);
	const managerPresentation = (revision, content, controls = [{
		id: "github-refresh-reconcile", label: "Refresh & Reconcile", style: "secondary", command: "github-refresh-reconcile",
	}]) => ({ ok: true, command: "summary-render", schema_version: 1, revision, content, controls, degraded: false, warnings: [] });
	await writeFile(join(managerFixture, "presentation.json"), `${JSON.stringify(managerPresentation("a".repeat(64), "opaque manager payload @everyone"))}\n`);

	const managerExecutorRoot = join(dataDir, "manager-executor");
	await mkdir(join(managerExecutorRoot, "bin"), { recursive: true });
	await mkdir(join(managerExecutorRoot, "data", "tasks"), { recursive: true });
	await writeFile(join(managerExecutorRoot, "bin", "manager.mjs"), "// fixture\n");
	await writeFile(join(managerExecutorRoot, "bin", "manager-runtime.mjs"), "// fixture\n");
	const canonicalExecutorProjects = (ids) => `---\nprojects:\n${ids.map((id) => `  ${id}:\n    repository: /tmp/${id}`).join("\n")}\n---\n`;
	await writeFile(join(managerExecutorRoot, "data", "PROJECTS.md"), canonicalExecutorProjects(["pi-extensions", "safe-task"]));
	let canonicalExecutorStatus = {
		ok: true,
		command: "status",
		schema_version: 1,
		summary: { tasks: 1, pending_events: 0, ready_tasks: 1, orphan_events: 0 },
		tasks: [{
			task_id: "safe-task",
			title: "Safe task",
			project: "pi-extensions",
			status: "ready",
			current_action: "review",
			current_run: "review-1",
		}],
	};
	const managerProcessCalls = [];
	let managerProcessFailure;
	let reconcileOutput = { ok: true, command: "task-reconcile-pr", task_id: "safe-task", state: "not-found", archived: false };
	let reconcileBatchOutput = {
		ok: true, command: "task-reconcile-pr", scope: "all", scanned: 7,
		results: [{
			task_id: "batch-closed", state: "closed", archived: false, url: "https://github.com/acme/repo/pull/11", number: 11,
		}, {
			task_id: "batch-failed", state: "error", archived: false, error: "canonical per-task refusal",
		}, {
			task_id: "batch-merged", state: "merged", archived: true, url: "https://github.com/acme/repo/pull/12", number: 12,
			merged_at: "2026-08-02T14:00:00Z", merge_commit: "a".repeat(40), checkout_mode: "repository", slot_state: null, replay: false,
		}, {
			task_id: "batch-missing", state: "not-found", archived: false,
		}, {
			task_id: "batch-mixed", state: "mixed", archived: false, references: [
				{ kind: "issue", state: "closed", url: "https://github.com/acme/repo/issues/14", number: 14 },
				{ kind: "pull-request", state: "open", url: "https://github.com/acme/repo/pull/15", number: 15 },
			],
		}, {
			task_id: "batch-open", state: "open", archived: false, url: "https://github.com/acme/repo/pull/13", number: 13,
		}, {
			task_id: "batch-terminal", state: "terminal", archived: true, references: [
				{ kind: "issue", state: "closed", url: "https://github.a8c.com/acme/repo/issues/16", number: 16 },
				{ kind: "pull-request", state: "merged", url: "https://github.a8c.com/acme/repo/pull/17", number: 17,
					merged_at: "2026-08-03T15:00:00.123Z", merge_commit: "b".repeat(64) },
			], checkout_mode: "repository", slot_state: null, replay: false,
		}],
		summary: { archived: 2, merged: 1, closed: 1, terminal: 1, open: 1, mixed: 1, not_found: 1, failed: 1 },
	};
	const managerRun = async (executable, args, options) => {
		managerProcessCalls.push({ executable, args, options });
		if (args.at(-1) === "validate") return { code: 0, stdout: '{"valid":true}\n', stderr: "" };
		if (args[1] === "status") return { code: 0, stdout: `${JSON.stringify(canonicalExecutorStatus)}\n`, stderr: "" };
		if (managerProcessFailure) return managerProcessFailure;
		const command = args[1];
		if (command === "task-reconcile-pr" && !args.includes("--task")) {
			return { code: 0, stdout: `${JSON.stringify(reconcileBatchOutput)}\n`, stderr: "" };
		}
		if (command === "github-status-refresh") return { code: 0, stdout: "hostile non-JSON stdout", stderr: "" };
		const taskId = args[args.indexOf("--task") + 1].split("/").at(-1).replace(/\.md$/, "");
		if (command === "task-reconcile-pr") return { code: 0, stdout: `${JSON.stringify(reconcileOutput)}\n`, stderr: "" };
		const output = command === "handoff-start"
			? { ok: true, command, task_id: taskId, state: "direct", worker_session: "mgr-worker", replay: false }
			: command === "handoff-return"
				? { ok: true, command, task_id: taskId, state: "return-requested", worker_session: "mgr-worker", replay: false }
				: { ok: true, command, task_id: taskId, archived: true, checkout_mode: "repository", slot_state: null, replay: false };
		return { code: 0, stdout: `${JSON.stringify(output)}\n`, stderr: "" };
	};
	const validManagerEnvironment = {
		HERDR_ENV: "1",
		THE_MANAGER_ROLE: "manager",
		HERDR_WORKSPACE_ID: "w-manager",
		HERDR_PANE_ID: "w-manager:p1",
		HERDR_SOCKET_PATH: "/tmp/herdr.sock",
	};
	const invalidManagerEnvironments = [
		["missing HERDR_ENV", { ...validManagerEnvironment, HERDR_ENV: undefined }],
		["wrong HERDR_ENV", { ...validManagerEnvironment, HERDR_ENV: "true" }],
		["worker role", { ...validManagerEnvironment, THE_MANAGER_ROLE: "worker" }],
		["missing workspace", { ...validManagerEnvironment, HERDR_WORKSPACE_ID: undefined }],
		["invalid workspace", { ...validManagerEnvironment, HERDR_WORKSPACE_ID: "bad workspace" }],
		["missing pane", { ...validManagerEnvironment, HERDR_PANE_ID: undefined }],
		["invalid pane", { ...validManagerEnvironment, HERDR_PANE_ID: "bad/pane" }],
		["missing socket", { ...validManagerEnvironment, HERDR_SOCKET_PATH: undefined }],
		["relative socket", { ...validManagerEnvironment, HERDR_SOCKET_PATH: "relative/herdr.sock" }],
	];
	const callsBeforeEnvironmentChecks = managerProcessCalls.length;
	for (const [description, environment] of invalidManagerEnvironments) {
		assert.equal(await ManagerControlExecutor.create(managerExecutorRoot, { run: managerRun, environment }), undefined,
			`${description} must not advertise manager controls`);
	}
	assert.equal(managerProcessCalls.length, callsBeforeEnvironmentChecks,
		"unprotected manager environments must be rejected before runtime validation");
	const managerExecutor = await ManagerControlExecutor.create(managerExecutorRoot, {
		run: managerRun,
		environment: validManagerEnvironment,
	});
	assert.ok(managerExecutor, "a protected non-worker Herdr environment plus canonical runtime validation must verify manager controls");
	const executorCatalogue = [{ taskId: "safe-task", project: "pi-extensions", title: "Safe task", status: "ready" }];
	let delayedProcessArgs;
	let delayedProcessOptions;
	let settleDelayedProcess;
	let markDelayedProcessStarted;
	const delayedProcessStarted = new Promise((resolve) => { markDelayedProcessStarted = resolve; });
	const delayedBatchOutput = {
		ok: true, command: "task-reconcile-pr", scope: "all", scanned: 2,
		results: [{
			task_id: "finished-open", state: "open", archived: false, url: "https://github.com/acme/repo/pull/21", number: 21,
		}, {
			task_id: "window-exhausted", state: "error", archived: false,
			error: "pull request reconciliation scan time budget exhausted",
		}],
		summary: { archived: 0, merged: 0, closed: 0, terminal: 0, open: 1, mixed: 0, not_found: 0, failed: 1 },
	};
	const delayedExecutor = await ManagerControlExecutor.create(managerExecutorRoot, {
		environment: validManagerEnvironment,
		async run(_executable, args, options) {
			if (args.at(-1) === "validate") return { code: 0, stdout: '{"valid":true}\n', stderr: "" };
			delayedProcessArgs = args;
			delayedProcessOptions = options;
			markDelayedProcessStarted();
			return new Promise((resolve) => {
				settleDelayedProcess = () => resolve({ code: 0, stdout: `${JSON.stringify(delayedBatchOutput)}\n`, stderr: "" });
			});
		},
	});
	assert.ok(delayedExecutor);
	const delayedTransport = new DiscordJsTransport();
	delayedTransport.onManagerControl((request) => delayedExecutor.execute(request, executorCatalogue));
	const delayedReplies = [];
	const delayedInteractionTimer = { unref() {} };
	let clearedDelayedTimer;
	let delayedTimeoutCallback;
	const savedSetTimeout = globalThis.setTimeout;
	const savedClearTimeout = globalThis.clearTimeout;
	try {
		globalThis.setTimeout = (callback, milliseconds) => {
			assert.equal(milliseconds, MANAGER_CONTROL_INTERACTION_TIMEOUT_MS);
			delayedTimeoutCallback = callback;
			return delayedInteractionTimer;
		};
		globalThis.clearTimeout = (timer) => { clearedDelayedTimer = timer; };
		const delayedInteraction = delayedTransport.executeManagerControlInteraction({
			id: "delayed-reconcile-all",
			channelId: "delayed-manager-thread",
			async deferReply() {},
			options: {
				getSubcommand: () => "reconcile-pr",
				getString: () => null,
			},
			async editReply(reply) { delayedReplies.push(reply); },
		}, "delayed-manager-thread");
		await delayedProcessStarted;
		assert.deepEqual(delayedProcessArgs, [join(managerExecutorRoot, "bin", "manager.mjs"), "task-reconcile-pr",
			"--root", managerExecutorRoot], "delayed taskless execution must preserve exact canonical argv");
		assert.equal(delayedProcessOptions.timeout, MANAGER_CONTROL_PROCESS_TIMEOUT_MS);
		assert.ok(delayedProcessOptions.timeout > canonicalReconcileScanWindowMs,
			"delayed canonical scans retain headroom before the bridge process timeout");
		assert.equal(delayedReplies.length, 0, "the interaction must remain pending while canonical reconciliation runs");
		assert.equal(typeof delayedTimeoutCallback, "function", "the outer interaction timeout must remain armed while work runs");
		settleDelayedProcess();
		await delayedInteraction;
	} finally {
		globalThis.setTimeout = savedSetTimeout;
		globalThis.clearTimeout = savedClearTimeout;
	}
	assert.equal(clearedDelayedTimer, delayedInteractionTimer,
		"settled delayed canonical execution must clear the Discord interaction timer");
	assert.deepEqual(delayedReplies.map((reply) => reply.content), [
		"✅ Reconciled 2 tasks: 0 archived, 1 open, 0 terminal, 0 not found, 1 failed. Failed: @window-exhausted.",
	], "canonical partial results must win the timeout race and remain visible");
	for (const action of ["handoff", "takeback", "archive", "merge-and-archive"]) {
		assert.equal((await managerExecutor.execute({ requestId: `executor-${action}`, action, taskId: "safe-task" }, executorCatalogue)).ok, true);
	}
	const reconcileCases = [{
		output: reconcileOutput,
		message: "No pull request found for @safe-task.",
	}, {
		output: { ok: true, command: "task-reconcile-pr", task_id: "safe-task", state: "open", archived: false,
			url: "https://github.com/acme/repo/pull/12", number: 12 },
		message: "PR #12 is open: https://github.com/acme/repo/pull/12",
	}, {
		output: { ok: true, command: "task-reconcile-pr", task_id: "safe-task", state: "closed", archived: false,
			url: "https://github.com/acme/repo/pull/12", number: 12 },
		message: "PR #12 is closed: https://github.com/acme/repo/pull/12",
	}, {
		output: { ok: true, command: "task-reconcile-pr", task_id: "safe-task", state: "merged", archived: true,
			url: "https://github.com/acme/repo/pull/12", number: 12, merged_at: "2026-08-02T14:00:00Z",
			merge_commit: "a".repeat(40), checkout_mode: "repository", slot_state: null, replay: false },
		message: "PR #12 merged; @safe-task archived without local merge.",
	}];
	for (const [index, reconcileCase] of reconcileCases.entries()) {
		reconcileOutput = reconcileCase.output;
		assert.deepEqual(await managerExecutor.execute({
			requestId: `executor-reconcile-${index}`, action: "reconcile-pr", taskId: "safe-task",
		}, executorCatalogue), { ok: true, message: reconcileCase.message });
	}
	reconcileOutput = {
		ok: true, command: "task-reconcile-pr", task_id: "safe-task", state: "merged", archived: true,
		url: "https://github.com/acme/repo/pull/12", number: 12, merged_at: "2026-08-02T14:00:00Z", merge_commit: "a".repeat(40),
	};
	assert.equal((await managerExecutor.execute({
		requestId: "executor-reconcile-optional-cleanup", action: "reconcile-pr", taskId: "safe-task",
	}, executorCatalogue)).ok, true, "documented optional merged cleanup fields may be absent");
	assert.deepEqual(await managerExecutor.execute({
		requestId: "executor-reconcile-batch", action: "reconcile-pr",
	}, executorCatalogue), {
		ok: true,
		message: "Reconciled 7 tasks: 2 archived, 1 open, 3 terminal, 1 not found, 1 failed. Failed: @batch-failed.",
	}, "taskless reconcile-pr must summarize every canonical batch state");
	const validReconcileBatchOutput = structuredClone(reconcileBatchOutput);
	const manyFailedResults = Array.from({ length: 12 }, (_, index) => ({
		task_id: `failed-task-${index + 1}`, state: "error", archived: false, error: `failure ${index + 1}`,
	}));
	reconcileBatchOutput = {
		ok: true, command: "task-reconcile-pr", scope: "all", scanned: manyFailedResults.length,
		results: manyFailedResults,
		summary: { archived: 0, merged: 0, closed: 0, terminal: 0, open: 0, mixed: 0, not_found: 0, failed: manyFailedResults.length },
	};
	const boundedBatch = await managerExecutor.execute({
		requestId: "executor-reconcile-batch-bounded", action: "reconcile-pr",
	}, executorCatalogue);
	assert.match(boundedBatch.message, /Failed: @failed-task-1,.*@failed-task-10, … 2 more\.$/,
		"batch summaries must bound failed task IDs");
	assert.doesNotMatch(boundedBatch.message, /@failed-task-11/, "bounded batch summaries must omit excess failed task IDs");
	reconcileBatchOutput = {
		ok: true, command: "task-reconcile-pr", scope: "all", scanned: 2,
		results: [{ task_id: "legacy-merged", state: "merged", archived: true,
			url: "https://github.com/acme/repo/pull/31", number: 31, merged_at: "2026-08-04T17:00:00Z",
			merge_commit: "e".repeat(40) },
		{ task_id: "legacy-open", state: "open", archived: false,
			url: "https://github.com/acme/repo/pull/32", number: 32 }],
		summary: { merged: 1, open: 1, closed: 0, not_found: 0, failed: 0 },
	};
	assert.deepEqual(await managerExecutor.execute({
		requestId: "executor-reconcile-legacy-batch", action: "reconcile-pr",
	}, executorCatalogue), {
		ok: true, message: "Reconciled 2 tasks: 1 merged, 1 open, 0 closed, 0 not found, 0 failed.",
	}, "pre-37c72bd exact branch-PR batches must retain rolling compatibility");
	const referencedReconcileCases = [{
		output: { ok: true, command: "task-reconcile-pr", task_id: "safe-task", state: "closed", archived: true,
			references: [{ kind: "issue", state: "closed", url: "https://github.com/acme/repo/issues/21", number: 21 }],
			checkout_mode: "repository", slot_state: null, replay: false },
		message: "@safe-task: 1 GitHub reference reconciled; task archived.",
	}, {
		output: { ok: true, command: "task-reconcile-pr", task_id: "safe-task", state: "open", archived: false,
			references: [{ kind: "issue", state: "open", url: "https://github.com/acme/repo/issues/22", number: 22 }] },
		message: "@safe-task: 1 GitHub reference reconciled; task retained (open).",
	}, {
		output: { ok: true, command: "task-reconcile-pr", task_id: "safe-task", state: "mixed", archived: false,
			references: [
				{ kind: "issue", state: "closed", url: "https://github.com/acme/repo/issues/23", number: 23 },
				{ kind: "pull-request", state: "open", url: "https://github.com/acme/repo/pull/24", number: 24 },
			] },
		message: "@safe-task: 2 GitHub references reconciled; task retained (mixed).",
	}, {
		output: { ok: true, command: "task-reconcile-pr", task_id: "safe-task", state: "merged", archived: true,
			references: [{ kind: "pull-request", state: "merged", url: "https://github.a8c.com/acme/repo/pull/25", number: 25,
				merged_at: "2026-08-04T16:00:00Z", merge_commit: "c".repeat(40) }] },
		message: "@safe-task: 1 GitHub reference reconciled; task archived.",
	}];
	for (const [index, reconcileCase] of referencedReconcileCases.entries()) {
		reconcileOutput = reconcileCase.output;
		assert.deepEqual(await managerExecutor.execute({
			requestId: `executor-reconcile-referenced-${index}`, action: "reconcile-pr", taskId: "safe-task",
		}, executorCatalogue), { ok: true, message: reconcileCase.message });
	}
	const managerActionCalls = managerProcessCalls.filter((call) => call.args.at(-1) !== "validate");
	assert.deepEqual(managerActionCalls.map((call) => call.args[1]), [
		"handoff-start", "handoff-return", "task-archive", "task-merge-and-archive",
		"task-reconcile-pr", "task-reconcile-pr", "task-reconcile-pr", "task-reconcile-pr", "task-reconcile-pr",
		"task-reconcile-pr", "task-reconcile-pr", "task-reconcile-pr", "task-reconcile-pr", "task-reconcile-pr",
		"task-reconcile-pr", "task-reconcile-pr",
	], "Discord controls must route only through canonical manager CLI composites");
	assert.ok(managerActionCalls[2].args.includes("--completion-authorized"), "archive must carry explicit non-merge completion authorization");
	assert.equal(managerActionCalls[3].args.includes("--completion-authorized"), false,
		"merge-and-archive must use only its dedicated canonical composite");
	assert.deepEqual(managerActionCalls[4].args, [join(managerExecutorRoot, "bin", "manager.mjs"), "task-reconcile-pr",
		"--root", managerExecutorRoot, "--task", join(managerExecutorRoot, "data", "tasks", "safe-task.md")],
	"single reconcile-pr must preserve exact canonical task routing");
	assert.deepEqual(managerActionCalls[9].args, [join(managerExecutorRoot, "bin", "manager.mjs"), "task-reconcile-pr",
		"--root", managerExecutorRoot],
	"taskless reconcile-pr must delegate only to the canonical manager composite without task or bridge policy arguments");
	assert.equal(managerActionCalls.every((call) => call.executable === process.execPath && call.options.cwd === managerExecutorRoot), true);
	assert.equal(managerActionCalls.slice(0, 9).every((call) =>
		call.args.includes(join(managerExecutorRoot, "data", "tasks", "safe-task.md"))), true,
	"supplied task selection must resolve only to the canonical active task path");
	const deliveredAskRequests = [];
	const executorProjects = [{ projectId: "pi-extensions" }, { projectId: "safe-task" }];
	assert.deepEqual(await managerExecutor.execute({
		requestId: "ask-project",
		action: "ask",
		target: "project:safe-task",
		request: "  Inspect the project \n",
	}, executorCatalogue, executorProjects, (message) => deliveredAskRequests.push(message)), {
		ok: true,
		message: "Request sent to project safe-task.",
	});
	assert.deepEqual(await managerExecutor.execute({
		requestId: "ask-task",
		action: "ask",
		target: "task:safe-task",
		request: "Inspect the task",
	}, executorCatalogue, executorProjects, (message) => deliveredAskRequests.push(message)), {
		ok: true,
		message: "Request sent to task safe-task.",
	});
	assert.deepEqual(deliveredAskRequests, [
		"Project: safe-task\n\nInspect the project",
		"Project: pi-extensions\nTask: safe-task\n\nInspect the task",
	], "ask must derive exact project/task context and deliver trimmed TUI-compatible requests");
	assert.deepEqual(await managerExecutor.execute({
		requestId: "ask-whitespace",
		action: "ask",
		target: "project:safe-task",
		request: "  \n\t  ",
	}, executorCatalogue, executorProjects, () => assert.fail("whitespace-only asks must not deliver")), {
		ok: false,
		message: "Manager requests must contain 1-2000 characters after trimming.",
	});
	assert.deepEqual(await managerExecutor.execute({
		requestId: "ask-inactive-task",
		action: "ask",
		target: "task:safe-task",
		request: "Do not send",
	}, [{ ...executorCatalogue[0], status: "complete" }], executorProjects, () => assert.fail("inactive asks must not deliver")), {
		ok: false,
		message: "Select a target from this manager session's current autocomplete catalogue.",
	});
	assert.deepEqual(await managerExecutor.execute({
		requestId: "ask-stale",
		action: "ask",
		target: "project:missing",
		request: "Do not send",
	}, executorCatalogue, executorProjects, () => assert.fail("stale asks must not deliver")), {
		ok: false,
		message: "Select a target from this manager session's current autocomplete catalogue.",
	});
	assert.deepEqual(await managerExecutor.execute({
		requestId: "ask-oversize",
		action: "ask",
		target: "task:safe-task",
		request: "x".repeat(2_001),
	}, executorCatalogue, executorProjects, () => assert.fail("oversize asks must not deliver")), {
		ok: false,
		message: "Manager requests must contain 1-2000 characters after trimming.",
	});
	const deliveredBeforeCanonicalAdversaries = deliveredAskRequests.length;
	canonicalExecutorStatus = {
		...canonicalExecutorStatus,
		summary: { ...canonicalExecutorStatus.summary, tasks: 0, ready_tasks: 0 },
		tasks: [],
	};
	assert.deepEqual(await managerExecutor.execute({
		requestId: "ask-canonical-removed-task",
		action: "ask",
		target: "task:safe-task",
		request: "Do not send",
	}, executorCatalogue, executorProjects, () => assert.fail("canonically removed tasks must not deliver")), {
		ok: false,
		message: "The selected task is no longer an active task in a configured project.",
	}, "stale task catalogues must not authorize a removed canonical task");
	canonicalExecutorStatus = {
		...canonicalExecutorStatus,
		summary: { ...canonicalExecutorStatus.summary, tasks: 1 },
		tasks: [{
			task_id: "safe-task", title: "Safe task", project: "pi-extensions", status: "complete",
			current_action: "none", current_run: "review-1",
		}],
	};
	assert.equal((await managerExecutor.execute({
		requestId: "ask-canonical-inactive-task",
		action: "ask",
		target: "task:safe-task",
		request: "Do not send",
	}, executorCatalogue, executorProjects, () => assert.fail("canonically inactive tasks must not deliver"))).ok, false,
	"stale active hints must not authorize a canonically inactive task");
	canonicalExecutorStatus = {
		...canonicalExecutorStatus,
		tasks: [{
			task_id: "safe-task", title: "Safe task", project: "removed-project", status: "ready",
			current_action: "review", current_run: "review-1",
		}],
	};
	assert.equal((await managerExecutor.execute({
		requestId: "ask-canonical-orphan-task",
		action: "ask",
		target: "task:safe-task",
		request: "Do not send",
	}, executorCatalogue, executorProjects, () => assert.fail("tasks outside canonical projects must not deliver"))).ok, false,
	"canonical task metadata must reference a currently configured canonical project");
	canonicalExecutorStatus = {
		...canonicalExecutorStatus,
		tasks: [{
			task_id: "safe-task", title: "Safe task", project: "pi-extensions", status: "ready",
			current_action: "review", current_run: "review-1",
		}],
	};
	await writeFile(join(managerExecutorRoot, "data", "PROJECTS.md"), canonicalExecutorProjects(["pi-extensions"]));
	assert.deepEqual(await managerExecutor.execute({
		requestId: "ask-canonical-removed-project",
		action: "ask",
		target: "project:safe-task",
		request: "Do not send",
	}, executorCatalogue, executorProjects, () => assert.fail("canonically removed projects must not deliver")), {
		ok: false,
		message: "The selected project is no longer configured.",
	}, "stale project catalogues must not authorize a removed canonical project");
	await writeFile(join(managerExecutorRoot, "data", "PROJECTS.md"), "---\nprojects:\n  INVALID:\n---\n");
	assert.equal((await managerExecutor.execute({
		requestId: "ask-canonical-malformed-projects",
		action: "ask",
		target: "project:safe-task",
		request: "Do not send",
	}, executorCatalogue, executorProjects, () => assert.fail("malformed canonical projects must not deliver"))).ok, false,
	"ask must fail closed on malformed canonical project data");
	await writeFile(join(managerExecutorRoot, "data", "PROJECTS.md"), canonicalExecutorProjects(["pi-extensions", "safe-task"]));
	const validCanonicalExecutorStatus = canonicalExecutorStatus;
	canonicalExecutorStatus = { ...canonicalExecutorStatus, tasks: "invalid" };
	assert.equal((await managerExecutor.execute({
		requestId: "ask-canonical-malformed-status",
		action: "ask",
		target: "task:safe-task",
		request: "Do not send",
	}, executorCatalogue, executorProjects, () => assert.fail("malformed canonical status must not deliver"))).ok, false,
	"ask must fail closed on malformed canonical manager status");
	canonicalExecutorStatus = validCanonicalExecutorStatus;
	assert.equal(deliveredAskRequests.length, deliveredBeforeCanonicalAdversaries,
		"canonical stale/removed target refusals must never call deliverAsk");
	assert.equal(managerProcessCalls.filter((call) => [
		"handoff-start", "handoff-return", "task-archive", "task-merge-and-archive", "task-reconcile-pr",
	].includes(call.args[1])).length, 16,
	"ask must not invoke or mutate manager lifecycle state");
	const callsBeforeStale = managerProcessCalls.length;
	assert.deepEqual(await managerExecutor.execute({ requestId: "executor-stale", action: "archive", taskId: "missing-task" }, executorCatalogue), {
		ok: false,
		message: "Select a task from this manager session's current autocomplete catalogue.",
	});
	assert.equal(managerProcessCalls.length, callsBeforeStale, "stale catalogue values must be rejected before any process execution");
	managerProcessFailure = { code: 0, stdout: '{"ok":true,"command":"task-archive","task_id":"other","archived":true}\n', stderr: "" };
	assert.deepEqual(await managerExecutor.execute({ requestId: "executor-conflict", action: "archive", taskId: "safe-task" }, executorCatalogue), {
		ok: false,
		message: "archive returned conflicting manager output.",
	}, "successful exit status alone must not authorize conflicting JSON");
	managerProcessFailure = { code: 0, stdout: "not-json", stderr: "" };
	assert.deepEqual(await managerExecutor.execute({ requestId: "executor-malformed", action: "archive", taskId: "safe-task" }, executorCatalogue), {
		ok: false,
		message: "archive returned malformed JSON.",
	}, "malformed successful output must fail closed");
	managerProcessFailure = { code: 4, stdout: '{"ok":true}', stderr: "canonical manager safety refusal" };
	assert.deepEqual(await managerExecutor.execute({ requestId: "executor-refused", action: "archive", taskId: "safe-task" }, executorCatalogue), {
		ok: false,
		message: "canonical manager safety refusal",
	}, "canonical manager CLI safety refusals must be preserved and never inferred as success");
	managerProcessFailure = undefined;
	const validMergedReconcileOutput = reconcileCases[3].output;
	const conflictingReconcileOutputs = [
		{ ...reconcileCases[0].output, ok: false },
		{ ...reconcileCases[0].output, command: "task-archive" },
		{ ...reconcileCases[0].output, task_id: "other-task" },
		{ ...reconcileCases[0].output, state: "unknown" },
		{ ...reconcileCases[0].output, archived: true },
		{ ...reconcileCases[0].output, url: "https://github.com/acme/repo/pull/12" },
		{ ...reconcileCases[1].output, number: 0 },
		{ ...reconcileCases[1].output, merged_at: "2026-08-02T14:00:00Z" },
		{ ...reconcileCases[2].output, archived: true },
		{ ...validMergedReconcileOutput, merged_at: "not-a-time" },
		{ ...validMergedReconcileOutput, merge_commit: "bad" },
		{ ...validMergedReconcileOutput, replay: "false" },
		{ ...validMergedReconcileOutput, checkout_mode: 42 },
		{ ...validMergedReconcileOutput, unexpected: true },
	];
	for (const [index, output] of conflictingReconcileOutputs.entries()) {
		reconcileOutput = output;
		assert.deepEqual(await managerExecutor.execute({
			requestId: `executor-reconcile-conflict-${index}`, action: "reconcile-pr", taskId: "safe-task",
		}, executorCatalogue), { ok: false, message: "reconcile-pr returned conflicting manager output." },
		`reconcile-pr success schema adversary ${index} must fail closed`);
	}
	const validOpenReferencedOutput = referencedReconcileCases[1].output;
	const validOpenIssue = validOpenReferencedOutput.references[0];
	const validMergedReferencedOutput = referencedReconcileCases[3].output;
	const validMergedReference = validMergedReferencedOutput.references[0];
	const validClosedReferencedOutput = referencedReconcileCases[0].output;
	const conflictingReferencedOutputs = [
		{ ...validOpenReferencedOutput, state: "not-found" },
		{ ...validOpenReferencedOutput, state: "mixed" },
		{ ...validOpenReferencedOutput, archived: true },
		{ ...validClosedReferencedOutput, archived: false },
		{ ...validClosedReferencedOutput, state: "mixed" },
		{ ...validMergedReferencedOutput, state: "terminal" },
		{ ...validOpenReferencedOutput, references: [] },
		{ ...validOpenReferencedOutput, references: Array.from({ length: 6 }, () => validOpenIssue) },
		{ ...validOpenReferencedOutput, references: [{ ...validOpenIssue, kind: "repository" }] },
		{ ...validOpenReferencedOutput, references: [{ ...validOpenIssue, state: "merged" }] },
		{ ...validOpenReferencedOutput, references: [{ ...validOpenIssue, url: "https://example.test/acme/repo/issues/22" }] },
		{ ...validOpenReferencedOutput, references: [{ ...validOpenIssue, url: "https://github.com/acme/repo/pull/22" }] },
		{ ...validOpenReferencedOutput, references: [{ ...validOpenIssue, url: "https://github.com/acme/repo/issues/23" }] },
		{ ...validOpenReferencedOutput, references: [{ ...validOpenIssue, url: `${validOpenIssue.url}/` }] },
		{ ...validOpenReferencedOutput, references: [{ ...validOpenIssue, number: 0 }] },
		{ ...validMergedReferencedOutput, references: [{ ...validMergedReference, merged_at: undefined }] },
		{ ...validMergedReferencedOutput, references: [{ ...validMergedReference, merge_commit: "bad" }] },
		{ ...validOpenReferencedOutput, references: [{ ...validOpenIssue,
			merged_at: "2026-08-04T16:00:00Z", merge_commit: "d".repeat(40) }] },
		{ ...validOpenReferencedOutput, references: [{ ...validOpenIssue, unexpected: true }] },
		{ ...validOpenReferencedOutput, replay: false },
		{ ...validMergedReferencedOutput, unexpected: true },
		{ ...validMergedReferencedOutput, replay: "false" },
	];
	for (const [index, output] of conflictingReferencedOutputs.entries()) {
		reconcileOutput = output;
		assert.deepEqual(await managerExecutor.execute({
			requestId: `executor-reconcile-referenced-conflict-${index}`, action: "reconcile-pr", taskId: "safe-task",
		}, executorCatalogue), { ok: false, message: "reconcile-pr returned conflicting manager output." },
		`referenced reconcile-pr schema adversary ${index} must fail closed`);
	}
	const emptyBatchSummary = { archived: 0, merged: 0, closed: 0, terminal: 0, open: 0, mixed: 0, not_found: 0, failed: 0 };
	const conflictingBatchOutputs = [
		{ ...validReconcileBatchOutput, ok: false },
		{ ok: true, command: "task-reconcile-pr", scope: "all", scanned: 0, results: [],
			summary: { merged: 0, open: 0, closed: 0, not_found: 0, failed: 0, archived: 0 } },
		{ ...validReconcileBatchOutput,
			summary: { merged: 1, open: 1, closed: 1, not_found: 1, failed: 1 } },
		{ ...validReconcileBatchOutput, command: "wrong-command" },
		{ ...validReconcileBatchOutput, scope: "project" },
		{ ...validReconcileBatchOutput, scanned: 51 },
		{ ...validReconcileBatchOutput, scanned: 4 },
		{ ...validReconcileBatchOutput, results: "invalid" },
		{ ...validReconcileBatchOutput, summary: { ...validReconcileBatchOutput.summary, failed: 2 } },
		{ ...validReconcileBatchOutput, summary: { ...validReconcileBatchOutput.summary, archived: 1 } },
		{ ...validReconcileBatchOutput, summary: { ...validReconcileBatchOutput.summary, mixed: 0 } },
		{ ...validReconcileBatchOutput, summary: { ...validReconcileBatchOutput.summary, unexpected: 0 } },
		{ ...validReconcileBatchOutput, results: [...validReconcileBatchOutput.results, validReconcileBatchOutput.results[0]], scanned: 8,
			summary: { ...validReconcileBatchOutput.summary, closed: 2 } },
		{ ok: true, command: "task-reconcile-pr", scope: "all", scanned: 1,
			results: [{ task_id: "bad-open", state: "open", archived: false, url: "https://example.test/pr/1" }],
			summary: { ...emptyBatchSummary, open: 1 } },
		{ ok: true, command: "task-reconcile-pr", scope: "all", scanned: 1,
			results: [{ task_id: "bad-error", state: "error", archived: true, error: "failure" }],
			summary: { ...emptyBatchSummary, failed: 1 } },
		{ ok: true, command: "task-reconcile-pr", scope: "all", scanned: 1,
			results: [{ task_id: "bad-state", state: "pending", archived: false }],
			summary: emptyBatchSummary },
		{ ok: true, command: "task-reconcile-pr", scope: "all", scanned: 1,
			results: [{ ...validReconcileBatchOutput.results[0], ok: true, command: "task-reconcile-pr" }],
			summary: { ...emptyBatchSummary, closed: 1 } },
		{ ok: true, command: "task-reconcile-pr", scope: "all", scanned: 0, results: [], summary: emptyBatchSummary, unexpected: true },
	];
	for (const [index, output] of conflictingBatchOutputs.entries()) {
		reconcileBatchOutput = output;
		assert.deepEqual(await managerExecutor.execute({
			requestId: `executor-reconcile-batch-conflict-${index}`, action: "reconcile-pr",
		}, executorCatalogue), { ok: false, message: "reconcile-pr returned conflicting manager output." },
		`reconcile-pr batch schema adversary ${index} must fail closed`);
	}
	managerProcessFailure = { code: 0, stdout: "not-json", stderr: "" };
	assert.deepEqual(await managerExecutor.execute({
		requestId: "executor-reconcile-batch-malformed", action: "reconcile-pr",
	}, executorCatalogue), { ok: false, message: "reconcile-pr returned malformed JSON." },
	"malformed taskless canonical output must fail closed");
	managerProcessFailure = { code: 4, stdout: "", stderr: "GitHub authorization required" };
	assert.deepEqual(await managerExecutor.execute({
		requestId: "executor-reconcile-refused", action: "reconcile-pr",
	}, executorCatalogue), { ok: false, message: "GitHub authorization required" },
	"taskless reconcile-pr must surface canonical external-gate failures without querying GitHub itself");
	managerProcessFailure = undefined;

	const epochConfig = join(dataDir, "epoch-config.json");
	await saveDiscordConfig({ token: "one", guildId: "12345" }, epochConfig);
	const firstEpoch = (await loadDiscordConfig(epochConfig, {})).epoch;
	await saveDiscordConfig({ token: "two", guildId: "12345" }, epochConfig);
	assert.ok((await loadDiscordConfig(epochConfig, {})).epoch > firstEpoch, "serialized config writes must advance the relay epoch");
	const environmentConfig = join(dataDir, "environment-config.json");
	await writeFile(environmentConfig, JSON.stringify({ token: "file-token", guildId: "12345" }));
	const environmentFirst = await loadDiscordConfig(environmentConfig, { DISCORD_TOKEN: "environment-one" });
	const environmentSecond = await loadDiscordConfig(environmentConfig, { DISCORD_TOKEN: "environment-two" });
	assert.ok(environmentSecond.epoch > environmentFirst.epoch, "environment-only effective config changes need an authoritative epoch");

	const gitIdentityDirectory = join(dataDir, "git identity fixtures");
	const mainCheckout = join(gitIdentityDirectory, "main repository");
	const linkedWorktree = join(gitIdentityDirectory, "linked worktree");
	const runGit = (...args) => {
		const result = spawnSync("git", args, { encoding: "utf8" });
		assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
	};
	await mkdir(mainCheckout, { recursive: true });
	runGit("init", "-q", mainCheckout);
	runGit("-C", mainCheckout, "config", "user.email", "discord-test@example.com");
	runGit("-C", mainCheckout, "config", "user.name", "Discord Test");
	await writeFile(join(mainCheckout, "tracked file"), "initial\n");
	runGit("-C", mainCheckout, "add", "tracked file");
	runGit("-C", mainCheckout, "commit", "-qm", "initial");
	runGit("-C", mainCheckout, "worktree", "add", "-qb", "discord-linked", linkedWorktree);
	const linkedSubdirectory = join(linkedWorktree, "directory with spaces");
	await mkdir(linkedSubdirectory);
	const canonicalMainCheckout = await realpath(mainCheckout);
	assert.equal(await resolveProjectIdentity(mainCheckout), canonicalMainCheckout, "a normal checkout must identify its repository root");
	assert.equal(await resolveProjectIdentity(linkedWorktree), canonicalMainCheckout, "a linked worktree must identify its main checkout");
	assert.equal(await resolveProjectIdentity(linkedSubdirectory), canonicalMainCheckout, "a worktree subdirectory must retain repository identity");
	const linkedContext = await resolveProjectContext(linkedSubdirectory);
	assert.equal(linkedContext.projectIdentity, canonicalMainCheckout);
	assert.equal(linkedContext.checkoutRoot, await realpath(linkedWorktree), "task discovery must retain the current linked-worktree root");

	assert.equal(parseTaskTitle("# Heading task\n\nDetails\n"), "Heading task");
	assert.equal(
		parseTaskTitle("---\ntitle: Frontmatter task\nowner: test\n---\n# Heading task\n"),
		"Frontmatter task",
		"valid frontmatter title must take precedence over the first H1",
	);
	assert.equal(parseTaskTitle("---\ntitle: 'Quoted task'\n---\n"), "Quoted task");
	assert.equal(parseTaskTitle("Task details without an explicit title\n"), undefined);
	assert.equal(parseTaskTitle("---\ntitle: Broken task\n# Missing closing delimiter\n"), undefined);
	assert.equal(parseTaskTitle("---\ntitle: First\ntitle: Second\n---\n# Heading\n"), undefined);
	assert.equal(parseTaskTitle(`# ${"x".repeat(201)}\n`), undefined);
	assert.equal(parseTaskTitle("# Binary\0task\n"), undefined);

	const taskMetadataDirectory = join(gitIdentityDirectory, "task metadata cases");
	await mkdir(taskMetadataDirectory);
	assert.equal(await discoverTaskTitle(taskMetadataDirectory), undefined, "absent TASK.md must preserve session-name fallback");
	await writeFile(join(taskMetadataDirectory, "TASK.md"), "---\ntitle: Valid task title\n---\n# Ignored heading\n");
	assert.equal(await discoverTaskTitle(taskMetadataDirectory), "Valid task title");
	await writeFile(join(taskMetadataDirectory, "TASK.md"), "---\ntitle: Malformed without closing frontmatter\n# Heading\n");
	assert.equal(await discoverTaskTitle(taskMetadataDirectory), undefined, "malformed task metadata must preserve session-name fallback");
	await writeFile(join(taskMetadataDirectory, "TASK.md"), `# Oversized\n${"x".repeat(16_384)}\n`);
	assert.equal(await discoverTaskTitle(taskMetadataDirectory), undefined, "oversized task metadata must be ignored");
	await writeFile(join(taskMetadataDirectory, "TASK.md"), Buffer.from([0x23, 0x20, 0xff, 0x0a]));
	assert.equal(await discoverTaskTitle(taskMetadataDirectory), undefined, "non-UTF-8 task metadata must be ignored");
	await rm(join(taskMetadataDirectory, "TASK.md"));
	const outsideTaskFile = join(gitIdentityDirectory, "outside TASK.md");
	await writeFile(outsideTaskFile, "# Unsafe external title\n");
	await symlink(outsideTaskFile, join(taskMetadataDirectory, "TASK.md"));
	assert.equal(await discoverTaskTitle(taskMetadataDirectory), undefined, "symlinked task metadata outside the checkout must be ignored");
	await writeFile(join(linkedWorktree, "TASK.md"), "# Implement task-title thread naming\n");
	assert.equal(await discoverTaskTitle(linkedContext.checkoutRoot), "Implement task-title thread naming");

	const submoduleSource = join(gitIdentityDirectory, "submodule source");
	await mkdir(submoduleSource);
	runGit("init", "-q", submoduleSource);
	runGit("-C", submoduleSource, "config", "user.email", "discord-test@example.com");
	runGit("-C", submoduleSource, "config", "user.name", "Discord Test");
	await writeFile(join(submoduleSource, "submodule file"), "submodule\n");
	runGit("-C", submoduleSource, "add", "submodule file");
	runGit("-C", submoduleSource, "commit", "-qm", "submodule");
	const submoduleCheckout = join(mainCheckout, "modules", "submodule with spaces");
	runGit("-c", "protocol.file.allow=always", "-C", mainCheckout, "submodule", "add", "-q", submoduleSource, "modules/submodule with spaces");
	assert.equal(
		await resolveProjectIdentity(submoduleCheckout),
		await realpath(submoduleCheckout),
		"a submodule must use its working tree instead of internal parent-repository metadata",
	);

	const bareRepository = join(gitIdentityDirectory, "bare repository.git");
	runGit("init", "--bare", "-q", bareRepository);
	assert.equal(await resolveProjectIdentity(bareRepository), await realpath(bareRepository), "a bare repository must remain a stable project identity");

	const sameBasenameOne = join(gitIdentityDirectory, "one", "shared");
	const sameBasenameTwo = join(gitIdentityDirectory, "two", "shared");
	await mkdir(sameBasenameOne, { recursive: true });
	await mkdir(sameBasenameTwo, { recursive: true });
	runGit("init", "-q", sameBasenameOne);
	runGit("init", "-q", sameBasenameTwo);
	assert.notEqual(
		await resolveProjectIdentity(sameBasenameOne),
		await resolveProjectIdentity(sameBasenameTwo),
		"unrelated same-basename repositories must not collapse to one identity",
	);
	const nonGitDirectory = join(gitIdentityDirectory, "ordinary directory");
	await mkdir(nonGitDirectory);
	assert.equal(await resolveProjectIdentity(nonGitDirectory), resolve(nonGitDirectory), "non-Git paths must retain normalized cwd identity");
	assert.equal(
		await resolveProjectIdentity(nonGitDirectory, { gitExecutable: join(gitIdentityDirectory, "missing git") }),
		resolve(nonGitDirectory),
		"missing Git must fall back to normalized cwd",
	);
	const malformedGit = join(gitIdentityDirectory, "malformed git");
	await writeFile(malformedGit, "#!/bin/sh\nprintf 'not-an-absolute-path\\nextra-output\\n'\n");
	await chmod(malformedGit, 0o755);
	assert.equal(
		await resolveProjectIdentity(nonGitDirectory, { gitExecutable: malformedGit }),
		resolve(nonGitDirectory),
		"malformed Git output must fall back to normalized cwd",
	);
	const hangingGit = join(gitIdentityDirectory, "hanging git");
	await writeFile(hangingGit, "#!/bin/sh\nwhile :; do :; done\n");
	await chmod(hangingGit, 0o755);
	const hangingStarted = Date.now();
	assert.equal(
		await resolveProjectIdentity(nonGitDirectory, { gitExecutable: hangingGit, timeoutMs: 25 }),
		resolve(nonGitDirectory),
		"timed-out Git must fall back to normalized cwd",
	);
	assert.ok(Date.now() - hangingStarted < 1_000, "Git project identity resolution must be bounded");

	const identityState = new DiscordStateStore(join(dataDir, "project-identity-state.json"));
	const canonicalChannel = await identityState.resolveProjectChannel(await resolveProjectIdentity(mainCheckout), async () => "canonical-project-channel");
	assert.equal(
		await identityState.resolveProjectChannel(await resolveProjectIdentity(linkedWorktree), async (request) => request.existingChannelId),
		canonicalChannel,
		"main and linked worktree registrations must converge on one project channel",
	);
	const firstIdentityThread = await identityState.resolveSessionThread("identity-main-session", canonicalMainCheckout, canonicalChannel, async () => "identity-thread-main");
	const linkedIdentityThread = await identityState.resolveSessionThread("identity-linked-session", canonicalMainCheckout, canonicalChannel, async () => "identity-thread-linked");
	assert.notEqual(firstIdentityThread.threadId, linkedIdentityThread.threadId, "worktree Pi sessions must retain separate threads");
	await identityState.resolveProjectChannel(linkedWorktree, async () => "legacy-worktree-channel");
	const identityProjects = (await identityState.load()).projects;
	assert.ok(identityProjects[canonicalMainCheckout]);
	assert.ok(identityProjects[resolve(linkedWorktree)], "legacy cwd mappings must remain stored without destructive migration");

	const rollingIdentityState = new DiscordStateStore(join(dataDir, "rolling-project-identity-state.json"));
	const rollingIdentityGateway = new FakeGateway();
	const rollingIdentityCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		rollingIdentityState,
		rollingIdentityGateway,
	);
	await rollingIdentityCore.start();
	const legacyMainRegistration = await rollingIdentityCore.prepareRegistration("legacy-main-client", "legacy-main-generation", {
		cwd: mainCheckout,
		sessionId: "legacy-main-session",
	});
	const legacyLinkedRegistration = await rollingIdentityCore.prepareRegistration("legacy-linked-client", "legacy-linked-generation", {
		cwd: linkedWorktree,
		sessionId: "legacy-linked-session",
	});
	assert.equal(legacyLinkedRegistration.channelId, legacyMainRegistration.channelId, "a new relay must canonicalize registrations from rolling older clients");
	assert.notEqual(legacyLinkedRegistration.threadId, legacyMainRegistration.threadId);
	assert.equal(Object.keys((await rollingIdentityState.load()).projects).length, 1);
	await rollingIdentityCore.activateRegistration("legacy-main-client", "legacy-main-generation", "legacy-main-session", () => true);
	assert.deepEqual(rollingIdentityGateway.modelAutocomplete(legacyMainRegistration.threadId, ""), []);
	assert.deepEqual(await rollingIdentityGateway.executeControl({
		requestId: "rolling-old-client-control",
		channelId: legacyMainRegistration.threadId,
		action: { type: "status" },
	}), { ok: false, message: "The live Pi client does not support session controls; reconnect or reload it." },
	"new relays must keep older clients connected while explicitly rejecting unsupported controls");
	assert.deepEqual(rollingIdentityGateway.managerAutocomplete(legacyMainRegistration.threadId, ""), []);
	assert.deepEqual(await rollingIdentityGateway.executeManagerControl({
		requestId: "rolling-non-manager-control",
		channelId: legacyMainRegistration.threadId,
		action: "handoff",
		taskId: "safe-task",
	}), { ok: false, message: "This live Pi session is not a verified the-manager client." },
	"manager controls must reject mapped live ordinary Pi sessions");
	assert.deepEqual(await rollingIdentityGateway.executeManagerControl({
		requestId: "rolling-non-manager-ask",
		channelId: legacyMainRegistration.threadId,
		action: "ask",
		target: "project:pi-extensions",
		request: "Do not route",
	}), { ok: false, message: "This live Pi session is not a verified the-manager client." });
	await rollingIdentityCore.stop();

	const controlState = new DiscordStateStore(join(dataDir, "control-state.json"));
	const controlGateway = new FakeGateway();
	const controlCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		controlState,
		controlGateway,
	);
	await controlCore.start();
	const controlPrepared = await controlCore.prepareRegistration("control-client", "control-generation", {
		cwd: "/controls",
		projectIdentityResolved: true,
		sessionId: "control-session",
	});
	let releaseControl;
	let activeControls = 0;
	let maximumActiveControls = 0;
	let executedControls = 0;
	let blockControls = true;
	await controlCore.activateRegistration("control-client", "control-generation", "control-session", () => true, {
		modelCatalogue: [{ provider: "provider", id: "model", name: "Model" }],
		async execute() {
			executedControls++;
			activeControls++;
			maximumActiveControls = Math.max(maximumActiveControls, activeControls);
			if (blockControls) await new Promise((resolveControl) => { releaseControl = resolveControl; });
			activeControls--;
			return { ok: true, message: "done" };
		},
	});
	assert.deepEqual(controlGateway.modelAutocomplete(controlPrepared.threadId, "provider"), [{ name: "Model (provider/model)", value: "provider/model" }]);
	assert.deepEqual(controlGateway.modelAutocomplete("unmapped", "provider"), []);
	const queuedControls = Array.from({ length: MAX_SESSION_CONTROL_QUEUE }, (_, index) => controlGateway.executeControl({
		requestId: `queued-control-${index}`,
		channelId: controlPrepared.threadId,
		action: { type: "status" },
	}));
	await waitFor(() => activeControls === 1, "first serialized session control");
	assert.deepEqual(await controlGateway.executeControl({
		requestId: "queue-overflow",
		channelId: controlPrepared.threadId,
		action: { type: "status" },
	}), { ok: false, message: "Pi session control queue is full; retry later." });
	blockControls = false;
	releaseControl();
	await Promise.all(queuedControls);
	assert.equal(maximumActiveControls, 1, "session controls must execute serially");
	const beforeDeduplication = executedControls;
	const duplicateControl = {
		requestId: "duplicate-mutating-control",
		channelId: controlPrepared.threadId,
		action: { type: "steer", text: "once" },
	};
	assert.deepEqual(await Promise.all([
		controlGateway.executeControl(duplicateControl),
		controlGateway.executeControl(duplicateControl),
	]), [{ ok: true, message: "done" }, { ok: true, message: "done" }]);
	assert.equal(executedControls, beforeDeduplication + 1, "mutating Discord interaction retries must execute once");
	controlCore.unregisterClient("control-client", "control-generation");
	assert.deepEqual(await controlGateway.executeControl({
		requestId: "offline-control",
		channelId: controlPrepared.threadId,
		action: { type: "status" },
	}), { ok: false, message: "The Pi session mapped to this thread is offline." });
	assert.deepEqual(await controlGateway.executeControl({
		requestId: "unmapped-control",
		channelId: "never-mapped",
		action: { type: "status" },
	}), { ok: false, message: "This Discord thread is not mapped to a Pi session." });
	await controlCore.stop();

	const managerControlState = new DiscordStateStore(join(dataDir, "manager-control-state.json"));
	const managerControlGateway = new FakeGateway();
	const managerControlCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		managerControlState,
		managerControlGateway,
	);
	await managerControlCore.start();
	const managerControlPrepared = await managerControlCore.prepareRegistration("manager-client", "manager-generation", {
		cwd: "/the-manager",
		projectIdentityResolved: true,
		sessionId: "manager-session",
	});
	const deliveredManagerMessages = [];
	const executedManagerControls = [];
	const liveManagerCatalogue = [{ taskId: "safe-task", project: "pi-extensions", title: "Safe task", status: "active" }];
	const liveManagerProjects = [{ projectId: "pi-extensions" }, { projectId: "safe-task" }];
	await managerControlCore.activateRegistration(
		"manager-client",
		"manager-generation",
		"manager-session",
		(message) => { deliveredManagerMessages.push(message); return true; },
		undefined,
		true,
		{
			taskCatalogue: liveManagerCatalogue,
			projectCatalogue: liveManagerProjects,
			async execute(request) {
				executedManagerControls.push(request);
				return { ok: true, message: `${request.action} ${request.action === "ask" ? request.target : request.taskId}` };
			},
		},
	);
	assert.deepEqual(managerControlGateway.managerAutocomplete(managerControlPrepared.threadId, "safe"), [{
		name: "Safe task — pi-extensions (@safe-task)",
		value: "safe-task",
	}], "autocomplete must be scoped to the mapped live manager thread");
	assert.deepEqual(managerControlGateway.managerAutocomplete("not-manager-thread", "safe"), []);
	assert.deepEqual(managerControlGateway.managerAutocomplete(managerControlPrepared.threadId, "safe", "target"), [{
		name: "Project — Safe Task (safe-task)",
		value: "project:safe-task",
	}, {
		name: "Task — Safe task — pi-extensions (@safe-task)",
		value: "task:safe-task",
	}], "ask autocomplete must combine typed configured-project and active-task targets");
	assert.deepEqual(await managerControlGateway.executeManagerControl({
		requestId: "stale-manager-task",
		channelId: managerControlPrepared.threadId,
		action: "archive",
		taskId: "missing-task",
	}), { ok: false, message: "Select a task from this manager session's current autocomplete catalogue." });
	const duplicateManagerRequest = {
		requestId: "duplicate-manager-control",
		channelId: managerControlPrepared.threadId,
		action: "handoff",
		taskId: "safe-task",
	};
	assert.deepEqual(await Promise.all([
		managerControlGateway.executeManagerControl(duplicateManagerRequest),
		managerControlGateway.executeManagerControl(duplicateManagerRequest),
	]), [{ ok: true, message: "handoff safe-task" }, { ok: true, message: "handoff safe-task" }]);
	assert.equal(executedManagerControls.length, 1, "Discord retries must execute each manager mutation once");
	const interactionChannels = new DiscordInteractionChannelResolver();
	interactionChannels.observe({
		t: "INTERACTION_CREATE",
		d: { id: "manager-ask-autocomplete", channel_id: managerControlPrepared.threadId },
	});
	const autocompleteChannelId = interactionChannels.resolve({
		id: "manager-ask-autocomplete",
		channelId: managerControlPrepared.threadId,
	});
	assert.equal(autocompleteChannelId, managerControlPrepared.threadId,
		"autocomplete must retain its mapped interaction thread");
	assert.ok(managerControlGateway.managerAutocomplete(autocompleteChannelId, "pi-extensions", "target").some((choice) =>
		choice.value === "project:pi-extensions"), "ask autocomplete must resolve through the raw mapped thread");
	interactionChannels.observe({
		t: "INTERACTION_CREATE",
		d: { id: "manager-ask-execution", channel_id: managerControlPrepared.threadId },
	});
	const executionChannelId = interactionChannels.resolve({
		id: "manager-ask-execution",
		channelId: managerControlPrepared.channelId,
	});
	assert.deepEqual(await managerControlGateway.executeManagerControl({
		requestId: "manager-ask-execution",
		channelId: executionChannelId,
		action: "ask",
		target: "project:pi-extensions",
		request: "Inspect the mapped project",
	}), { ok: true, message: "ask project:pi-extensions" },
	"ask execution must retain the same authoritative raw thread as autocomplete");
	assert.deepEqual(executedManagerControls.at(-1), {
		requestId: "manager-ask-execution",
		action: "ask",
		target: "project:pi-extensions",
		request: "Inspect the mapped project",
	});
	interactionChannels.observe({
		t: "INTERACTION_CREATE",
		d: { id: "manager-ask-parent", channel_id: managerControlPrepared.channelId },
	});
	assert.deepEqual(await managerControlGateway.executeManagerControl({
		requestId: "manager-ask-parent",
		channelId: interactionChannels.resolve({ id: "manager-ask-parent", channelId: managerControlPrepared.threadId }),
		action: "ask",
		target: "project:pi-extensions",
		request: "Do not route",
	}), { ok: false, message: "This Discord thread is not mapped to a Pi session." },
	"raw project-channel interactions must not borrow a normalized mapped thread");
	assert.deepEqual(await managerControlGateway.executeManagerControl({
		requestId: "relay-reconcile-pr",
		channelId: managerControlPrepared.threadId,
		action: "reconcile-pr",
		taskId: "safe-task",
	}), { ok: true, message: "reconcile-pr safe-task" }, "relay must route reconcile-pr through current task authorization");
	assert.deepEqual(executedManagerControls.at(-1), {
		requestId: "relay-reconcile-pr", action: "reconcile-pr", taskId: "safe-task",
	});
	assert.deepEqual(await managerControlGateway.executeManagerControl({
		requestId: "relay-reconcile-pr-all",
		channelId: managerControlPrepared.threadId,
		action: "reconcile-pr",
	}), { ok: true, message: "reconcile-pr undefined" }, "relay must authorize taskless reconciliation only for the verified live manager session");
	assert.deepEqual(executedManagerControls.at(-1), {
		requestId: "relay-reconcile-pr-all", action: "reconcile-pr",
	}, "relay must preserve omitted taskId across authorization and IPC routing");
	assert.deepEqual(await managerControlGateway.executeManagerControl({
		requestId: "relay-ask-task",
		channelId: managerControlPrepared.threadId,
		action: "ask",
		target: "task:safe-task",
		request: "Review it",
	}), { ok: true, message: "ask task:safe-task" }, "relay must route a current typed ask target");
	assert.deepEqual(await managerControlGateway.executeManagerControl({
		requestId: "relay-ask-stale",
		channelId: managerControlPrepared.threadId,
		action: "ask",
		target: "project:missing",
		request: "Do not route",
	}), { ok: false, message: "Select a target from this manager session's current autocomplete catalogue." });
	assert.deepEqual(await managerControlGateway.executeManagerControl({
		requestId: "relay-ask-invalid",
		channelId: managerControlPrepared.threadId,
		action: "ask",
		target: "project:../hostile",
		request: "Do not route",
	}), { ok: false, message: "Invalid manager control request." });
	managerControlCore.updateManagerCatalogues("manager-client", "manager-generation", "manager-session", [{
		taskId: "new-task", project: "wordpress", title: "New task", status: "ready",
	}], [{ projectId: "wordpress" }]);
	assert.deepEqual(managerControlGateway.managerAutocomplete(managerControlPrepared.threadId, ""), [{
		name: "New task — wordpress (@new-task)",
		value: "new-task",
	}], "live manager task-state refreshes must replace the cached catalogue");
	assert.deepEqual(managerControlGateway.managerAutocomplete(managerControlPrepared.threadId, "", "target"), [{
		name: "Project — Wordpress (wordpress)", value: "project:wordpress",
	}, {
		name: "Task — New task — wordpress (@new-task)", value: "task:new-task",
	}], "live manager project/task refreshes must atomically replace ask targets");
	assert.deepEqual(await managerControlGateway.executeManagerControl({ ...duplicateManagerRequest, requestId: "removed-task", taskId: "safe-task" }), {
		ok: false,
		message: "Select a task from this manager session's current autocomplete catalogue.",
	});
	assert.deepEqual(await managerControlGateway.executeManagerControl({
		requestId: "stale-reconcile-task", channelId: managerControlPrepared.threadId, action: "reconcile-pr", taskId: "safe-task",
	}), { ok: false, message: "Select a task from this manager session's current autocomplete catalogue." },
	"supplied reconcile-pr tasks must retain stale-catalogue rejection");
	await managerControlGateway.emit({
		id: "manager-ordinary-message",
		channelId: managerControlPrepared.threadId,
		content: "ordinary manager thread message",
		authorBot: false,
	});
	assert.equal(deliveredManagerMessages.at(-1).content, "ordinary manager thread message", "manager controls must not alter ordinary messages");
	managerControlCore.unregisterClient("manager-client", "manager-generation");
	assert.deepEqual(await managerControlGateway.executeManagerControl({
		requestId: "offline-manager-control",
		channelId: managerControlPrepared.threadId,
		action: "reconcile-pr",
	}), { ok: false, message: "The manager session mapped to this thread is offline." });
	assert.deepEqual(await managerControlGateway.executeManagerControl({
		requestId: "unmapped-manager-control",
		channelId: "never-mapped-manager",
		action: "reconcile-pr",
	}), { ok: false, message: "This Discord thread is not mapped to a Pi session." });
	await managerControlCore.stop();

	async function verifySummaryTransportOwnerFence(kind, retryFirst = false) {
		const channelId = `summary-fence-${kind}`;
		FakeGateway.channelMessages.delete(channelId);
		const fenceState = new DiscordStateStore(join(dataDir, `summary-fence-${kind}.json`));
		const fenceGateway = new FakeGateway();
		fenceGateway.ensureProjectChannel = async () => channelId;
		const fenceCore = new DiscordRelayCore(
			{ token: "token", guildId: "12345", epoch: 1 },
			fenceState,
			fenceGateway,
		);
		await fenceCore.start();
		for (const producer of ["old", "new"]) {
			await fenceCore.prepareRegistration(`${producer}-${kind}-client`, `${producer}-${kind}-generation`, {
				cwd: "/the-manager",
				projectIdentityResolved: true,
				sessionId: `${producer}-${kind}-session`,
			});
			await fenceCore.activateRegistration(
				`${producer}-${kind}-client`,
				`${producer}-${kind}-generation`,
				`${producer}-${kind}-session`,
				() => true,
				undefined,
				false,
				undefined,
				true,
			);
		}
		await fenceCore.queueProjectSummary(`old-${kind}-client`, `old-${kind}-generation`, `old-${kind}-session`, `seed ${kind}`);
		await waitFor(() => FakeGateway.channelMessages.get(channelId)?.at(-1)?.text === `seed ${kind}`, `${kind} fence seed`);
		const seedId = FakeGateway.channelMessages.get(channelId).at(-1).id;
		if (kind === "send") {
			await fenceGateway.deleteOwnText(channelId, seedId);
			await fenceState.recordProjectSummaryDeleted("/the-manager", seedId);
		} else if (kind === "delete") {
			FakeGateway.channelMessages.get(channelId).push({ id: `human-${kind}`, text: "displacing message", botOwned: false });
		}

		const method = kind === "send" ? "sendText" : kind === "edit" ? "editOwnText" : "deleteOwnText";
		const original = fenceGateway[method].bind(fenceGateway);
		const order = [];
		let oldAttempts = 0;
		let releaseOldOperation;
		let oldOperationStarted;
		const oldOperation = new Promise((resolveStarted) => { oldOperationStarted = resolveStarted; });
		fenceGateway[method] = async (...args) => {
			const oldMutation = kind === "send" ? args[1] === `old ${kind}` : kind === "edit" ? args[2] === `old ${kind}` : true;
			if (!oldMutation) return original(...args);
			oldAttempts++;
			if (retryFirst && oldAttempts === 1) throw new Error(`injected ${kind} retry failure`);
			const blockedAttempt = retryFirst ? 2 : 1;
			if (oldAttempts !== blockedAttempt) {
				const result = await original(...args);
				order.push("old-recovery-settled");
				return result;
			}
			oldOperationStarted();
			await new Promise((resolveOperation) => { releaseOldOperation = resolveOperation; });
			const result = await original(...args);
			order.push("old-operation-settled");
			return result;
		};
		if (kind === "send") {
			const recordSent = fenceState.recordProjectSummarySent.bind(fenceState);
			let failAcceptedSendRecord = true;
			fenceState.recordProjectSummarySent = async (...args) => {
				if (failAcceptedSendRecord) {
					failAcceptedSendRecord = false;
					throw new Error("injected accepted-send persistence failure");
				}
				return recordSent(...args);
			};
		}

		const retryKeepAlive = retryFirst ? setTimeout(() => {}, 1_000) : undefined;
		await fenceCore.queueProjectSummary(
			`old-${kind}-client`,
			`old-${kind}-generation`,
			`old-${kind}-session`,
			`old ${kind}`,
		);
		await oldOperation;
		if (retryKeepAlive) clearTimeout(retryKeepAlive);
		fenceCore.unregisterClient(`old-${kind}-client`, `old-${kind}-generation`);
		let newPublicationSettled = false;
		const newPublication = fenceCore.queueProjectSummary(
			`new-${kind}-client`,
			`new-${kind}-generation`,
			`new-${kind}-session`,
			`new ${kind}`,
		).then(() => {
			newPublicationSettled = true;
			order.push("new-publication-settled");
		});
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
		assert.equal(newPublicationSettled, false, `${kind} owner promotion must wait for the old transport operation`);
		assert.equal((await fenceState.projectSummaries())[0].summary.desiredText, `old ${kind}`,
			`${kind} owner state must not advance while the old generation can still side-effect Discord`);
		releaseOldOperation();
		await newPublication;
		assert.ok(order.indexOf("old-operation-settled") < order.indexOf("new-publication-settled"),
			`${kind} old-generation mutation must settle before new-owner publication`);
		await waitFor(() => FakeGateway.channelMessages.get(channelId)?.at(-1)?.text === `new ${kind}`,
			`${kind} new-owner reconciliation`);
		if (kind === "send") {
			assert.ok(order.indexOf("old-recovery-settled") < order.indexOf("new-publication-settled"),
				"accepted-send nonce recovery must settle before owner promotion");
			assert.equal(FakeGateway.sendAttempts.get("old send"), 2,
				"retiring owner must retry an accepted-but-unrecorded send with its durable nonce");
			assert.equal(FakeGateway.channelMessages.get(channelId).filter((message) => message.botOwned).length, 1,
				"nonce recovery and promoted-owner reconciliation must retain exactly one bot summary");
		}
		await fenceCore.stop();
	}

	await verifySummaryTransportOwnerFence("send");
	await verifySummaryTransportOwnerFence("edit", true);
	await verifySummaryTransportOwnerFence("delete");

	FakeGateway.channelMessages.delete("summary-channel");
	FakeGateway.summaryEvents.length = 0;
	const summaryStateFile = join(dataDir, "project-summary-state.json");
	const summaryState = new DiscordStateStore(summaryStateFile);
	const summaryGateway = new FakeGateway();
	summaryGateway.ensureProjectChannel = async (request) => {
		summaryGateway.projectRequests.push(request);
		return "summary-channel";
	};
	const summaryCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		summaryState,
		summaryGateway,
	);
	await summaryCore.start();
	await summaryCore.prepareRegistration("summary-client", "summary-generation", {
		cwd: "/the-manager",
		projectIdentityResolved: true,
		sessionId: "summary-session",
	});
	await summaryCore.activateRegistration(
		"summary-client",
		"summary-generation",
		"summary-session",
		() => true,
		undefined,
		false,
		undefined,
		true,
	);
	await summaryState.setProjectSummaryDesired("summary-session", "summary one");
	const initialPendingSummary = await summaryState.prepareProjectSummarySend("/the-manager");
	const overlongSummaryState = JSON.parse(await readFile(summaryStateFile, "utf8"));
	overlongSummaryState.projects["/the-manager"].summary.pendingSend.nonce = "x".repeat(36);
	await writeFile(summaryStateFile, `${JSON.stringify(overlongSummaryState)}\n`);
	const repairedPendingSummary = await summaryState.prepareProjectSummarySend("/the-manager");
	assert.ok(repairedPendingSummary.nonce.length <= MAX_DISCORD_NONCE_LENGTH, "persisted summary nonce must fit Discord's limit");
	assert.notEqual(repairedPendingSummary.nonce, initialPendingSummary.nonce, "an overlong legacy nonce must be replaced before retry");
	assert.equal((await summaryState.prepareProjectSummarySend("/the-manager")).nonce, repairedPendingSummary.nonce,
		"a repaired nonce must remain durable for idempotent retries");
	await summaryCore.queueProjectSummary("summary-client", "summary-generation", "summary-session", "summary one");
	await waitFor(() => FakeGateway.channelMessages.get("summary-channel")?.at(-1)?.text === "summary one", "initial parent-channel summary");
	assert.equal(summaryGateway.sent.at(-1).nonce, repairedPendingSummary.nonce,
		"a fresh same-text frame must retain the durable nonce for uncertain-send crash recovery");
	const initialSummaryId = FakeGateway.channelMessages.get("summary-channel").at(-1).id;
	assert.equal(summaryGateway.sent.at(-1).channelId, "summary-channel", "summary must target the mapped project parent channel");
	assert.ok(summaryGateway.sent.every((message) => message.nonce.length <= MAX_DISCORD_NONCE_LENGTH),
		"the fake gateway must enforce Discord's nonce-length contract");

	await summaryCore.queueProjectSummary("summary-client", "summary-generation", "summary-session", "summary two");
	await waitFor(() => FakeGateway.channelMessages.get("summary-channel")?.at(-1)?.text === "summary two", "latest summary edit");
	assert.equal(FakeGateway.channelMessages.get("summary-channel").length, 1);
	assert.equal(FakeGateway.channelMessages.get("summary-channel")[0].id, initialSummaryId, "latest summary must edit in place");

	await summaryCore.prepareRegistration("competing-summary-client", "competing-summary-generation", {
		cwd: "/the-manager",
		projectIdentityResolved: true,
		sessionId: "competing-summary-session",
	});
	await summaryCore.activateRegistration(
		"competing-summary-client",
		"competing-summary-generation",
		"competing-summary-session",
		() => true,
		undefined,
		false,
		undefined,
		true,
	);
	await summaryCore.queueProjectSummary(
		"competing-summary-client",
		"competing-summary-generation",
		"competing-summary-session",
		"delayed stale summary",
	);
	const ownedSummaryState = (await summaryState.projectSummaries())[0].summary;
	assert.equal(ownedSummaryState.desiredText, "summary two",
		"a delayed snapshot from a competing eligible producer must not replace the elected producer's newer state");
	assert.equal(FakeGateway.channelMessages.get("summary-channel").at(-1).text, "summary two");
	const rejectedStaleRevision = await summaryState.setProjectSummaryDesired(
		"competing-summary-session",
		"stale persisted revision",
		ownedSummaryState.revision,
	);
	assert.equal(rejectedStaleRevision.accepted, false, "persisted monotonic revisions must reject stale state writes");
	assert.equal((await summaryState.projectSummaries())[0].summary.desiredText, "summary two");

	const originalSummaryLatestMessageId = summaryGateway.latestMessageId.bind(summaryGateway);
	let releaseStaleOwnerRead;
	let staleOwnerReadStarted;
	const staleOwnerRead = new Promise((resolveStarted) => { staleOwnerReadStarted = resolveStarted; });
	summaryGateway.latestMessageId = async (...args) => {
		staleOwnerReadStarted();
		await new Promise((resolveRead) => { releaseStaleOwnerRead = resolveRead; });
		return originalSummaryLatestMessageId(...args);
	};
	await summaryCore.queueProjectSummary("summary-client", "summary-generation", "summary-session", "in-flight stale owner");
	await staleOwnerRead;
	summaryCore.unregisterClient("summary-client", "summary-generation");
	const promotedOwnerPublication = summaryCore.queueProjectSummary(
		"competing-summary-client",
		"competing-summary-generation",
		"competing-summary-session",
		"promoted owner snapshot",
	);
	await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	assert.equal((await summaryState.projectSummaries())[0].summary.desiredText, "in-flight stale owner",
		"new ownership must not publish while an old-owner reconciliation operation remains in flight");
	summaryGateway.latestMessageId = originalSummaryLatestMessageId;
	releaseStaleOwnerRead();
	await promotedOwnerPublication;
	await waitFor(() => FakeGateway.channelMessages.get("summary-channel")?.at(-1)?.text === "promoted owner snapshot",
		"promoted owner revision after an in-flight stale reconciliation");
	const staleOwnerEvent = FakeGateway.summaryEvents.findIndex((event) => event.text === "in-flight stale owner");
	const promotedOwnerEvent = FakeGateway.summaryEvents.findIndex((event) => event.text === "promoted owner snapshot");
	assert.ok(staleOwnerEvent >= 0 && staleOwnerEvent < promotedOwnerEvent,
		"the retiring owner's in-flight operation must settle before promoted-owner reconciliation");

	const promotedSummaryId = FakeGateway.channelMessages.get("summary-channel").at(-1).id;
	FakeGateway.failEditOnce.add(promotedSummaryId);
	await summaryCore.queueProjectSummary(
		"competing-summary-client",
		"competing-summary-generation",
		"competing-summary-session",
		"failed stale retry",
	);
	await waitFor(() => !FakeGateway.failEditOnce.has(promotedSummaryId), "old-owner summary edit failure");
	await summaryCore.prepareRegistration("final-summary-client", "final-summary-generation", {
		cwd: "/the-manager",
		projectIdentityResolved: true,
		sessionId: "final-summary-session",
	});
	await summaryCore.activateRegistration(
		"final-summary-client",
		"final-summary-generation",
		"final-summary-session",
		() => true,
		undefined,
		false,
		undefined,
		true,
	);
	summaryCore.unregisterClient("competing-summary-client", "competing-summary-generation");
	await summaryCore.queueProjectSummary(
		"final-summary-client",
		"final-summary-generation",
		"final-summary-session",
		"new owner after failed retry",
	);
	await waitFor(() => FakeGateway.channelMessages.get("summary-channel")?.at(-1)?.text === "new owner after failed retry",
		"new owner summary after stale retry fencing");
	const retiredRetryEvent = FakeGateway.summaryEvents.findIndex((event) => event.text === "failed stale retry");
	const postRetryPromotionEvent = FakeGateway.summaryEvents.findIndex((event) => event.text === "new owner after failed retry");
	assert.ok(retiredRetryEvent >= 0 && retiredRetryEvent < postRetryPromotionEvent,
		"failed old-owner work must finish retry recovery before new-owner publication");

	FakeGateway.channelMessages.get("summary-channel").push({ id: "external-displacement", text: "human message", botOwned: false });
	await summaryCore.queueProjectSummary("final-summary-client", "final-summary-generation", "final-summary-session", "summary three");
	await waitFor(() => FakeGateway.channelMessages.get("summary-channel")?.at(-1)?.text === "summary three", "displaced summary replacement");
	const displacedEvents = FakeGateway.summaryEvents.filter((event) => event.text === "summary three" || event.messageId === initialSummaryId);
	assert.deepEqual(displacedEvents.slice(-2).map((event) => event.type), ["delete", "send"], "displaced summary must delete before send");
	assert.equal(FakeGateway.channelMessages.get("summary-channel").filter((message) => message.botOwned).length, 1);

	const replacementId = FakeGateway.channelMessages.get("summary-channel").at(-1).id;
	FakeGateway.channelMessages.get("summary-channel").push({ id: "failure-displacement", text: "another human message", botOwned: false });
	FakeGateway.failDeleteOnce.add(replacementId);
	const sendsBeforeFailure = summaryGateway.sent.length;
	await summaryCore.queueProjectSummary("final-summary-client", "final-summary-generation", "final-summary-session", "summary four");
	await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	assert.equal(summaryGateway.sent.length, sendsBeforeFailure, "delete failure must not send a duplicate replacement");
	await waitFor(() => FakeGateway.channelMessages.get("summary-channel")?.at(-1)?.text === "summary four", "bounded delete retry recovery");
	await waitFor(async () => (await summaryState.projectSummaries())[0]?.summary.delivery?.content === "summary four", "persisted delete retry recovery");
	assert.equal(FakeGateway.channelMessages.get("summary-channel").filter((message) => message.botOwned).length, 1);

	const beforeSendFailureId = FakeGateway.channelMessages.get("summary-channel").at(-1).id;
	FakeGateway.channelMessages.get("summary-channel").push({ id: "send-failure-displacement", text: "human again", botOwned: false });
	FakeGateway.failOnceTexts.add("summary five");
	await summaryCore.queueProjectSummary("final-summary-client", "final-summary-generation", "final-summary-session", "summary five");
	await waitFor(() => (FakeGateway.sendAttempts.get("summary five") ?? 0) >= 1, "first failed replacement send");
	assert.ok(!FakeGateway.channelMessages.get("summary-channel").some((message) => message.id === beforeSendFailureId), "old summary must be deleted before replacement attempt");
	assert.equal(FakeGateway.channelMessages.get("summary-channel").filter((message) => message.botOwned).length, 0, "failed replacement send must not retain the deleted summary");
	await waitFor(() => FakeGateway.channelMessages.get("summary-channel")?.at(-1)?.text === "summary five", "bounded send retry recovery");
	await waitFor(async () => (await summaryState.projectSummaries())[0]?.summary.delivery?.content === "summary five", "persisted send retry recovery");
	assert.equal(FakeGateway.channelMessages.get("summary-channel").filter((message) => message.botOwned).length, 1);

	const uncertainSummaryId = FakeGateway.channelMessages.get("summary-channel").at(-1).id;
	FakeGateway.channelMessages.get("summary-channel").push({ id: "uncertain-send-displacement", text: "human after failure", botOwned: false });
	const recordSummarySent = summaryState.recordProjectSummarySent.bind(summaryState);
	let failSummaryPersistence = true;
	summaryState.recordProjectSummarySent = async (...args) => {
		if (failSummaryPersistence) {
			failSummaryPersistence = false;
			throw new Error("injected crash after Discord accepted summary");
		}
		return recordSummarySent(...args);
	};
	await summaryCore.queueProjectSummary("final-summary-client", "final-summary-generation", "final-summary-session", "summary six");
	await waitFor(async () => (await summaryState.projectSummaries())[0]?.summary.delivery?.content === "summary six", "uncertain accepted-send recovery");
	assert.ok(!FakeGateway.channelMessages.get("summary-channel").some((message) => message.id === uncertainSummaryId));
	assert.equal(FakeGateway.sendAttempts.get("summary six"), 2, "uncertain send must retry its durable nonce");
	assert.equal(FakeGateway.channelMessages.get("summary-channel").filter((message) => message.botOwned && message.text === "summary six").length, 1,
		"nonce retry must not duplicate an accepted summary");

	await summaryCore.stop();
	const beforeRestartSummaryId = FakeGateway.channelMessages.get("summary-channel").find((message) => message.botOwned).id;
	FakeGateway.channelMessages.get("summary-channel").push({ id: "restart-displacement", text: "human while relay stopped", botOwned: false });
	const restartSummaryGateway = new FakeGateway();
	restartSummaryGateway.ensureProjectChannel = async () => "summary-channel";
	const restartSummaryCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		new DiscordStateStore(summaryStateFile),
		restartSummaryGateway,
	);
	let restartSummaryOperations = 0;
	const restartSummaryEventOffset = FakeGateway.summaryEvents.length;
	for (const method of ["latestMessageId", "sendText", "editOwnText", "deleteOwnText"]) {
		const original = restartSummaryGateway[method].bind(restartSummaryGateway);
		restartSummaryGateway[method] = async (...args) => {
			restartSummaryOperations++;
			return original(...args);
		};
	}
	await restartSummaryCore.start();
	await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	assert.equal(restartSummaryOperations, 0, "relay startup alone must not reconcile a persisted manager summary");
	await restartSummaryCore.prepareRegistration("unrelated-client", "unrelated-generation", {
		cwd: "/unrelated-project",
		projectIdentityResolved: true,
		sessionId: "unrelated-session",
	});
	await restartSummaryCore.activateRegistration("unrelated-client", "unrelated-generation", "unrelated-session", () => true);
	await assert.rejects(
		() => restartSummaryCore.queueProjectSummary("unrelated-client", "unrelated-generation", "unrelated-session", "hostile summary"),
		/not registered as a manager task-summary producer/,
		"an unrelated session must not publish project-summary state",
	);
	await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	assert.equal(restartSummaryOperations, 0, "an unrelated active project must not reconcile a persisted manager summary");
	await restartSummaryCore.prepareRegistration("restart-summary-client", "restart-summary-generation", {
		cwd: "/the-manager",
		projectIdentityResolved: true,
		sessionId: "restart-summary-session",
	});
	await restartSummaryCore.activateRegistration(
		"restart-summary-client",
		"restart-summary-generation",
		"restart-summary-session",
		() => true,
		undefined,
		false,
		undefined,
		true,
	);
	await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	assert.equal(restartSummaryOperations, 0,
		"matching registration must wait for a fresh canonical producer frame before persisted recovery");
	await restartSummaryCore.queueProjectSummary(
		"restart-summary-client",
		"restart-summary-generation",
		"restart-summary-session",
		"summary seven from disconnected canonical change",
	);
	await waitFor(async () => {
		const project = (await new DiscordStateStore(summaryStateFile).projectSummaries())[0];
		return project?.summary.delivery?.content === "summary seven from disconnected canonical change" &&
			project.summary.delivery.messageId !== beforeRestartSummaryId;
	}, "fresh manager publication restart reconciliation");
	assert.ok(restartSummaryOperations > 0, "a fresh matching producer frame must activate persisted summary recovery");
	assert.equal(FakeGateway.summaryEvents.slice(restartSummaryEventOffset).some((event) => event.text === "summary six"), false,
		"restart recovery must not publish persisted stale text before the fresh canonical snapshot");
	assert.equal(FakeGateway.channelMessages.get("summary-channel").filter((message) => message.botOwned).length, 1);
	assert.equal(FakeGateway.channelMessages.get("summary-channel").at(-1).text, "summary seven from disconnected canonical change");
	await restartSummaryCore.stop();

	const managerPresentationPayload = (revision, content, controls = [{ id: "github-refresh-reconcile",
		label: "Refresh & Reconcile", style: "secondary", command: "github-refresh-reconcile" }]) =>
		({ schemaVersion: 1, revision, content, controls, degraded: false, warnings: [] });
	const teardownSummaryChannel = "teardown-summary-channel";
	FakeGateway.channelMessages.delete(teardownSummaryChannel);
	const teardownSummaryStateFile = join(dataDir, "teardown-summary-state.json");
	const teardownSummaryState = new DiscordStateStore(teardownSummaryStateFile);
	const teardownSummaryGateway = new FakeGateway();
	teardownSummaryGateway.ensureProjectChannel = async () => teardownSummaryChannel;
	const teardownSummaryCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		teardownSummaryState,
		teardownSummaryGateway,
	);
	await teardownSummaryCore.start();
	await teardownSummaryCore.prepareRegistration("teardown-summary-client", "teardown-summary-generation", {
		cwd: "/teardown-manager",
		projectIdentityResolved: true,
		sessionId: "teardown-summary-session",
	});
	await teardownSummaryCore.activateRegistration(
		"teardown-summary-client",
		"teardown-summary-generation",
		"teardown-summary-session",
		() => true,
		undefined,
		false,
		undefined,
		true,
		{ controlIds: ["github-refresh-reconcile"], execute: async () => ({ ok: true, message: "unused" }) },
	);
	const recordTeardownSummarySent = teardownSummaryState.recordProjectSummarySent.bind(teardownSummaryState);
	let releaseTeardownRecord;
	let teardownRecordStarted;
	const teardownRecordAttempt = new Promise((resolveStarted) => { teardownRecordStarted = resolveStarted; });
	let failTeardownRecord = true;
	teardownSummaryState.recordProjectSummarySent = async (...args) => {
		if (!failTeardownRecord) return recordTeardownSummarySent(...args);
		failTeardownRecord = false;
		teardownRecordStarted();
		await new Promise((resolveRecord) => { releaseTeardownRecord = resolveRecord; });
		throw new Error("injected teardown after accepted summary send");
	};
	const acceptedTeardownPresentation = managerPresentationPayload("6".repeat(64), "summary accepted before teardown");
	await teardownSummaryCore.queueManagerPresentation(
		"teardown-summary-client", "teardown-summary-generation", "teardown-summary-session", acceptedTeardownPresentation,
	);
	await teardownRecordAttempt;
	const acceptedTeardownMessage = FakeGateway.channelMessages.get(teardownSummaryChannel).at(-1);
	const pendingTeardownSummary = (await teardownSummaryState.projectSummaries())[0].summary.pendingSend;
	assert.deepEqual(pendingTeardownSummary?.presentation, acceptedTeardownPresentation,
		"accepted presentation send must retain its full components and durable pending nonce until recorded");
	const compactTeardownSummaryState = teardownSummaryState.compact.bind(teardownSummaryState);
	let teardownStopCompacted;
	const teardownStopCompaction = new Promise((resolveCompacted) => { teardownStopCompacted = resolveCompacted; });
	teardownSummaryState.compact = async (...args) => {
		const result = await compactTeardownSummaryState(...args);
		teardownStopCompacted();
		return result;
	};
	const teardownStop = teardownSummaryCore.stop();
	await teardownStopCompaction;
	await new Promise((resolveTurn) => setImmediate(resolveTurn));
	releaseTeardownRecord();
	await teardownStop;
	assert.equal(FakeGateway.sendAttempts.get("summary accepted before teardown"), 1,
		"teardown must prevent the stopped relay from retrying uncertain summary transport");
	assert.equal((await new DiscordStateStore(teardownSummaryStateFile).projectSummaries())[0].summary.pendingSend.nonce,
		pendingTeardownSummary.nonce, "teardown must preserve the uncertain send nonce for restart recovery");

	const teardownRestartGateway = new FakeGateway();
	teardownRestartGateway.ensureProjectChannel = async () => teardownSummaryChannel;
	const teardownRestartCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		new DiscordStateStore(teardownSummaryStateFile),
		teardownRestartGateway,
	);
	let teardownRestartSummaryOperations = 0;
	for (const method of ["latestMessageId", "sendText", "sendPresentation", "editOwnText", "editOwnPresentation", "deleteOwnText"]) {
		const original = teardownRestartGateway[method].bind(teardownRestartGateway);
		teardownRestartGateway[method] = async (...args) => {
			teardownRestartSummaryOperations++;
			return original(...args);
		};
	}
	await teardownRestartCore.start();
	await teardownRestartCore.prepareRegistration("teardown-unrelated-client", "teardown-unrelated-generation", {
		cwd: "/teardown-unrelated",
		projectIdentityResolved: true,
		sessionId: "teardown-unrelated-session",
	});
	await teardownRestartCore.activateRegistration(
		"teardown-unrelated-client",
		"teardown-unrelated-generation",
		"teardown-unrelated-session",
		() => true,
	);
	await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	assert.equal(teardownRestartSummaryOperations, 0,
		"an unrelated restarted session must not reconcile another project's pending summary nonce");
	await teardownRestartCore.prepareRegistration("teardown-recovery-client", "teardown-recovery-generation", {
		cwd: "/teardown-manager",
		projectIdentityResolved: true,
		sessionId: "teardown-recovery-session",
	});
	await teardownRestartCore.activateRegistration(
		"teardown-recovery-client",
		"teardown-recovery-generation",
		"teardown-recovery-session",
		() => true,
		undefined,
		false,
		undefined,
		true,
		{ controlIds: ["github-refresh-reconcile"], execute: async () => ({ ok: true, message: "unused" }) },
	);
	const changedTeardownPresentation = managerPresentationPayload("7".repeat(64), "changed summary after restart");
	await teardownRestartCore.queueManagerPresentation(
		"teardown-recovery-client", "teardown-recovery-generation", "teardown-recovery-session", changedTeardownPresentation,
	);
	await waitFor(async () => {
		const summary = (await new DiscordStateStore(teardownSummaryStateFile).projectSummaries())[0]?.summary;
		return summary?.delivery?.content === "changed summary after restart" && !summary.pendingSend;
	}, "accepted teardown summary nonce recovery before changed restart summary");
	assert.equal(FakeGateway.sendAttempts.get("summary accepted before teardown"), 2,
		"restart must recover the accepted send with its durable nonce");
	assert.equal(FakeGateway.sendAttempts.get("changed summary after restart"), undefined,
		"changed desired text must edit the recovered send instead of creating a second summary");
	assert.equal(FakeGateway.channelMessages.get(teardownSummaryChannel).filter((message) => message.botOwned).length, 1,
		"teardown recovery and changed desired text must retain one bot summary");
	assert.deepEqual(FakeGateway.channelMessages.get(teardownSummaryChannel).find((message) => message.botOwned), {
		...acceptedTeardownMessage,
		text: "changed summary after restart",
		presentation: changedTeardownPresentation,
	}, "restart recovery must update the originally accepted Discord message and components");
	await teardownRestartCore.stop();

	const presentationStateFile = join(dataDir, "presentation-state.json");
	const presentationState = new DiscordStateStore(presentationStateFile);
	const presentationGateway = new FakeGateway();
	const presentationCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		presentationState,
		presentationGateway,
	);
	await presentationCore.start();
	await presentationCore.prepareRegistration("presentation-client", "presentation-generation", {
		cwd: "/presentation-manager", projectIdentityResolved: true, sessionId: "presentation-session",
	});
	let presentationExecutions = 0;
	let releasePresentationControl;
	const executePresentationControl = async () => {
		presentationExecutions++;
		return new Promise((resolveResult) => { releasePresentationControl = resolveResult; });
	};
	await presentationCore.activateRegistration(
		"presentation-client", "presentation-generation", "presentation-session", () => true,
		undefined, false, undefined, true,
		{ controlIds: ["github-refresh-reconcile"], execute: executePresentationControl },
	);
	const firstPresentation = managerPresentationPayload("1".repeat(64), "opaque presentation one");
	await presentationCore.queueManagerPresentation(
		"presentation-client", "presentation-generation", "presentation-session", firstPresentation);
	const presentationMapping = await presentationState.getSession("presentation-session");
	await waitFor(() => FakeGateway.channelMessages.get(presentationMapping.channelId)?.at(-1)?.presentation?.revision === firstPresentation.revision,
		"manager presentation delivery with components");
	const deliveredPresentation = FakeGateway.channelMessages.get(presentationMapping.channelId).at(-1);
	assert.equal(FakeGateway.channelMessages.get(presentationMapping.channelId).length, 1, "one manager presentation message");
	assert.deepEqual(deliveredPresentation.presentation.controls, firstPresentation.controls,
		"manager labels and generic controls must remain unchanged");
	const controlRequest = { requestId: "presentation-reconcile-interaction", guildId: "12345", channelId: presentationMapping.channelId,
		messageId: deliveredPresentation.id, customId: `m:${firstPresentation.revision}:github-refresh-reconcile` };
	const lookupPresentation = presentationState.projectSummaryByChannel.bind(presentationState);
	let releaseFirstLookup, markFirstLookupStarted, presentationLookups = 0; const firstLookupStarted = new Promise((resolveStarted) => { markFirstLookupStarted = resolveStarted; });
	presentationState.projectSummaryByChannel = async (...args) => {
		if (++presentationLookups === 1) { markFirstLookupStarted(); await new Promise((resolveLookup) => { releaseFirstLookup = resolveLookup; }); }
		return lookupPresentation(...args);
	};
	const firstControl = presentationCore.executeDiscordPresentationControl(controlRequest); const duplicatePresentationControl = presentationCore.executeDiscordPresentationControl(controlRequest);
	assert.equal(firstControl, duplicatePresentationControl, "identical interaction attaches to exact reserved promise");
	await firstLookupStarted;
	const laterControl = presentationCore.executeDiscordPresentationControl({ ...controlRequest, requestId: "busy-interaction" }); assert.deepEqual(await laterControl, { ok: false, message: "A manager presentation control is already running; retry later." });
	assert.equal(presentationLookups, 1, "later interaction must not overtake delayed first authorization");
	releaseFirstLookup();
	await waitFor(() => presentationExecutions === 1, "reserved first presentation control");
	releasePresentationControl({ ok: true, message: "opaque execution complete" });
	assert.deepEqual(await firstControl, { ok: true, message: "opaque execution complete" });
	assert.deepEqual(await duplicatePresentationControl, { ok: true, message: "opaque execution complete" },
		"a duplicate interaction ID must share the original result");
	assert.deepEqual(await presentationCore.executeDiscordPresentationControl(controlRequest),
		{ ok: true, message: "opaque execution complete" }, "completed duplicate must remain idempotent");
	for (const [description, request] of [
		["wrong guild", { ...controlRequest, requestId: "wrong-guild", guildId: "999" }],
		["wrong channel", { ...controlRequest, requestId: "wrong-channel", channelId: "other" }],
		["wrong message", { ...controlRequest, requestId: "wrong-message", messageId: "other" }],
		["wrong revision", { ...controlRequest, requestId: "wrong-revision", customId: `m:${"2".repeat(64)}:github-refresh-reconcile` }],
		["foreign control", { ...controlRequest, requestId: "foreign-control", customId: `m:${firstPresentation.revision}:foreign-control` }],
	]) assert.equal((await presentationCore.executeDiscordPresentationControl(request)).ok, false, description);
	const componentlessPresentation = managerPresentationPayload("3".repeat(64), "opaque presentation two", []);
	await presentationCore.queueManagerPresentation(
		"presentation-client", "presentation-generation", "presentation-session", componentlessPresentation);
	await waitFor(() => FakeGateway.channelMessages.get(presentationMapping.channelId)?.at(-1)?.presentation?.revision === componentlessPresentation.revision,
		"explicit manager component removal");
	assert.deepEqual(FakeGateway.channelMessages.get(presentationMapping.channelId).at(-1).presentation.controls, [],
		"editing to zero controls must explicitly persist an empty component presentation");
	assert.equal((await presentationCore.executeDiscordPresentationControl(
		{ ...controlRequest, requestId: "removed-control" })).ok, false, "removed controls must be inert");
	const ownerLossPresentation = managerPresentationPayload("5".repeat(64), "owner-loss payload");
	await presentationCore.queueManagerPresentation(
		"presentation-client", "presentation-generation", "presentation-session", ownerLossPresentation);
	await waitFor(() => FakeGateway.channelMessages.get(presentationMapping.channelId)?.at(-1)?.presentation?.revision === ownerLossPresentation.revision,
		"owner-loss presentation delivery");
	const ownerLossMessage = FakeGateway.channelMessages.get(presentationMapping.channelId).at(-1);
	await presentationCore.prepareRegistration("backup-client", "backup-generation",
		{ cwd: "/presentation-manager", projectIdentityResolved: true, sessionId: "backup-session" });
	await presentationCore.activateRegistration("backup-client", "backup-generation", "backup-session", () => true,
		undefined, false, undefined, true, { controlIds: ["github-refresh-reconcile"], execute: async () => ({ ok: true, message: "backup" }) });
	const backupPresentation = managerPresentationPayload("6".repeat(64), "backup owner payload");
	await presentationCore.queueManagerPresentation("backup-client", "backup-generation", "backup-session", backupPresentation);
	const ownerLossControl = presentationCore.executeDiscordPresentationControl({ requestId: "owner-loss-control", guildId: "12345",
		channelId: presentationMapping.channelId, messageId: ownerLossMessage.id,
		customId: `m:${ownerLossPresentation.revision}:github-refresh-reconcile` });
	await waitFor(() => presentationExecutions === 2, "owner-loss in-flight control");
	presentationCore.unregisterClient("presentation-client", "presentation-generation");
	releasePresentationControl({ ok: true, message: "stale completion" });
	assert.deepEqual(await ownerLossControl, { ok: false,
		message: "The manager presentation owner disconnected while the control was running." },
	"owner loss must fence stale completion");
	await waitFor(() => FakeGateway.channelMessages.get(presentationMapping.channelId)?.at(-1)?.presentation?.revision === backupPresentation.revision, "backup owner publication");
	assert.equal(FakeGateway.channelMessages.get(presentationMapping.channelId).filter((message) => message.botOwned).length, 1);
	assert.deepEqual(FakeGateway.channelMessages.get(presentationMapping.channelId).at(-1).presentation.controls, backupPresentation.controls);
	presentationCore.unregisterClient("backup-client", "backup-generation");
	await waitFor(() => FakeGateway.channelMessages.get(presentationMapping.channelId)?.at(-1)?.presentation?.controls.length === 0, "final owner stripping");
	await presentationCore.stop();

	assert.equal(projectChannelName("/one/My Project"), "my-project");
	assert.equal(projectChannelName("/one/project"), projectChannelName("/two/project"));
	assert.equal(projectChannelName(`/tmp/${"a".repeat(150)}`).length, 100);
	assert.equal(collidingProjectChannelName(`/tmp/${"a".repeat(150)}`).length, 100);
	assert.match(collidingProjectChannelName("/one/project"), /^project-[a-f0-9]{8}$/);
	assert.equal(projectChannelName("/tmp/项目"), "project");
	assert.match(collidingProjectChannelName("/tmp/另一个项目"), /^project-[a-f0-9]{8}$/);
	assert.equal(projectChannelName("/tmp/Café déjà"), "cafe-deja");
	assert.equal(sessionThreadName("12345678-abcd", "Fix Things"), "fix-things");
	assert.equal(sessionThreadName("12345678-abcd", "strip-pi-prefix-from-thread"), "strip-pi-prefix-from-thread");
	assert.equal(sessionThreadName("12345678-abcd"), "session");
	assert.equal(sessionThreadName("aaaaaaaa-1111", "Shared task"), "shared-task");
	assert.equal(sessionThreadName("bbbbbbbb-2222", "Shared task"), "shared-task");
	assert.equal(sessionThreadName("aaaaaaaa-1111", "Shared task"), sessionThreadName("bbbbbbbb-2222", "Shared task"));
	assert.equal(sessionThreadName("12345678-abcd", "a".repeat(150)).length, 100);
	assert.equal(assistantText({
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: " Final " }, { type: "text", text: "answer " }],
	}), "Final answer");
	assert.equal(assistantText({
		role: "assistant",
		stopReason: "length",
		content: [{ type: "text", text: "bounded" }],
	}), "bounded");
	const omittedAssistantMessages = [
		{ role: "user", stopReason: "stop", content: [{ type: "text", text: "user" }] },
		{ role: "system", stopReason: "stop", content: [{ type: "text", text: "system" }] },
		...(["toolUse", "pending", "aborted", "error", undefined].map((stopReason) => ({
			role: "assistant", stopReason, content: [{ type: "text", text: "partial" }],
		}))),
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "visible" }, { type: "toolCall" }] },
		...(["tool_call", "progress", "thinking", "image", "audio"].map((type) => ({
			role: "assistant", stopReason: "stop", content: [{ type }],
		}))),
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: " \n " }] },
		{ role: "assistant", stopReason: "stop", content: "malformed" },
		{ role: "assistant", stopReason: "stop", content: [null] },
		{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: 7 }] },
	];
	for (const message of omittedAssistantMessages) assert.equal(assistantText(message), undefined);
	const chunks = splitDiscordText("a".repeat(4_100));
	assert.equal(chunks.join(""), "a".repeat(4_100));
	assert.ok(chunks.every((chunk) => chunk.length <= 1_900));
	const interactivePrefix = "👨‍💻: ";
	const prefixedInteractive = (body) => `${interactivePrefix}${body}`;
	const interactiveBodies = (messages) => messages.map((message) => message.slice(interactivePrefix.length));
	assert.deepEqual(interactiveUserChunks("ordinary input"), [prefixedInteractive("ordinary input")]);
	assert.deepEqual(interactiveUserChunks("line one\nline two"), [prefixedInteractive("line one\nline two")]);
	assert.deepEqual(
		interactiveUserChunks("**bold** _under_ `code` \\ slash"),
		[prefixedInteractive("**bold** _under_ `code` \\ slash")],
		"interactive Markdown must remain byte-for-byte unchanged after the prefix",
	);
	assert.deepEqual(interactiveUserChunks(""), []);
	assert.deepEqual(interactiveUserChunks(" \n "), [prefixedInteractive(" \n ")], "whitespace-only interactive input must be preserved");
	const interactiveCapacity = 1_900 - interactivePrefix.length;
	assert.equal(interactiveCapacity, 1_893);
	assert.equal(interactiveUserChunks("a".repeat(interactiveCapacity))[0].length, 1_900);
	const boundaryUnicodeInput = `${"a".repeat(interactiveCapacity - 1)}😀b`;
	const boundaryUnicodeChunks = interactiveUserChunks(boundaryUnicodeInput);
	assert.equal(boundaryUnicodeChunks.length, 2);
	assert.ok(boundaryUnicodeChunks.every((chunk) => chunk.startsWith(interactivePrefix) && chunk.length <= 1_900));
	assert.equal(interactiveBodies(boundaryUnicodeChunks).join(""), boundaryUnicodeInput, "UTF-16 surrogate pairs must remain intact across chunks");
	assert.doesNotMatch(interactiveBodies(boundaryUnicodeChunks)[0], /[\uD800-\uDBFF]$/);
	assert.doesNotMatch(interactiveBodies(boundaryUnicodeChunks)[1], /^[\uDC00-\uDFFF]/);
	assert.throws(() => interactiveUserChunks("x", interactivePrefix.length + 1), /between 9 and 2000/);
	const longInteractiveInput = "long *markdown* line\n".repeat(300);
	const longInteractiveChunks = interactiveUserChunks(longInteractiveInput);
	assert.ok(longInteractiveChunks.length > 1);
	assert.ok(longInteractiveChunks.every((chunk) => chunk.startsWith(interactivePrefix) && chunk.length <= 1_900));
	assert.ok(longInteractiveChunks.every((chunk) => !chunk.includes("────")), "interactive chunks must not reintroduce divider lines");
	assert.equal(interactiveBodies(longInteractiveChunks).join(""), longInteractiveInput);

	const resolvedRegistrationFrame = {
		type: "register",
		token: "token",
		clientId: "client",
		generation: "generation",
		configFingerprint: "fingerprint",
		configEpoch: 1,
		cwd: canonicalMainCheckout,
		projectIdentityResolved: true,
		sessionId: "session",
	};
	assert.equal(isClientFrame(resolvedRegistrationFrame), true);
	assert.equal(isClientFrame({ ...resolvedRegistrationFrame, subscribeOwnerToThread: true }), true);
	assert.equal(isClientFrame({ ...resolvedRegistrationFrame, subscribeOwnerToThread: false }), false,
		"owner subscription must be an explicit additive registration capability");
	assert.equal(isClientFrame({ ...resolvedRegistrationFrame, projectIdentityResolved: "true" }), false);
	const controlRegistrationFrame = {
		...resolvedRegistrationFrame,
		sessionControls: {
			modelCatalogue: Array.from({ length: MAX_MODEL_CATALOGUE_ITEMS }, (_, index) => ({
				provider: "provider",
				id: `model-${index}`,
				name: `Model ${index}`,
			})),
		},
	};
	assert.equal(isClientFrame(controlRegistrationFrame), true);
	assert.equal(isClientFrame({
		...controlRegistrationFrame,
		sessionControls: { modelCatalogue: [...controlRegistrationFrame.sessionControls.modelCatalogue, { provider: "p", id: "overflow", name: "Overflow" }] },
	}), false, "registration model catalogues must be bounded");
	assert.equal(isClientFrame({ type: "control_result", requestId: "control-1", ok: true, message: "done" }), true);
	const managerTask = { taskId: "safe-task", project: "pi-extensions", title: "Safe task", status: "active" };
	const managerProject = { projectId: "pi-extensions" };
	assert.equal(isClientFrame({
		...resolvedRegistrationFrame,
		managerControls: { taskCatalogue: [managerTask], projectCatalogue: [managerProject] },
	}), true);
	assert.equal(isClientFrame({
		...resolvedRegistrationFrame,
		managerControls: {
			taskCatalogue: Array.from({ length: MAX_MANAGER_TASK_CATALOGUE_ITEMS + 1 }, () => managerTask),
			projectCatalogue: [managerProject],
		},
	}), false, "manager registration task catalogues must be bounded");
	assert.equal(isClientFrame({
		...resolvedRegistrationFrame,
		managerControls: {
			taskCatalogue: [managerTask],
			projectCatalogue: Array.from({ length: MAX_MANAGER_PROJECT_CATALOGUE_ITEMS + 1 }, (_, index) => ({ projectId: `project-${index}` })),
		},
	}), false, "manager registration project catalogues must be bounded");
	assert.equal(isClientFrame({
		...resolvedRegistrationFrame,
		managerControls: { taskCatalogue: [{ ...managerTask, taskId: "../hostile" }], projectCatalogue: [managerProject] },
	}), false, "manager task IDs must be safe canonical IDs");
	assert.equal(isClientFrame({
		type: "manager_catalogue",
		requestId: "catalogue-1",
		taskCatalogue: [managerTask],
		projectCatalogue: [managerProject],
	}), true);
	assert.equal(isClientFrame({ type: "manager_catalogue", requestId: "catalogue-rolling-client", taskCatalogue: [managerTask] }), true,
		"older lifecycle-only manager clients must remain protocol-compatible without ask targets");
	assert.equal(isClientFrame({ type: "manager_control_result", requestId: "manager-1", ok: true, message: "done" }), true);
	assert.equal(isClientFrame({ type: "release_inbound_images", requestId: "release-1", messageId: "message-1" }), true);
	assert.equal(isServerFrame({ type: "inbound_images_released", requestId: "release-1", messageId: "message-1" }), true);
	assert.equal(isServerFrame({ type: "control", requestId: "control-1", action: { type: "thinking", level: "high" } }), true);
	assert.equal(isServerFrame({ type: "control", requestId: "control-1", action: { type: "thinking", level: "turbo" } }), false);
	for (const action of ["handoff", "takeback", "archive", "merge-and-archive", "reconcile-pr"]) {
		assert.equal(isServerFrame({ type: "manager_control", requestId: `manager-${action}`, action, taskId: "safe-task" }), true);
	}
	assert.equal(isServerFrame({ type: "manager_control", requestId: "manager-reconcile-all", action: "reconcile-pr" }), true,
		"reconcile-pr protocol frames may omit taskId");
	assert.equal(isServerFrame({ type: "manager_control", requestId: "manager-handoff-all", action: "handoff" }), false,
		"only reconcile-pr protocol frames may omit taskId");
	assert.equal(isServerFrame({
		type: "manager_control",
		requestId: "manager-ask",
		action: "ask",
		target: "task:safe-task",
		request: "Inspect it",
	}), true);
	for (const action of ["status", "merge", "handoff-now"]) {
		assert.equal(isServerFrame({ type: "manager_control", requestId: `manager-${action}`, action, taskId: "safe-task" }), false,
			`unsupported manager action ${action} must fail closed`);
	}
	assert.equal(isServerFrame({ type: "manager_control", requestId: "manager-hostile", action: "archive", taskId: "../safe-task" }), false);
	assert.equal(isServerFrame({ type: "manager_control", requestId: "manager-hostile-ask", action: "ask", target: "task:../safe", request: "x" }), false);
	assert.equal(isServerFrame({ type: "manager_control", requestId: "manager-empty-ask", action: "ask", target: "task:safe-task", request: "" }), false);
	assert.equal(isServerFrame({
		type: "manager_control", requestId: "manager-oversize-ask", action: "ask", target: "project:pi-extensions", request: "x".repeat(2_001),
	}), false);

	const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const validAttachmentUrl = "https://cdn.discordapp.com/attachments/12345/67890/image.png?ex=signed";
	const imageUnitDirectory = join(dataDir, "image-unit");
	const imageFetchCalls = [];
	const imageStore = new InboundImageStore(imageUnitDirectory, async (url, init) => {
		imageFetchCalls.push({ url, init });
		return new Response(pngBytes, {
			status: 200,
			headers: { "content-type": "image/png", "content-length": String(pngBytes.length) },
		});
	});
	await imageStore.initialize(new Set());
	const preparedImage = await imageStore.prepare([{
		id: "67890",
		url: validAttachmentUrl,
		contentType: "image/png",
		size: pngBytes.length,
	}]);
	assert.deepEqual(preparedImage.warnings, []);
	const [downloadedImage] = preparedImage.images;
	assert.equal(imageFetchCalls.length, 1);
	assert.equal(imageFetchCalls[0].url, validAttachmentUrl);
	assert.equal(imageFetchCalls[0].init.redirect, "manual");
	assert.equal(imageFetchCalls[0].init.credentials, "omit");
	assert.equal((await stat(downloadedImage.localPath)).mode & 0o777, 0o600);
	assert.deepEqual(await loadInboundImages(imageUnitDirectory, [downloadedImage]), [{
		type: "image",
		data: pngBytes.toString("base64"),
		mimeType: "image/png",
	}]);
	assert.equal(isServerFrame({ type: "inbound", messageId: "image", text: "", images: [downloadedImage] }), true);
	assert.equal(isServerFrame({
		type: "inbound",
		messageId: "overflow",
		text: "",
		images: Array.from({ length: MAX_INBOUND_IMAGES + 1 }, () => downloadedImage),
	}), false, "inbound image IPC metadata must be count-bounded");
	assert.equal(isServerFrame({
		type: "inbound",
		messageId: "byte-overflow",
		text: "",
		images: Array.from({ length: 3 }, (_, index) => ({
			...downloadedImage,
			attachmentId: String(60_000 + index),
			localPath: downloadedImage.localPath.replace(/\.image$/, `-${index}.image`),
			size: MAX_INBOUND_IMAGE_BYTES,
		})),
	}), false, "inbound image IPC metadata must enforce the aggregate byte limit");
	assert.equal(isServerFrame({
		type: "inbound",
		messageId: "path-overflow",
		text: "",
		images: [{ ...downloadedImage, localPath: "x".repeat(4_097) }],
	}), false, "inbound image IPC paths must be bounded");
	await assert.rejects(() => loadInboundImages(imageUnitDirectory, [{ ...downloadedImage, localPath: "/etc/passwd" }]), /outside the relay image directory/);
	const outsideImage = join(dataDir, "outside.image");
	await writeFile(outsideImage, pngBytes);
	const symlinkImage = join(imageUnitDirectory, "00000000-0000-4000-8000-000000000000.image");
	await symlink(outsideImage, symlinkImage);
	await assert.rejects(() => loadInboundImages(imageUnitDirectory, [{ ...downloadedImage, localPath: symlinkImage }]), /file metadata does not match/);
	await rm(symlinkImage);
	let hostileFetches = 0;
	const hostileStore = new InboundImageStore(join(dataDir, "hostile-image"), async () => {
		hostileFetches++;
		return new Response(pngBytes);
	});
	const hostileOutcome = await hostileStore.prepare([{
		id: "67890",
		url: "https://example.com/attachments/12345/67890/image.png",
		contentType: "image/png",
		size: pngBytes.length,
	}]);
	assert.equal(hostileOutcome.images.length, 0);
	assert.match(hostileOutcome.warnings[0], /outside the Discord attachment CDN/);
	assert.equal(hostileFetches, 0, "arbitrary hosts must never be fetched");
	const unsupportedOutcome = await hostileStore.prepare([{
		id: "67890",
		url: validAttachmentUrl,
		contentType: "image/svg+xml",
		size: 100,
	}]);
	assert.equal(unsupportedOutcome.images.length, 0);
	assert.match(unsupportedOutcome.warnings[0], /missing or unsupported/);
	assert.equal(hostileFetches, 0, "unsupported attachments must warn without network access");
	const overCountOutcome = await hostileStore.prepare(Array.from({ length: MAX_INBOUND_IMAGES + 1 }, (_, index) => ({
		id: String(80_000 + index),
		url: `https://cdn.discordapp.com/attachments/12345/${80_000 + index}/image.png`,
		contentType: "image/png",
		size: pngBytes.length,
	})));
	assert.match(overCountOutcome.warnings[0], /more than 4 supported images/);
	assert.equal(hostileFetches, 0, "over-count messages must resolve before network access");
	const oversizeOutcome = await hostileStore.prepare([{
		id: "67890",
		url: validAttachmentUrl,
		contentType: "image/png",
		size: MAX_INBOUND_IMAGE_BYTES + 1,
	}]);
	assert.match(oversizeOutcome.warnings[0], /declared image size/);
	const aggregateOutcome = await hostileStore.prepare([
		{ id: "70001", url: "https://cdn.discordapp.com/attachments/12345/70001/a.png", contentType: "image/png", size: MAX_INBOUND_IMAGE_BYTES },
		{ id: "70002", url: "https://cdn.discordapp.com/attachments/12345/70002/b.png", contentType: "image/png", size: MAX_INBOUND_IMAGE_BYTES },
		{ id: "70003", url: "https://cdn.discordapp.com/attachments/12345/70003/c.png", contentType: "image/png", size: 1 },
	]);
	assert.match(aggregateOutcome.warnings[0], new RegExp(`total exceeds ${MAX_INBOUND_MESSAGE_IMAGE_BYTES}`));
	let redirectAttempts = 0;
	const redirectOutcome = await new InboundImageStore(join(dataDir, "redirect-image"), async () => {
		redirectAttempts++;
		return new Response(null, { status: 302, headers: { location: "https://example.com/image.png" } });
	}).prepare([{ id: "67890", url: validAttachmentUrl, contentType: "image/png", size: pngBytes.length }]);
	assert.match(redirectOutcome.warnings[0], /redirects are not allowed/);
	assert.equal(redirectAttempts, 1, "redirect failures must not be retried or followed");
	const mimeOutcome = await new InboundImageStore(join(dataDir, "mime-image"), async () => new Response(pngBytes, {
		status: 200,
		headers: { "content-type": "image/jpeg", "content-length": String(pngBytes.length) },
	})).prepare([{ id: "67890", url: validAttachmentUrl, contentType: "image/png", size: pngBytes.length }]);
	assert.match(mimeOutcome.warnings[0], /response MIME type/);
	const signatureOutcome = await new InboundImageStore(join(dataDir, "signature-image"), async () => new Response(Buffer.from("not-png!"), {
		status: 200,
		headers: { "content-type": "image/png", "content-length": "8" },
	})).prepare([{ id: "67890", url: validAttachmentUrl, contentType: "image/png", size: 8 }]);
	assert.match(signatureOutcome.warnings[0], /file signature/);
	const streamOutcome = await new InboundImageStore(join(dataDir, "stream-overflow-image"), async () => new Response(Buffer.concat([pngBytes, Buffer.from([0])]), {
		status: 200,
		headers: { "content-type": "image/png" },
	})).prepare([{ id: "67890", url: validAttachmentUrl, contentType: "image/png", size: pngBytes.length }]);
	assert.match(streamOutcome.warnings[0], /exceeds declared/);
	let retryAttempts = 0;
	const retryStore = new InboundImageStore(join(dataDir, "retry-image"), async () => {
		retryAttempts++;
		if (retryAttempts < INBOUND_IMAGE_DOWNLOAD_ATTEMPTS) return new Response("unavailable", { status: 503 });
		return new Response(pngBytes, {
			status: 200,
			headers: { "content-type": "image/png", "content-length": String(pngBytes.length) },
		});
	});
	const retriedPreparation = await retryStore.prepare([{ id: "67890", url: validAttachmentUrl, contentType: "image/png", size: pngBytes.length }]);
	const retriedImages = retriedPreparation.images;
	assert.equal(retryAttempts, INBOUND_IMAGE_DOWNLOAD_ATTEMPTS, "transient CDN failures must use the bounded retry budget");
	let exhaustedAttempts = 0;
	await assert.rejects(
		() => new InboundImageStore(join(dataDir, "exhausted-image"), async () => {
			exhaustedAttempts++;
			return new Response("unavailable", { status: 503 });
		}).prepare([{ id: "67890", url: validAttachmentUrl, contentType: "image/png", size: pngBytes.length }]),
		(error) => error instanceof TransientInboundImageError,
	);
	assert.equal(exhaustedAttempts, INBOUND_IMAGE_DOWNLOAD_ATTEMPTS, "transient exhaustion must stop at the explicit attempt limit");

	const spoolDirectory = join(dataDir, "spool-budget");
	await mkdir(spoolDirectory, { recursive: true });
	const spoolReferences = new Set();
	for (let index = 0; index < 16; index++) {
		const path = join(spoolDirectory, `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000.image`);
		const handle = await open(path, "w", 0o600);
		await handle.truncate(index === 15 ? MAX_INBOUND_IMAGE_BYTES - pngBytes.length : MAX_INBOUND_IMAGE_BYTES);
		await handle.close();
		spoolReferences.add(path);
	}
	let spoolFetches = 0;
	const spoolStore = new InboundImageStore(spoolDirectory, async () => {
		spoolFetches++;
		return new Response(pngBytes, {
			status: 200,
			headers: { "content-type": "image/png", "content-length": String(pngBytes.length) },
		});
	});
	await spoolStore.initialize(spoolReferences);
	const concurrentSpoolOutcomes = await Promise.all([
		spoolStore.prepare([{ id: "91001", url: "https://cdn.discordapp.com/attachments/12345/91001/a.png", contentType: "image/png", size: pngBytes.length }]),
		spoolStore.prepare([{ id: "91002", url: "https://cdn.discordapp.com/attachments/12345/91002/b.png", contentType: "image/png", size: pngBytes.length }]),
	]);
	assert.equal(concurrentSpoolOutcomes.filter((outcome) => outcome.images.length === 1).length, 1);
	assert.equal(concurrentSpoolOutcomes.filter((outcome) => outcome.warnings[0]?.includes("spool budget")).length, 1);
	assert.equal(spoolFetches, 1, "serialized reservations must enforce the aggregate spool budget under concurrency");
	assert.equal(MAX_INBOUND_IMAGE_SPOOL_BYTES, 128 * 1024 * 1024);
	await spoolStore.remove(concurrentSpoolOutcomes.flatMap((outcome) => outcome.images.map((image) => image.localPath)));

	const orphanPath = join(imageUnitDirectory, "11111111-1111-4111-8111-111111111111.image");
	await writeFile(orphanPath, pngBytes);
	await imageStore.initialize(new Set([downloadedImage.localPath]));
	await assert.rejects(() => readFile(orphanPath), { code: "ENOENT" });
	assert.deepEqual(await readFile(downloadedImage.localPath), pngBytes, "restart cleanup must preserve referenced images");
	await imageStore.remove([downloadedImage.localPath, "/etc/passwd"]);
	await assert.rejects(() => readFile(downloadedImage.localPath), { code: "ENOENT" });
	await retryStore.remove(retriedImages.map((image) => image.localPath));

	const rollingImageDirectory = join(dataDir, "rolling-images");
	const rollingImageState = new DiscordStateStore(join(dataDir, "rolling-images-state.json"));
	const rollingImageGateway = new FakeGateway();
	const rollingImageCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		rollingImageState,
		rollingImageGateway,
		() => {},
		new InboundImageStore(rollingImageDirectory, async () => new Response(pngBytes, {
			status: 200,
			headers: { "content-type": "image/png", "content-length": String(pngBytes.length) },
		})),
	);
	await rollingImageCore.start();
	const rollingPrepared = await rollingImageCore.prepareRegistration("old-client", "old-generation", {
		cwd: "/rolling-images",
		sessionId: "rolling-image-session",
	});
	const oldClientDeliveries = [];
	await rollingImageCore.activateRegistration(
		"old-client",
		"old-generation",
		"rolling-image-session",
		(message) => { oldClientDeliveries.push(message); return true; },
		undefined,
		false,
	);
	await rollingImageGateway.emit({
		id: "70000",
		channelId: rollingPrepared.threadId,
		content: "do not downgrade",
		authorBot: false,
		attachments: [{ id: "70000", url: validAttachmentUrl, contentType: "image/png", size: pngBytes.length }],
	});
	assert.equal(oldClientDeliveries.length, 0, "old clients must not receive or acknowledge downgraded image messages");
	assert.equal((await rollingImageState.pendingMessages("rolling-image-session")).length, 1);
	rollingImageCore.unregisterClient("old-client", "old-generation");
	await rollingImageCore.prepareRegistration("new-client", "new-generation", {
		cwd: "/rolling-images",
		sessionId: "rolling-image-session",
	});
	const upgradedDeliveries = [];
	await rollingImageCore.activateRegistration(
		"new-client",
		"new-generation",
		"rolling-image-session",
		(message) => { upgradedDeliveries.push(message); return true; },
		undefined,
		true,
	);
	assert.equal(upgradedDeliveries.length, 1, "queued images must resume after a compatible client registers");
	assert.equal(upgradedDeliveries[0].images.length, 1);
	await rollingImageCore.acknowledge("new-client", "new-generation", "rolling-image-session", "70000");
	assert.deepEqual(await readFile(upgradedDeliveries[0].images[0].localPath), pngBytes, "acknowledgement must retain files for the active run");
	await rollingImageCore.releaseInboundImages("new-client", "new-generation", "rolling-image-session", "70000");
	await assert.rejects(() => readFile(upgradedDeliveries[0].images[0].localPath), { code: "ENOENT" });
	await rollingImageCore.stop();

	const rejectedCatchUpState = new DiscordStateStore(join(dataDir, "rejected-catch-up-state.json"));
	await rejectedCatchUpState.resolveProjectChannel("/rejected-catch-up", async () => "rejected-channel");
	await rejectedCatchUpState.resolveSessionThread(
		"rejected-catch-up-session",
		"/rejected-catch-up",
		"rejected-channel",
		async () => "rejected-thread",
	);
	const rejectedCatchUpGateway = new FakeGateway();
	FakeGateway.catchUpByThread.set("rejected-thread", [
		{
			id: "93001",
			channelId: "rejected-thread",
			content: "",
			authorBot: false,
			attachments: [{ id: "93001", url: "https://example.com/not-discord.png", contentType: "image/png", size: pngBytes.length }],
		},
		{ id: "93002", channelId: "rejected-thread", content: "after permanent catch-up rejection", authorBot: false },
	]);
	let rejectedCatchUpFetches = 0;
	const rejectedCatchUpCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		rejectedCatchUpState,
		rejectedCatchUpGateway,
		() => {},
		new InboundImageStore(join(dataDir, "rejected-catch-up-images"), async () => {
			rejectedCatchUpFetches++;
			return new Response(pngBytes);
		}),
	);
	await rejectedCatchUpCore.start();
	await rejectedCatchUpCore.prepareRegistration("rejected-client", "rejected-generation", {
		cwd: "/rejected-catch-up",
		sessionId: "rejected-catch-up-session",
	});
	const rejectedCatchUpDeliveries = [];
	await rejectedCatchUpCore.activateRegistration(
		"rejected-client",
		"rejected-generation",
		"rejected-catch-up-session",
		(message) => { rejectedCatchUpDeliveries.push(message); return true; },
		undefined,
		false,
	);
	assert.equal(rejectedCatchUpFetches, 0);
	assert.equal(rejectedCatchUpDeliveries.length, 2, "permanent rejection must not brick catch-up or rolling text clients");
	assert.match(rejectedCatchUpDeliveries[0].content, /outside the Discord attachment CDN/);
	assert.equal(rejectedCatchUpDeliveries[0].images, undefined);
	assert.equal(rejectedCatchUpDeliveries[1].content, "after permanent catch-up rejection");
	assert.equal((await rejectedCatchUpState.getSession("rejected-catch-up-session")).threadCursors["rejected-thread"], "93002");
	await rejectedCatchUpCore.stop();
	FakeGateway.catchUpByThread.delete("rejected-thread");

	const transientState = new DiscordStateStore(join(dataDir, "transient-image-state.json"));
	await transientState.resolveProjectChannel("/transient-images", async () => "transient-channel");
	await transientState.resolveSessionThread(
		"transient-image-session",
		"/transient-images",
		"transient-channel",
		async () => "transient-thread",
	);
	const transientGateway = new FakeGateway();
	let transientFetchAttempts = 0;
	const transientCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		transientState,
		transientGateway,
		() => {},
		new InboundImageStore(join(dataDir, "transient-images"), async () => {
			transientFetchAttempts++;
			if (transientFetchAttempts <= INBOUND_IMAGE_DOWNLOAD_ATTEMPTS) return new Response("unavailable", { status: 503 });
			return new Response(pngBytes, {
				status: 200,
				headers: { "content-type": "image/png", "content-length": String(pngBytes.length) },
			});
		}),
	);
	const transientImageMessage = {
		id: "92001",
		channelId: "transient-thread",
		content: "eventually image",
		authorBot: false,
		attachments: [{ id: "92001", url: "https://cdn.discordapp.com/attachments/12345/92001/image.png", contentType: "image/png", size: pngBytes.length }],
	};
	const afterTransientMessage = {
		id: "92002",
		channelId: "transient-thread",
		content: "later text remains explicit",
		authorBot: false,
	};
	FakeGateway.catchUpByThread.set("transient-thread", [transientImageMessage, afterTransientMessage]);
	await transientCore.start();
	const transientPrepared = await transientCore.prepareRegistration("transient-client", "transient-generation", {
		cwd: "/transient-images",
		sessionId: "transient-image-session",
	});
	assert.equal(transientPrepared.threadId, "transient-thread", "transient exhaustion must not brick registration");
	const transientDeliveries = [];
	await transientCore.activateRegistration(
		"transient-client",
		"transient-generation",
		"transient-image-session",
		(message) => { transientDeliveries.push(message); return true; },
		undefined,
		true,
	);
	assert.equal((await transientState.getSession("transient-image-session")).threadCursors["transient-thread"], undefined,
		"catch-up must not advance across a transient image gap");
	await waitFor(async () => {
		const session = await transientState.getSession("transient-image-session");
		return session.threadCursors["transient-thread"] === "92002" && transientDeliveries.some((message) => message.id === "92001");
	}, "bounded transient image catch-up recovery");
	const recoveredTransient = transientDeliveries.find((message) => message.id === "92001");
	assert.equal(recoveredTransient.images.length, 1);
	assert.match(recoveredTransient.content, /local_path="[^"]+"/);
	assert.equal(transientFetchAttempts, INBOUND_IMAGE_DOWNLOAD_ATTEMPTS + 1);
	await transientCore.acknowledge("transient-client", "transient-generation", "transient-image-session", "92001");
	await transientCore.releaseInboundImages("transient-client", "transient-generation", "transient-image-session", "92001");
	await transientCore.stop();
	FakeGateway.catchUpByThread.delete("transient-thread");

	const autocompleteCatalogue = Array.from({ length: 40 }, (_, index) => ({
		provider: "provider",
		id: `model-${index}`,
		name: `Matching Model ${index}`,
	}));
	assert.equal(modelAutocompleteChoices(autocompleteCatalogue, "matching").length, MAX_MODEL_AUTOCOMPLETE_CHOICES);
	assert.ok(modelAutocompleteChoices(autocompleteCatalogue, "model-39").some((choice) => choice.value === "provider/model-39"));
	const managerAutocompleteCatalogue = Array.from({ length: 40 }, (_, index) => ({
		taskId: `task-${index}`,
		project: "pi-extensions",
		title: `Matching manager task ${index}`,
		status: "active",
	}));
	assert.equal(managerTaskAutocompleteChoices(managerAutocompleteCatalogue, "matching").length, MAX_MANAGER_TASK_AUTOCOMPLETE_CHOICES);
	assert.ok(managerTaskAutocompleteChoices(managerAutocompleteCatalogue, "task-39").some((choice) => choice.value === "task-39"));
	const projectAutocompleteCatalogue = Array.from({ length: 40 }, (_, index) => ({ projectId: `project-${index}` }));
	assert.equal(managerTargetAutocompleteChoices(projectAutocompleteCatalogue, managerAutocompleteCatalogue, "").length,
		MAX_MANAGER_TARGET_AUTOCOMPLETE_CHOICES, "combined ask target autocomplete must return at most 25 choices");
	assert.ok(managerTargetAutocompleteChoices(projectAutocompleteCatalogue, managerAutocompleteCatalogue, "task-39").some((choice) =>
		choice.value === "task:task-39"), "ask target filtering must search task IDs beyond the first unfiltered page");
	assert.equal(isClientFrame({ type: "project_summary", requestId: "summary-request", text: "summary" }), true);
	assert.equal(isClientFrame({ type: "project_summary", requestId: "summary-request", text: "x".repeat(2_001) }), false);
	const ipcPresentation = {
		schemaVersion: 1, revision: "4".repeat(64), content: "opaque", degraded: false, warnings: [],
		controls: [{ id: "github-refresh-reconcile", label: "Refresh", style: "secondary", command: "github-refresh-reconcile" }],
	};
	assert.equal(isClientFrame({ type: "manager_presentation", requestId: "presentation-request", presentation: ipcPresentation }), true);
	assert.equal(isClientFrame({ type: "manager_presentation", requestId: "presentation-request", presentation: {
		...ipcPresentation, controls: [{ ...ipcPresentation.controls[0], command: "status" }],
	} }), false);
	assert.equal(isServerFrame({
		type: "manager_presentation_control", requestId: "interaction", revision: "4".repeat(64),
		controlId: "github-refresh-reconcile", command: "github-refresh-reconcile",
	}), true);
	assert.equal(isServerFrame({
		type: "manager_presentation_control", requestId: "mismatched-interaction", revision: "4".repeat(64),
		controlId: "github-refresh-reconcile", command: "task-reconcile-pr",
	}), false, "presentation control frames require the exact allowlisted ID/command pair");
	assert.equal(isClientFrame({ type: "register", token: "token", clientId: "client", generation: "generation",
		configFingerprint: "fingerprint", configEpoch: 1, cwd: "/the-manager", sessionId: "manager", managerTaskSummaryProducer: true,
		managerPresentation: { schemaVersion: 1, controlIds: ["github-refresh-reconcile", "future-control"] } }), true, "additive controls accepted");
	assert.equal(isClientFrame({
		type: "register", token: "token", clientId: "client", generation: "generation", configFingerprint: "fingerprint",
		configEpoch: 1, cwd: "/the-manager", sessionId: "manager", managerTaskSummaryProducer: false,
	}), false, "manager summary eligibility must fail closed unless explicitly true");
	assert.equal(isClientFrame({ type: "register", token: "t", clientId: "c", generation: "g", configFingerprint: "f", configEpoch: 1, cwd: "/the-manager", sessionId: "m", managerPresentation: { schemaVersion: 1, controlIds: ["bad id"] } }), false);
	const oldManagerRegistration = {
		type: "register", token: "token", clientId: "old-manager", generation: "generation", configFingerprint: "fingerprint",
		configEpoch: 1, cwd: "/the-manager", sessionId: "old-manager-session", managerControls: { taskCatalogue: [] },
	};
	assert.equal(isClientFrame(oldManagerRegistration), true, "new relays must parse old manager registrations without the additive capability");
	assert.equal(isEligibleManagerTaskSummaryProducer("/workspace/the-manager", oldManagerRegistration), false,
		"new relays must fail closed when an old manager registration lacks explicit freshness capability");
	assert.equal(isEligibleManagerTaskSummaryProducer("/workspace/the-manager", {
		...oldManagerRegistration, managerTaskSummaryProducer: true,
	}), true, "new relays must grant legacy summary ownership to explicitly capable verified manager clients");
	assert.deepEqual(negotiatedManagerPresentation("/workspace/the-manager", { ...oldManagerRegistration,
		managerTaskSummaryProducer: true, managerPresentation: { schemaVersion: 1,
			controlIds: ["github-refresh-reconcile", "future-control"] } }),
	{ schemaVersion: 1, controlIds: ["github-refresh-reconcile"] }, "negotiation must intersect additive controls");
	assert.equal(negotiatedManagerPresentation("/workspace/the-manager",
		{ ...oldManagerRegistration, managerTaskSummaryProducer: true }), undefined, "legacy owners remain componentless");
	assert.equal(isEligibleManagerTaskSummaryProducer("/workspace/unrelated", oldManagerRegistration), false,
		"manager-shaped clients from unrelated project identities must not claim summary ownership");
	assert.equal(isEligibleManagerTaskSummaryProducer("/workspace/the-manager", { managerTaskSummaryProducer: true }), false,
		"the additive capability alone must not let an ordinary session claim summary ownership");

	const oldClientRelayDirectory = join(dataDir, "old-client-new-relay");
	await mkdir(oldClientRelayDirectory, { recursive: true });
	const oldClientRelayPaths = relayPaths(oldClientRelayDirectory);
	const oldClientSummaryFrames = [];
	let oldClientActivatedAsProducer;
	const oldClientCore = {
		async start() {},
		async stop() {},
		async prepareRegistration() {
			return { channelId: "old-client-channel", threadId: "old-client-thread", cwd: "/workspace/the-manager" };
		},
		async activateRegistration(...args) { oldClientActivatedAsProducer = args.at(-2); },
		unregisterClient() {},
		async resumeDelivery() {},
		updateManagerCatalogues() {},
		async queueProjectSummary(_clientId, _generation, _sessionId, text) { oldClientSummaryFrames.push(text); },
	};
	const oldClientHost = new LocalRelayHost({
		paths: oldClientRelayPaths,
		token: "old-client-token",
		configFingerprint: "old-client-fingerprint",
		configEpoch: 1,
		lease: { pid: process.pid, nonce: "old-client-lease", heartbeat: async () => true, release: async () => {} },
		core: oldClientCore,
	});
	await oldClientHost.start();
	const oldClientSocket = createConnection(oldClientRelayPaths.socket);
	oldClientSocket.setEncoding("utf8");
	const oldClientServerFrames = [];
	let oldClientBuffer = "";
	oldClientSocket.on("data", (data) => {
		oldClientBuffer += data;
		let newline = oldClientBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = oldClientBuffer.slice(0, newline);
			oldClientBuffer = oldClientBuffer.slice(newline + 1);
			if (line) oldClientServerFrames.push(JSON.parse(line));
			newline = oldClientBuffer.indexOf("\n");
		}
	});
	await new Promise((resolveConnect, rejectConnect) => {
		oldClientSocket.once("connect", resolveConnect);
		oldClientSocket.once("error", rejectConnect);
	});
	oldClientSocket.write(`${JSON.stringify({
		...oldManagerRegistration,
		token: "old-client-token",
		clientId: "old-client",
		generation: "old-generation",
		configFingerprint: "old-client-fingerprint",
	})}\n`);
	await waitFor(() => oldClientServerFrames.some((frame) => frame.type === "registered"), "old client registration on new relay");
	assert.equal(oldClientServerFrames.find((frame) => frame.type === "registered").projectSummaries, undefined,
		"new relays must not advertise summary ownership to old manager clients without explicit freshness capability");
	assert.equal(oldClientActivatedAsProducer, false);
	await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	assert.deepEqual(oldClientSummaryFrames, [],
		"old-client to new-relay rolling compatibility must perform zero summary Discord operations");
	oldClientSocket.end();
	await oldClientHost.stop();

	const previousValidator = (frame) => frame?.type === "outbound" && typeof frame.requestId === "string" &&
		typeof frame.messageId === "string" && typeof frame.text === "string" && (frame.kind === "user" || frame.kind === "assistant");
	const previousRegisterValidator = (frame) => frame?.type === "register" &&
		["token", "clientId", "generation", "configFingerprint", "cwd", "sessionId"].every((key) => typeof frame[key] === "string") &&
		typeof frame.configEpoch === "number";
	compatibilityDirectory = await mkdtemp(join(tmpdir(), "dc-ipc-"));
	const compatibilityPaths = relayPaths(compatibilityDirectory);
	const previousHostFrames = [];
	const previousHostRegistrations = [];
	const compatibilitySockets = [];
	let rejectOutbound = false;
	let handleOutbound;
	const compatibilityServer = createServer((socket) => {
		compatibilitySockets.push(socket);
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (data) => {
			buffer += data;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line) {
					const frame = JSON.parse(line);
					if (frame.type === "register") {
						previousHostRegistrations.push(frame);
						if (!previousRegisterValidator(frame)) socket.end();
						else socket.write(`${JSON.stringify({ type: "registered", channelId: "compat-channel", threadId: "compat-thread", leaderPid: process.pid })}\n`);
					} else if (frame.type === "outbound") {
						previousHostFrames.push(frame);
						if (!previousValidator(frame)) {
							socket.write(`${JSON.stringify({ type: "error", message: "Invalid local Discord relay IPC frame" })}\n`);
						} else if (handleOutbound?.(frame, socket)) {
							// The focused persistence tests control acknowledgement or disconnection.
						} else if (rejectOutbound) {
							socket.write(`${JSON.stringify({ type: "error", message: "injected correlated rejection", requestId: frame.requestId })}\n`);
						} else {
							socket.write(`${JSON.stringify({ type: "outbound_queued", requestId: frame.requestId, messageId: frame.messageId })}\n`);
						}
					} else if (frame.type === "unregister") socket.end();
				}
				newline = buffer.indexOf("\n");
			}
		});
	});
	await new Promise((resolveListen, rejectListen) => {
		compatibilityServer.once("error", rejectListen);
		compatibilityServer.listen(compatibilityPaths.socket, resolveListen);
	});
	const compatibilityErrors = [];
	const compatibilityClient = new LocalRelayClient(
		{ token: "token", guildId: "12345", epoch: 1 },
		{ cwd: "/the-manager", sessionId: "compatibility-session", managerTaskSummaryProducer: true },
		{
			onInbound() {},
			onError(error) { compatibilityErrors.push(error); },
			onStatus() {},
			modelCatalogue: () => [{ provider: "compat", id: "model", name: "Compatibility Model" }],
			onControl: async () => assert.fail("an older relay must not send unsupported controls"),
			managerTaskCatalogue: () => [],
			managerProjectCatalogue: () => [],
			onManagerControl: async () => assert.fail("an older relay must not send unsupported manager controls"),
		},
		{ paths: compatibilityPaths, launchRelay: async () => {} },
	);
	await compatibilityClient.start();
	assert.equal(previousHostRegistrations.length, 1);
	assert.deepEqual(previousHostRegistrations[0].sessionControls.modelCatalogue, [
		{ provider: "compat", id: "model", name: "Compatibility Model" },
	], "new clients may advertise controls to older relays because registration fields are additive");
	assert.equal(previousHostRegistrations[0].inboundImages, true, "new clients may advertise additive image support to older relays");
	assert.equal(previousHostRegistrations[0].managerTaskSummaryProducer, true,
		"new eligible manager clients may advertise summary ownership to an older relay without breaking registration");
	assert.equal(previousRegisterValidator(previousHostRegistrations[0]), true,
		"the previous relay registration validator must accept the additive producer capability");
	assert.equal(compatibilityClient.status().sessionControls, undefined, "an older relay must not advertise unsupported controls");
	assert.equal(compatibilityClient.status().inboundImages, undefined, "an older relay must preserve text-only rolling compatibility");
	compatibilityClient.updateLifecycle("compatibility-inbound", "thinking");
	await compatibilityClient.sendInteractiveUserText("hot **reload**");
	assert.equal(previousHostFrames.length, 1);
	assert.equal(previousHostFrames[0].kind, "user", "interactive presentation must retain the pre-7c01263 outbound kind");
	assert.equal(previousHostFrames[0].text, interactiveUserChunks("hot **reload**")[0]);
	assert.equal(previousValidator(previousHostFrames[0]), true);
	assert.equal(isClientFrame(previousHostFrames[0]), true);
	assert.equal(isClientFrame({ ...previousHostFrames[0], kind: "interactive" }), false, "unknown outbound kinds must remain invalid");
	assert.equal(compatibilityErrors.length, 0);
	rejectOutbound = true;
	const rejectionStarted = Date.now();
	await assert.rejects(() => compatibilityClient.sendUserText("reject once"), /injected correlated rejection/);
	assert.ok(Date.now() - rejectionStarted < 1_000, "correlated request failures must reject without the 30s request timeout");
	assert.equal(previousHostFrames.filter((frame) => frame.text === "reject once").length, 1, "declared request failures must not retry forever");
	rejectOutbound = false;

	const bridgeErrors = [];
	const chainBridge = new DiscordBridge(
		{ token: "token", guildId: "12345", epoch: 1 },
		{ cwd: "/compat-chain", sessionId: "compat-chain" },
		{ onUserMessage() {}, onError(error) { bridgeErrors.push(error); }, onStatus() {} },
		{ paths: compatibilityPaths, launchRelay: async () => {} },
	);
	await chainBridge.start();
	let heldAcknowledgement;
	handleOutbound = (frame, socket) => {
		if (frame.text !== "ordered A") return false;
		heldAcknowledgement = { frame, socket };
		return true;
	};
	const orderedA = chainBridge.enqueueAssistantMessage("stable-a", "ordered A");
	chainBridge.beginAgentRun("unrelated-inbound");
	const orderedB = chainBridge.enqueueAssistantMessage("stable-b", "ordered B");
	await waitFor(() => heldAcknowledgement, "withheld A persistence frame");
	await chainBridge.settleAgentRun();
	await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	assert.equal(previousHostFrames.some((frame) => frame.text === "ordered B"), false,
		"settlement and a withheld A acknowledgement must not let B overtake");
	heldAcknowledgement.socket.write(`${JSON.stringify({
		type: "outbound_queued", requestId: heldAcknowledgement.frame.requestId, messageId: heldAcknowledgement.frame.messageId,
	})}\n`);
	await Promise.all([orderedA, orderedB]);
	assert.deepEqual(previousHostFrames.filter((frame) => frame.text.startsWith("ordered ")).map((frame) => [frame.messageId, frame.text]), [
		["stable-a", "ordered A"], ["stable-b", "ordered B"],
	], "assistant persistence must retain capture order and producer IDs");

	let lostAckAttempts = 0;
	handleOutbound = (frame, socket) => {
		if (frame.text !== "lost acknowledgement") return false;
		if (++lostAckAttempts === 1) socket.destroy();
		return lostAckAttempts === 1;
	};
	await chainBridge.enqueueAssistantMessage("stable-lost", "lost acknowledgement");
	const lostAckFrames = previousHostFrames.filter((frame) => frame.text === "lost acknowledgement");
	assert.equal(lostAckFrames.length, 2);
	assert.equal(new Set(lostAckFrames.map((frame) => frame.messageId)).size, 1,
		"ACK uncertainty must retain the producer message ID for relay deduplication");
	assert.notEqual(lostAckFrames[0].requestId, lostAckFrames[1].requestId,
		"each persistence retry needs a fresh correlated request ID");

	handleOutbound = undefined;
	compatibilitySockets.at(-1).destroy();
	await chainBridge.enqueueAssistantMessage("stable-pre-disconnect", "pre-enqueue disconnect");
	assert.ok(previousHostFrames.some((frame) => frame.messageId === "stable-pre-disconnect"),
		"a pre-enqueue disconnect must reconnect and persist the captured ID");
	rejectOutbound = true;
	await assert.rejects(() => chainBridge.enqueueAssistantMessage("stable-rejected", "rejected assistant"),
		/injected correlated rejection/);
	rejectOutbound = false;
	await chainBridge.enqueueAssistantMessage("stable-after-rejection", "after rejection");
	await assert.rejects(() => chainBridge.stop(), /injected correlated rejection/);
	await assert.rejects(() => chainBridge.enqueueAssistantMessage("closed", "must fail"), /not accepting/);
	assert.equal(bridgeErrors.length, 0);

	const shutdownBridge = new DiscordBridge(
		{ token: "token", guildId: "12345", epoch: 1 },
		{ cwd: "/compat-shutdown", sessionId: "compat-shutdown" },
		{ onUserMessage() {}, onError(error) { bridgeErrors.push(error); }, onStatus() {} },
		{ paths: compatibilityPaths, launchRelay: async () => {} },
	);
	await shutdownBridge.start();
	handleOutbound = (frame) => frame.text === "withheld during shutdown";
	const unpersisted = shutdownBridge.enqueueAssistantMessage("stable-shutdown", "withheld during shutdown");
	void unpersisted.catch(() => {});
	await waitFor(() => previousHostFrames.some((frame) => frame.messageId === "stable-shutdown"), "shutdown persistence frame");
	const assistantShutdownStarted = Date.now();
	await assert.rejects(() => shutdownBridge.stop(), /Timed out after 2000ms draining/);
	assert.ok(Date.now() - assistantShutdownStarted < 4_000, "shutdown persistence drain must remain bounded");
	handleOutbound = undefined;
	await compatibilityClient.stop();
	await new Promise((resolveClose) => compatibilityServer.close(resolveClose));
	await rm(compatibilityDirectory, { recursive: true, force: true });
	compatibilityDirectory = undefined;

	class SlowSocket extends EventEmitter {
		destroyed = false;
		writes = [];
		writable = false;
		write(data) {
			this.writes.push(data);
			return this.writable;
		}
	}
	const slowSocket = new SlowSocket();
	let capacitySignals = 0;
	const boundedWriter = new BoundedSocketWriter(slowSocket, () => { capacitySignals++; });
	assert.equal(boundedWriter.write("initial\n"), true);
	assert.equal(boundedWriter.writeBestEffort("lifecycle\n"), false, "best-effort IPC must not consume normal queue capacity");
	for (let index = 0; index < MAX_QUEUED_IPC_FRAMES; index++) {
		assert.equal(boundedWriter.write(`queued-${index}\n`), true);
	}
	assert.equal(boundedWriter.write("overflow\n"), false, "IPC writer must reject frames beyond its memory cap");
	assert.equal(slowSocket.writes.length, 1, "IPC writer must stop producing while socket.write reports backpressure");
	assert.equal(boundedWriter.queuedFrameCount(), MAX_QUEUED_IPC_FRAMES);
	slowSocket.writable = true;
	slowSocket.emit("drain");
	assert.equal(slowSocket.writes.length, MAX_QUEUED_IPC_FRAMES + 1);
	assert.equal(boundedWriter.queuedFrameCount(), 0);
	assert.equal(capacitySignals, 1, "IPC delivery must resume only after drain");
	boundedWriter.close();

	const apiMessages = Array.from({ length: 250 }, (_, index) => ({
		id: String(index + 1),
		channelId: "pagination-thread",
		content: `message-${index + 1}`,
		authorBot: false,
	}));
	const paginationCalls = [];
	const paginated = await collectChronologicalMessages(async (options) => {
		paginationCalls.push(options);
		return apiMessages
			.filter((message) => options.after ? BigInt(message.id) > BigInt(options.after) : true)
			.filter((message) => options.before ? BigInt(message.id) < BigInt(options.before) : true)
			.sort((left, right) => Number(right.id) - Number(left.id))
			.slice(0, options.limit);
	}, "100");
	assert.deepEqual(paginated.map((message) => message.id), Array.from({ length: 150 }, (_, index) => String(index + 101)));
	assert.deepEqual(paginationCalls.map(({ after, before }) => ({ after, before })), [
		{ after: "100", before: undefined },
		{ after: undefined, before: "151" },
	]);

	const namingStateFile = join(dataDir, "channel-naming-state.json");
	const firstNamingStore = new DiscordStateStore(namingStateFile);
	const allocatedNames = new Map();
	await Promise.all([
		firstNamingStore.resolveProjectChannel("/workspace/one/shared", async (request) => {
			allocatedNames.set("/workspace/one/shared", request.name);
			return "shared-channel-one";
		}),
		new DiscordStateStore(namingStateFile).resolveProjectChannel("/workspace/two/shared", async (request) => {
			allocatedNames.set("/workspace/two/shared", request.name);
			return "shared-channel-two";
		}),
	]);
	assert.equal(new Set(allocatedNames.values()).size, 2, "same-basename projects need distinct allocations");
	assert.ok([...allocatedNames.values()].includes("shared"), "the first race-safe mapping keeps the clean basename");
	for (const [cwd, name] of allocatedNames) {
		if (name !== "shared") assert.equal(name, collidingProjectChannelName(cwd));
	}
	const persistedNames = (await firstNamingStore.load()).projects;
	const restartedNames = new Map();
	await new DiscordStateStore(namingStateFile).resolveProjectChannel("/workspace/one/shared", async (request) => {
		restartedNames.set("/workspace/one/shared", request.name);
		return request.existingChannelId;
	});
	await new DiscordStateStore(namingStateFile).resolveProjectChannel("/workspace/two/shared", async (request) => {
		restartedNames.set("/workspace/two/shared", request.name);
		return request.existingChannelId;
	});
	assert.equal(restartedNames.get("/workspace/one/shared"), persistedNames["/workspace/one/shared"].name);
	assert.equal(restartedNames.get("/workspace/two/shared"), persistedNames["/workspace/two/shared"].name);
	let fallbackName;
	await firstNamingStore.resolveProjectChannel("/workspace/项目", async (request) => {
		fallbackName = request.name;
		return "fallback-channel";
	});
	assert.equal(fallbackName, "project");
	let canonicalName;
	await firstNamingStore.resolveProjectChannel("/workspace/canonical/../canonical/unique", async (request) => {
		canonicalName = request.name;
		return "canonical-channel";
	});
	assert.equal(canonicalName, "unique");
	assert.ok((await firstNamingStore.load()).projects["/workspace/canonical/unique"], "absolute normalized cwd remains the mapping identity");
	const cursorState = new DiscordStateStore(join(dataDir, "cursor-state.json"));
	await cursorState.resolveProjectChannel("/cursor", async () => "cursor-channel");
	await cursorState.resolveSessionThread("cursor-session", "/cursor", "cursor-channel", async () => "cursor-thread");
	await cursorState.recordDiscordMessage("cursor-session", {
		id: "100",
		channelId: "cursor-thread",
		content: "",
		authorBot: true,
	});
	FakeGateway.catchUpByThread.set(
		"cursor-thread",
		apiMessages.slice(100).map((message) => ({ ...message, channelId: "cursor-thread" })),
	);
	const persistCursorMessage = cursorState.recordDiscordMessage.bind(cursorState);
	cursorState.recordDiscordMessage = async (sessionId, message) => {
		if (message.id === "102") throw new Error("injected cursor persistence failure");
		return persistCursorMessage(sessionId, message);
	};
	const cursorCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		cursorState,
		new FakeGateway(),
	);
	await cursorCore.start();
	await assert.rejects(
		() => cursorCore.prepareRegistration("cursor-client", "cursor-generation", {
			cwd: "/cursor",
			sessionId: "cursor-session",
		}),
		/injected cursor persistence failure/,
	);
	assert.equal((await new DiscordStateStore(join(dataDir, "cursor-state.json")).getSession("cursor-session")).threadCursors["cursor-thread"], "101");
	await cursorCore.stop();
	FakeGateway.catchUpByThread.delete("cursor-thread");

	const electionPaths = relayPaths(join(dataDir, "election"));
	const contenders = await Promise.all([
		tryAcquireLeader(electionPaths),
		tryAcquireLeader(electionPaths),
		tryAcquireLeader(electionPaths),
	]);
	const winningLeases = contenders.filter(Boolean);
	assert.equal(winningLeases.length, 1, "atomic leader contention must produce exactly one winner");
	const liveLease = winningLeases[0];
	assert.equal(await tryAcquireLeader(electionPaths, {
		lookupProcessIdentity: async () => undefined,
		probeRelay: async () => true,
	}), undefined, "failed process inspection must not steal a live relay lease");
	assert.equal(await liveLease.heartbeat(), true, "inconclusive inspection must leave the prior owner unfenced");
	await liveLease.release();
	await writeFile(electionPaths.leaderLock, JSON.stringify({
		pid: process.pid,
		nonce: "stale-reused-pid",
		createdAt: 1,
		processIdentity: "unrelated-process-with-reused-pid",
	}));
	assert.equal(await tryAcquireLeader(electionPaths), undefined, "first stale-owner pass performs guarded recovery");
	const recoveredLease = await tryAcquireLeader(electionPaths);
	assert.ok(recoveredLease, "next contender must acquire after stale-owner recovery");
	await recoveredLease.release();

	const fencedPaths = relayPaths(join(dataDir, "fenced-election"));
	const fencedLease = await tryAcquireLeader(fencedPaths);
	assert.ok(fencedLease);
	const expired = new Date(Date.now() - 10_000);
	await utimes(fencedPaths.leaderLock, expired, expired);
	assert.equal(await tryAcquireLeader(fencedPaths, {
		lookupProcessIdentity: async () => undefined,
		probeRelay: async () => false,
	}), undefined, "a live but uninspectable owner must never be replaced merely for unresponsiveness");
	assert.equal(await fencedLease.heartbeat(), true);
	await fencedLease.release();

	const restartPaths = relayPaths(join(dataDir, "restart-ownership"));
	const restartLease = await tryAcquireLeader(restartPaths);
	assert.ok(restartLease);
	const restartOwner = JSON.parse(await readFile(restartPaths.leaderLock, "utf8"));
	const signalledPids = [];
	assert.deepEqual(await restartOwnedRelay(restartPaths, process.pid, restartOwner.nonce, {
		lookupProcessIdentity: async () => restartOwner.processIdentity,
		signalProcess: (pid) => signalledPids.push(pid),
	}), { pid: process.pid, nonce: restartOwner.nonce });
	assert.deepEqual(signalledPids, [process.pid], "verified ownership must signal only its exact relay PID");
	await assert.rejects(() => restartOwnedRelay(restartPaths, process.pid, "stale-connected-lease", {
		lookupProcessIdentity: async () => restartOwner.processIdentity,
		signalProcess: () => assert.fail("stale lease evidence must not signal"),
	}), /lease changed after this client connected/);
	await restartLease.release();

	const missingRestartPaths = relayPaths(join(dataDir, "missing-restart-ownership"));
	await assert.rejects(() => restartOwnedRelay(missingRestartPaths, process.pid, undefined, {
		lookupProcessIdentity: async () => "unused",
		signalProcess: () => assert.fail("missing ownership must not signal"),
	}), /ownership record .* is missing/);
	await mkdir(missingRestartPaths.directory, { recursive: true });
	await writeFile(missingRestartPaths.leaderLock, "{oops");
	await assert.rejects(() => restartOwnedRelay(missingRestartPaths, process.pid, undefined, {
		lookupProcessIdentity: async () => "unused",
		signalProcess: () => assert.fail("malformed ownership must not signal"),
	}), /ownership record .* is malformed/);

	const inaccessibleRestartPaths = relayPaths(join(dataDir, "inaccessible-restart-ownership"));
	await mkdir(inaccessibleRestartPaths.leaderLock, { recursive: true });
	await assert.rejects(() => restartOwnedRelay(inaccessibleRestartPaths, process.pid, undefined, {
		lookupProcessIdentity: async () => "unused",
		signalProcess: () => assert.fail("inaccessible ownership must not signal"),
	}), /ownership record .* cannot be read/);

	const reusedRestartPaths = relayPaths(join(dataDir, "reused-restart-ownership"));
	await mkdir(reusedRestartPaths.directory, { recursive: true });
	await writeFile(reusedRestartPaths.leaderLock, JSON.stringify({
		pid: process.pid,
		nonce: "prior-package-lease",
		createdAt: 1,
		processIdentity: "prior-relay-process",
	}));
	await assert.rejects(() => restartOwnedRelay(reusedRestartPaths, process.pid, "prior-package-lease", {
		lookupProcessIdentity: async () => "reused-unrelated-process",
		signalProcess: () => assert.fail("a reused PID must not be signalled"),
	}), /PID .* was reused by another process/);
	await assert.rejects(() => restartOwnedRelay(reusedRestartPaths, process.pid + 1, undefined, {
		lookupProcessIdentity: async () => "prior-relay-process",
		signalProcess: () => assert.fail("changed ownership must not signal"),
	}), /ownership changed from connected PID/);

	const remapState = new DiscordStateStore(join(dataDir, "remap-state.json"));
	await remapState.resolveProjectChannel("/old", async () => "old-channel");
	await remapState.resolveSessionThread("remapped-session", "/old", "old-channel", async () => "old-thread");
	await remapState.recordDiscordMessage("remapped-session", {
		id: "500",
		channelId: "old-thread",
		content: "preserve across remap",
		authorBot: false,
	});
	await remapState.resolveSessionThread("remapped-session", "/new", "new-channel", async () => "new-thread");
	const remapped = await remapState.getSession("remapped-session");
	assert.deepEqual(remapped.pendingMessages, [{ id: "500", content: "preserve across remap" }]);
	assert.equal(remapped.threadCursors["old-thread"], "500");
	assert.equal(remapped.threadCursors["new-thread"], undefined);

	const deletedStateFile = join(dataDir, "deleted-thread-state.json");
	const deletedState = new DiscordStateStore(deletedStateFile);
	const deletedGateway = new FakeGateway();
	let deletedTerminalFailures = 0;
	const deletedCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		deletedState,
		deletedGateway,
		() => { deletedTerminalFailures++; },
	);
	await deletedCore.start();
	const deletedRegistration = { cwd: "/deleted", sessionId: "deleted-session", sessionName: "Deleted" };
	const healthyRegistration = { cwd: "/healthy", sessionId: "healthy-session", sessionName: "Healthy" };
	const deletedPrepared = await deletedCore.prepareRegistration("deleted-client", "deleted-generation-1", deletedRegistration);
	await deletedCore.activateRegistration("deleted-client", "deleted-generation-1", "deleted-session", () => true);
	await deletedCore.prepareRegistration("healthy-client", "healthy-generation", healthyRegistration);
	await deletedCore.activateRegistration("healthy-client", "healthy-generation", "healthy-session", () => true);
	FakeGateway.deletedThreads.add(deletedPrepared.threadId);
	await deletedCore.queueOutbound("deleted-client", "deleted-generation-1", "deleted-session", "deleted-outbound", "assistant", "retarget me");
	await deletedCore.queueOutbound("healthy-client", "healthy-generation", "healthy-session", "healthy-outbound", "assistant", "must progress");
	await waitFor(() => deletedGateway.sent.some((message) => message.text === "must progress"), "other-session outbound progress past a deleted thread");
	assert.equal(deletedTerminalFailures, 0, "deleted thread delivery must not restart the relay");
	assert.ok((await deletedState.getSession("deleted-session")).outboundMessages.some((message) => message.id === "deleted-outbound"));
	deletedCore.unregisterClient("deleted-client", "deleted-generation-1");
	const repaired = await deletedCore.prepareRegistration("deleted-client", "deleted-generation-2", deletedRegistration);
	assert.notEqual(repaired.threadId, deletedPrepared.threadId);
	await deletedCore.activateRegistration("deleted-client", "deleted-generation-2", "deleted-session", () => true);
	await waitFor(() => deletedGateway.sent.some((message) => message.text === "retarget me"), "remapped outbound delivery");
	assert.equal(deletedGateway.sent.filter((message) => message.text === "retarget me").length, 1);
	assert.equal(deletedGateway.sent.find((message) => message.text === "retarget me").channelId, repaired.threadId);
	assert.equal((await deletedState.getSession("deleted-session")).outboundMessages.length, 0);
	FakeGateway.failOnceTexts.add("retry without another event");
	await deletedCore.queueOutbound("deleted-client", "deleted-generation-2", "deleted-session", "retry-outbound", "assistant", "retry without another event");
	await waitFor(() => FakeGateway.sendAttempts.get("retry without another event") === 1, "initial transient outbound failure");
	await deletedCore.queueOutbound("healthy-client", "healthy-generation", "healthy-session", "unrelated-outbound", "assistant", "unrelated healthy traffic");
	await waitFor(() => deletedGateway.sent.some((message) => message.text === "unrelated healthy traffic"), "unrelated healthy outbound progress");
	await waitFor(async () => deletedGateway.sent.some((message) => message.text === "retry without another event") &&
		(await deletedState.getSession("deleted-session")).outboundMessages.length === 0, "automatic transient outbound retry");
	assert.equal(FakeGateway.sendAttempts.get("retry without another event"), 2);
	const retryTimes = FakeGateway.sendAttemptTimes.get("retry without another event");
	assert.ok(retryTimes[1] - retryTimes[0] >= 90, "unrelated traffic must not bypass the 100ms session retry backoff");
	assert.equal(FakeGateway.sendAttempts.get("unrelated healthy traffic"), 1, "healthy sessions must continue progressing");
	FakeGateway.deletedThreads.delete(deletedPrepared.threadId);
	await deletedCore.stop();

	const faultStateFile = join(dataDir, "fault-state.json");
	const faultState = new DiscordStateStore(faultStateFile);
	const faultGateway = new FakeGateway();
	let terminalFailure;
	const faultCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		faultState,
		faultGateway,
		(error) => { terminalFailure = error; },
	);
	await faultCore.start();
	const faultRegistration = { cwd: "/fault", sessionId: "fault-session", sessionName: "Fault session" };
	await faultCore.prepareRegistration("same-client", "generation-1", faultRegistration);
	await faultCore.activateRegistration("same-client", "generation-1", "fault-session", () => {});
	await faultCore.prepareRegistration("same-client", "generation-2", faultRegistration);
	await faultCore.activateRegistration("same-client", "generation-2", "fault-session", () => {});
	faultCore.unregisterClient("same-client", "generation-1");
	const markChunkSent = faultState.markOutboundChunkSent.bind(faultState);
	let failChunkPersistence = true;
	faultState.markOutboundChunkSent = async (...args) => {
		if (failChunkPersistence) {
			failChunkPersistence = false;
			throw new Error("injected crash after Discord accepted chunk");
		}
		return markChunkSent(...args);
	};
	const longOutbound = "x".repeat(4_000);
	await faultCore.queueOutbound("same-client", "generation-2", "fault-session", "stable-outbound-id", "assistant", longOutbound);
	await waitFor(() => terminalFailure, "fault-injected partial Discord send failure");
	await faultCore.stop();
	const retryGateway = new FakeGateway();
	const retryCore = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		new DiscordStateStore(faultStateFile),
		retryGateway,
	);
	await retryCore.start();
	await retryCore.prepareRegistration("retry-client", "retry-generation", faultRegistration);
	await retryCore.activateRegistration("retry-client", "retry-generation", "fault-session", () => true);
	await waitFor(async () => !(await new DiscordStateStore(faultStateFile).nextOutbound()), "durable outbound retry completion");
	const sentChunks = [...faultGateway.sent, ...retryGateway.sent];
	assert.equal(sentChunks.map((message) => message.text).join(""), longOutbound, "partial retries must send each chunk once");
	assert.equal(new Set(sentChunks.map((message) => message.nonce)).size, sentChunks.length, "chunk nonces must deduplicate retries");
	await retryCore.stop();
	FakeGateway.instances = [];
	FakeGateway.activeConnections = 0;
	FakeGateway.maximumActiveConnections = 0;
	FakeGateway.nonceResults.clear();
	FakeGateway.lifecycleReactions.clear();
	FakeGateway.lifecycleReactionEvents.length = 0;
	FakeGateway.failLifecycleOnce.clear();
	FakeGateway.hangLifecycleFor.clear();
	FakeGateway.channelMessages.clear();
	FakeGateway.summaryEvents.length = 0;

	const relayDirectory = join(dataDir, "shared-relay");
	const paths = relayPaths(relayDirectory);
	const stateFile = join(relayDirectory, "state.json");
	let injectedRestartFailure;
	let requestedRestartPid;
	let requestedRestartNonce;
	const extension = createDiscordExtension({
		environment: {},
		paths,
		loadConfig: async () => ({ token: "token", guildId: "12345", categoryId: "67890", epoch: 1 }),
		saveConfig: async () => {},
		createStateStore: () => new DiscordStateStore(stateFile),
		createTransport: () => new FakeGateway(),
		autoStartForCwd: () => true,
		async restartRelay(expectedPid, expectedNonce) {
			requestedRestartPid = expectedPid;
			requestedRestartNonce = expectedNonce;
			if (injectedRestartFailure) throw injectedRestartFailure;
			FakeGateway.instances.at(-1).terminal();
		},
	});
	const first = createExtensionHarness(extension, {
		cwd: "/work/one",
		sessionId: "session-11111111",
		sessionName: "First session",
	});
	await first.emit("session_start", { reason: "startup" });
	assert.equal(await tryAcquireLeader(paths, {
		lookupProcessIdentity: async () => undefined,
	}), undefined, "failed process inspection plus a healthy relay protocol must preserve the live owner");
	const second = createExtensionHarness(extension, {
		cwd: "/work/one",
		sessionId: "session-22222222",
		sessionName: "Second session",
	});
	await second.emit("session_start", { reason: "startup" });
	const taskNamedSessionId = "33333333-tasktitle";
	const taskNamed = createExtensionHarness(extension, {
		cwd: linkedSubdirectory,
		sessionId: taskNamedSessionId,
		sessionName: "Named Pi session",
	});
	await taskNamed.emit("session_start", { reason: "startup" });
	const taskNamedSiblingSessionId = "44444444-tasktitle";
	const taskNamedSibling = createExtensionHarness(extension, {
		cwd: linkedSubdirectory,
		sessionId: taskNamedSiblingSessionId,
		sessionName: "Named Pi session",
	});
	await taskNamedSibling.emit("session_start", { reason: "startup" });
	const taskFallbackSessionId = "55555555-tasktitle";
	const taskFallback = createExtensionHarness(extension, {
		cwd: linkedSubdirectory,
		sessionId: taskFallbackSessionId,
		sessionName: undefined,
	});
	await taskFallback.emit("session_start", { reason: "startup" });
	const metadataAbsentSessionId = "66666666-generic";
	const metadataAbsent = createExtensionHarness(extension, {
		cwd: nonGitDirectory,
		sessionId: metadataAbsentSessionId,
		sessionName: undefined,
	});
	await metadataAbsent.emit("session_start", { reason: "startup" });
	const managerSummarySession = createExtensionHarness(extension, {
		cwd: managerFixture,
		sessionId: "manager-summary-session",
		sessionName: "Manager",
	});
	const managerEnvironmentKeys = Object.keys(validManagerEnvironment);
	const inheritedManagerEnvironment = Object.fromEntries(managerEnvironmentKeys.map((key) => [key, process.env[key]]));
	Object.assign(process.env, validManagerEnvironment);
	try {
		await managerSummarySession.emit("session_start", { reason: "startup" });
	} finally {
		for (const key of managerEnvironmentKeys) {
			if (inheritedManagerEnvironment[key] === undefined) delete process.env[key];
			else process.env[key] = inheritedManagerEnvironment[key];
		}
	}
	const managerSummaryMapping = await new DiscordStateStore(stateFile).getSession("manager-summary-session");
	await waitFor(() => FakeGateway.channelMessages.get(managerSummaryMapping.channelId)?.at(-1)?.text === "opaque manager payload @everyone",
		"automatic initial manager presentation");
	const canonicalSummaryCommand = "/github-refresh-reconcile";
	const settleManagerCommand = async (stopReason = "stop") => {
		await managerSummarySession.emit("before_agent_start", { prompt: "expanded canonical manager prompt" });
		await managerSummarySession.emit("agent_start", {});
		await managerSummarySession.emit("agent_end", { messages: [{ role: "assistant", stopReason }] });
		await managerSummarySession.emit("agent_settled", {});
	};
	assert.deepEqual(JSON.parse(await readFile(join(managerFixture, "summary-render-args.json"), "utf8")),
		["summary-render", "--root", await realpath(managerFixture), "--max-chars", "2000"], "exact summary-render command");
	const managerSummaryMessage = FakeGateway.channelMessages.get(managerSummaryMapping.channelId).at(-1);
	const managerSummaryMessageId = managerSummaryMessage.id;
	assert.deepEqual(managerSummaryMessage.presentation.controls.map(({ id, label, command }) => ({ id, label, command })), [{
		id: "github-refresh-reconcile", label: "Refresh & Reconcile", command: "github-refresh-reconcile",
	}], "the opaque manager presentation must render the sole canonical control");
	const fullSummary = `Complete manager payload: ${"x".repeat(1_950)}`;
	assert.deepEqual(await managerSummarySession.emit("input", { text: canonicalSummaryCommand, source: "interactive" }),
		{ action: "continue" }, "the exact TUI prompt-template command must retain normal Pi handling");
	await writeFile(join(managerFixture, "presentation.json"), `${JSON.stringify(managerPresentation("b".repeat(64), fullSummary))}\n`);
	await writeFile(join(managerFixture, "data", "tasks", "tui-command-active.md"), "changed during TUI command\n");
	await waitFor(() => FakeGateway.channelMessages.get(managerSummaryMapping.channelId)?.at(-1)?.text === fullSummary,
		"single canonical task lifecycle change must automatically edit the manager summary");
	assert.equal(FakeGateway.channelMessages.get(managerSummaryMapping.channelId).at(-1).id, managerSummaryMessageId,
		"automatic lifecycle publication must edit the existing manager summary message");
	assert.equal(FakeGateway.channelMessages.get(managerSummaryMapping.channelId).filter((message) => message.botOwned).length, 1,
		"automatic lifecycle publication must not post a duplicate manager summary");
	assert.deepEqual(await managerSummarySession.emit("input", { text: canonicalSummaryCommand, source: "interactive" }),
		{ action: "handled" }, "a second canonical TUI command must be rejected while one is active");
	await settleManagerCommand();
	await waitFor(() => FakeGateway.channelMessages.get(managerSummaryMapping.channelId)?.at(-1)?.text === fullSummary,
		"complete untruncated TUI-origin summary publication");
	assert.equal(FakeGateway.channelMessages.get(managerSummaryMapping.channelId).at(-1).id, managerSummaryMessageId,
		"TUI-origin publication must edit the configured manager summary message");
	assert.deepEqual(await managerSummarySession.emit("input", { text: `${canonicalSummaryCommand} extra`, source: "interactive" }),
		{ action: "continue" }, "commands with arguments must not enter manager-summary correlation");

	const discordRequest = { requestId: "manager-presentation-command", guildId: "12345",
		channelId: managerSummaryMapping.channelId, messageId: managerSummaryMessageId,
		customId: `m:${"b".repeat(64)}:github-refresh-reconcile` };
	assert.deepEqual(await FakeGateway.instances[0].executePresentationControl(discordRequest), {
		ok: true, message: "Refresh & Reconcile started in the manager Pi session.",
	}, "Discord control must submit the canonical Pi command");
	assert.equal(managerSummarySession.userMessages.at(-1).text, canonicalSummaryCommand,
		"Discord control must inject the exact raw prompt-template command without arguments");
	assert.deepEqual(await FakeGateway.instances[0].executePresentationControl({ ...discordRequest, requestId: "manager-presentation-busy" }), {
		ok: false, message: "Refresh & Reconcile is already running; retry when the manager is idle.",
	}, "a second Discord control must fail while the canonical turn is active");
	assert.deepEqual(await managerSummarySession.emit("input", { text: canonicalSummaryCommand, source: "extension" }),
		{ action: "continue" }, "the reserved Discord injection must continue into prompt-template expansion");
	const discordSummary = "Discord-origin complete summary";
	await writeFile(join(managerFixture, "presentation.json"), `${JSON.stringify(managerPresentation("c".repeat(64), discordSummary))}\n`);
	await writeFile(join(managerFixture, "data", "tasks", "discord-command-active.md"), "changed during Discord command\n");
	await waitFor(() => FakeGateway.channelMessages.get(managerSummaryMapping.channelId)?.at(-1)?.text === discordSummary,
		"Discord-origin canonical task change must automatically edit the manager summary");
	await settleManagerCommand();
	await waitFor(() => FakeGateway.channelMessages.get(managerSummaryMapping.channelId)?.at(-1)?.text === discordSummary,
		"Discord-origin summary publication after correlated settlement");
	await assert.rejects(() => readFile(join(managerFixture, "forbidden-direct-command.txt"), "utf8"), { code: "ENOENT" });
	await assert.rejects(() => readFile(join(managerFixture, "reconcile-count.txt"), "utf8"), { code: "ENOENT" });

	assert.deepEqual(await managerSummarySession.emit("input", { text: canonicalSummaryCommand, source: "interactive" }),
		{ action: "continue" });
	await writeFile(join(managerFixture, "presentation.json"), `${JSON.stringify(managerPresentation("d".repeat(64), "must not publish"))}\n`);
	await settleManagerCommand("error");
	await new Promise((resolveWait) => setTimeout(resolveWait, 150));
	assert.equal(FakeGateway.channelMessages.get(managerSummaryMapping.channelId).at(-1).text, discordSummary,
		"failed command settlement must retain the last-good Discord summary");
	assert.match(managerSummarySession.notifications.at(-1)[0], /retry manually/);

	assert.deepEqual(await managerSummarySession.emit("input", { text: canonicalSummaryCommand, source: "interactive" }),
		{ action: "continue" });
	await writeFile(join(managerFixture, "presentation.json"), '{"ok":true,"command":"summary-render"}\n');
	await settleManagerCommand();
	await new Promise((resolveWait) => setTimeout(resolveWait, 150));
	assert.equal(FakeGateway.channelMessages.get(managerSummaryMapping.channelId).at(-1).text, discordSummary,
		"render failure must retain the last-good Discord summary");
	assert.match(managerSummarySession.notifications.at(-1)[0], /retry manually/);
	managerSummarySession.setInjectionError(true);
	assert.equal((await FakeGateway.instances[0].executePresentationControl({ ...discordRequest,
		requestId: "manager-presentation-rejected", customId: `m:${"c".repeat(64)}:github-refresh-reconcile` })).ok, false,
	"failed Pi command injection must be surfaced without changing the summary");
	managerSummarySession.setInjectionError(false);
	assert.equal(FakeGateway.channelMessages.get(managerSummaryMapping.channelId).at(-1).text, discordSummary);
	assert.equal(FakeGateway.channelMessages.get(managerSummaryMapping.channelId).filter((message) => message.botOwned).length, 1,
		"all command outcomes must retain one manager summary message");
	managerStatus = {
		...managerStatus,
		summary: { tasks: 1, pending_events: 0, ready_tasks: 0, orphan_events: 0 },
		tasks: [{ ...managerStatus.tasks[0], status: "active", current_action: "implement", current_run: "implement-2" }],
	};
	await writeFile(join(managerFixture, "status.json"), `${JSON.stringify(managerStatus)}\n`);
	await writeFile(join(managerFixture, "presentation.json"), `${JSON.stringify(managerPresentation("e".repeat(64), "second opaque payload"))}\n`);
	await writeFile(join(managerFixture, "data", "tasks", "changed.md"), "changed\n");
	await waitFor(() => FakeGateway.channelMessages.get(managerSummaryMapping.channelId)?.at(-1)?.text === "second opaque payload",
		"later canonical task changes must automatically refresh the manager summary");
	assert.equal(FakeGateway.channelMessages.get(managerSummaryMapping.channelId).at(-1).id, managerSummaryMessageId,
		"later automatic refresh must retain the existing manager summary message");
	assert.equal(FakeGateway.channelMessages.get(managerSummaryMapping.channelId).filter((message) => message.botOwned).length, 1,
		"later automatic refresh must not post duplicate manager summaries");
	await waitFor(() => FakeGateway.instances[0].managerAutocomplete(managerSummaryMapping.threadId, "discord").length === 1,
		"manager catalogue registration and live IPC refresh");
	assert.deepEqual(FakeGateway.instances[0].managerAutocomplete(managerSummaryMapping.threadId, "discord"), [{
		name: "Discord @everyone summary — pi-extensions (@discord-manager-task-summary)",
		value: "discord-manager-task-summary",
	}]);
	await writeFile(join(managerFixture, "data", "PROJECTS.md"), [
		"---", "projects:", "  pi-extensions:", "    repository: /tmp/pi-extensions", "  wordpress:",
		"    repository: /tmp/wordpress", "---", "",
	].join("\n"));
	await waitFor(() => FakeGateway.instances[0].managerAutocomplete(managerSummaryMapping.threadId, "wordpress", "target").some((choice) =>
		choice.value === "project:wordpress"), "extension project-registry ask-target refresh without polling");
	const managerMessagesBeforeControls = managerSummarySession.userMessages.length;
	const managerAppendCallsBeforeControls = managerSummarySession.appendCalls();
	assert.deepEqual(await FakeGateway.instances[0].executeManagerControl({
		requestId: "manager-end-to-end-handoff",
		channelId: managerSummaryMapping.threadId,
		action: "handoff",
		taskId: "discord-manager-task-summary",
	}), { ok: true, message: "Direct handoff started for @discord-manager-task-summary." },
	"mapped manager controls must traverse Discord, relay IPC, verified client, runtime validation, and canonical manager CLI");
	assert.equal(managerSummarySession.appendCalls(), managerAppendCallsBeforeControls + 1,
		"a settled manager command must append exactly one result entry and no pending entry");
	const managerHistory = () => managerSummarySession.entries.filter((entry) => entry.customType === MANAGER_CONTROL_RESULT_ENTRY);
	assert.deepEqual(managerHistory().at(-1), {
		type: "custom",
		customType: MANAGER_CONTROL_RESULT_ENTRY,
		data: {
			action: "handoff",
			taskId: "discord-manager-task-summary",
			ok: true,
			message: "Direct handoff started for @discord-manager-task-summary.",
		},
	}, "successful manager results must persist bounded command and final result data in the Pi session");
	const managerResultRenderer = managerSummarySession.entryRenderers.get(MANAGER_CONTROL_RESULT_ENTRY);
	assert.equal(typeof managerResultRenderer, "function", "manager result history must register a TUI entry renderer");
	const identityTheme = { fg: (_color, text) => text };
	assert.equal(managerResultRenderer(managerHistory().at(-1), {}, identityTheme).render(200)[0].trimEnd(),
		"✓ /m handoff @discord-manager-task-summary — Direct handoff started for @discord-manager-task-summary.",
		"manager result renderer must compactly show the command and successful final result");
	assert.equal(managerResultRenderer({ data: { action: "hostile", message: 42 } }, {}, identityTheme).render(80)[0].trimEnd(),
		"⚠ /m result unavailable", "malformed persisted history must use the renamed fallback without failing TUI rendering");
	assert.deepEqual(await FakeGateway.instances[0].executeManagerControl({
		requestId: "manager-end-to-end-reconcile-all",
		channelId: managerSummaryMapping.threadId,
		action: "reconcile-pr",
	}), { ok: true, message: "Reconciled 0 tasks: 0 archived, 0 open, 0 terminal, 0 not found, 0 failed." });
	assert.deepEqual(managerHistory().at(-1).data, {
		action: "reconcile-pr",
		ok: true,
		message: "Reconciled 0 tasks: 0 archived, 0 open, 0 terminal, 0 not found, 0 failed.",
	}, "taskless manager results must omit taskId while preserving the final result");
	await writeFile(join(managerFixture, "bin", "manager.mjs"), [
		'import { readFileSync } from "node:fs";',
		'import { join } from "node:path";',
		'if (process.argv[2] === "status") console.log(readFileSync(join(process.cwd(), "status.json"), "utf8"));',
		'else { console.error("injected canonical failure"); process.exitCode = 1; }',
		"",
	].join("\n"));
	assert.deepEqual(await FakeGateway.instances[0].executeManagerControl({
		requestId: "manager-end-to-end-failure",
		channelId: managerSummaryMapping.threadId,
		action: "takeback",
		taskId: "discord-manager-task-summary",
	}), { ok: false, message: "injected canonical failure" });
	assert.deepEqual(managerHistory().at(-1).data, {
		action: "takeback",
		taskId: "discord-manager-task-summary",
		ok: false,
		message: "injected canonical failure",
	}, "failed canonical manager results must persist only their settled failure");
	assert.equal(managerResultRenderer(managerHistory().at(-1), {}, identityTheme).render(200)[0].trimEnd(),
		"✗ /m takeback @discord-manager-task-summary — injected canonical failure",
		"manager result renderer must show final failures");
	await writeFile(join(managerFixture, "bin", "manager.mjs"), managerFixtureScript);
	const historyCountBeforeAuditFailure = managerHistory().length;
	const appendCallsBeforeAuditFailure = managerSummarySession.appendCalls();
	managerSummarySession.setAppendError(true);
	const resultDespiteAuditFailure = await FakeGateway.instances[0].executeManagerControl({
		requestId: "manager-end-to-end-audit-failure",
		channelId: managerSummaryMapping.threadId,
		action: "archive",
		taskId: "discord-manager-task-summary",
	});
	managerSummarySession.setAppendError(false);
	assert.deepEqual(resultDespiteAuditFailure, { ok: true, message: "@discord-manager-task-summary archived without merging." },
		"custom-entry append failure must not alter the canonical Discord result");
	assert.equal(managerSummarySession.appendCalls(), appendCallsBeforeAuditFailure + 1,
		"failed history persistence must be attempted once without retries or pending entries");
	assert.equal(managerHistory().length, historyCountBeforeAuditFailure, "failed history persistence must not create a partial entry");
	assert.equal(managerSummarySession.userMessages.length, managerMessagesBeforeControls,
		"non-ask manager controls and their history must not trigger or queue model work");
	const historyCountBeforeAsk = managerHistory().length;
	assert.ok(FakeGateway.instances[0].managerAutocomplete(managerSummaryMapping.threadId, "pi", "target").some((choice) =>
		choice.value === "project:pi-extensions"), "ask targets must include every configured project");
	assert.deepEqual(await FakeGateway.instances[0].executeManagerControl({
		requestId: "manager-end-to-end-project-ask",
		channelId: managerSummaryMapping.threadId,
		action: "ask",
		target: "project:pi-extensions",
		request: "Inspect the extension",
	}), { ok: true, message: "Request sent to project pi-extensions." });
	assert.deepEqual(managerSummarySession.userMessages.at(-1), {
		text: "Project: pi-extensions\n\nInspect the extension",
		options: undefined,
	}, "idle manager asks must send immediately with exact project context");
	managerSummarySession.setIdle(false);
	assert.deepEqual(await FakeGateway.instances[0].executeManagerControl({
		requestId: "manager-end-to-end-task-ask",
		channelId: managerSummaryMapping.threadId,
		action: "ask",
		target: "task:discord-manager-task-summary",
		request: "Inspect the active task",
	}), { ok: true, message: "Request sent to task discord-manager-task-summary." });
	assert.deepEqual(managerSummarySession.userMessages.at(-1), {
		text: "Project: pi-extensions\nTask: discord-manager-task-summary\n\nInspect the active task",
		options: { deliverAs: "followUp" },
	}, "busy manager asks must queue as Pi follow-ups with canonical task project metadata");
	assert.equal(managerHistory().length, historyCountBeforeAsk,
		"manager ask must rely on its user-message history instead of appending a duplicate custom entry");
	managerSummarySession.setIdle(true);
	const rendererFailureHarness = createExtensionHarness(extension, {
		cwd: "/work/renderer-failure",
		sessionId: "renderer-failure-session",
		sessionName: undefined,
		entryRendererError: true,
	});
	assert.ok(rendererFailureHarness.commands.has("discord"),
		"entry-renderer registration failure must not prevent the Discord extension from loading");

	const namingState = new DiscordStateStore(stateFile);
	const taskNamedMapping = await namingState.getSession(taskNamedSessionId);
	const taskNamedSiblingMapping = await namingState.getSession(taskNamedSiblingSessionId);
	const taskFallbackMapping = await namingState.getSession(taskFallbackSessionId);
	const namedThreadName = sessionThreadName(taskNamedSessionId, "Named Pi session");
	const namedSiblingThreadName = sessionThreadName(taskNamedSiblingSessionId, "Named Pi session");
	assert.equal(namedThreadName, namedSiblingThreadName, "duplicate session names must retain duplicate Discord display names");
	assert.ok(FakeGateway.instances[0].threadRequests.filter((request) => request.name === namedThreadName).length >= 2,
		"each named Pi session must create its separate thread with the exact shared display name");
	assert.equal(taskNamedMapping.channelId, taskNamedSiblingMapping.channelId, "named sessions under one task must share its project channel");
	assert.notEqual(taskNamedMapping.threadId, taskNamedSiblingMapping.threadId, "named sessions under one task must retain separate threads");
	assert.ok(FakeGateway.instances[0].threadRequests.some(
		(request) => request.name === sessionThreadName(taskFallbackSessionId, "Implement task-title thread naming"),
	), "TASK.md must name a new thread when the Pi session has no display name");
	assert.equal(taskFallbackMapping.channelId, taskNamedMapping.channelId, "TASK.md fallback must preserve worktree project routing");
	assert.ok(FakeGateway.instances[0].threadRequests.some(
		(request) => request.name === sessionThreadName(metadataAbsentSessionId),
	), "absent Pi and task metadata must use the generic session fallback");

	const threadRequestCountBeforeRename = FakeGateway.instances[0].threadRequests.length;
	taskNamed.setSessionName("Renamed Pi session");
	await writeFile(join(linkedWorktree, "TASK.md"), "# A changed task title must not rename an existing thread\n");
	await taskNamed.runCommand("discord", "reconnect");
	assert.deepEqual(
		FakeGateway.instances[0].threadRequests.slice(threadRequestCountBeforeRename),
		[{ channelId: taskNamedMapping.channelId, mappedThreadId: taskNamedMapping.threadId, name: sessionThreadName(taskNamedSessionId, "Renamed Pi session") }],
		"reconnecting must resolve current naming metadata while targeting the existing mapping",
	);
	assert.equal(
		(await new DiscordStateStore(stateFile).getSession(taskNamedSessionId)).threadId,
		taskNamedMapping.threadId,
		"changed naming metadata must not rename an existing session thread",
	);
	assert.equal(FakeGateway.instances.length, 1, "concurrent Pi clients must share one Discord gateway");
	assert.equal(FakeGateway.activeConnections, 1);
	assert.equal(FakeGateway.maximumActiveConnections, 1);
	if (process.platform !== "win32") {
		assert.equal((await stat(paths.directory)).mode & 0o777, 0o700, "relay directory must be private");
		assert.equal((await stat(paths.authToken)).mode & 0o777, 0o600, "relay token must be private");
		assert.equal((await stat(paths.socket)).mode & 0o777, 0o600, "relay socket must be private");
	}
	assert.deepEqual([...first.commands.keys()], ["discord"]);
	assert.ok(first.events.has("agent_settled"));
	assert.ok(first.events.has("agent_end"));
	assert.ok(first.events.has("tool_execution_start"));

	assert.deepEqual(first.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.discord, "💬"]);
	assert.deepEqual(second.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.discord, "💬"]);
	assert.deepEqual(taskNamed.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.discord, "💬"]);
	assert.deepEqual(taskNamedSibling.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.discord, "💬"]);
	assert.deepEqual(taskFallback.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.discord, "💬"]);
	assert.deepEqual(metadataAbsent.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.discord, "💬"]);
	assert.ok(FakeGateway.instances[0].threadRequests.some(
		(request) => request.name === sessionThreadName("session-11111111", "First session"),
	), "absent task metadata must preserve the Pi session name");
	const firstMapping = await new DiscordStateStore(stateFile).getSession("session-11111111");
	const secondMapping = await new DiscordStateStore(stateFile).getSession("session-22222222");
	const { channelId: firstChannel, threadId: firstThread } = firstMapping;
	const { channelId: secondChannel, threadId: secondThread } = secondMapping;
	assert.equal(firstChannel, secondChannel, "sessions in one cwd must share its durable project channel");
	assert.notEqual(firstThread, secondThread);
	await first.runCommand("discord", "status");
	assert.match(first.notifications.at(-1)[0], new RegExp(`Project channel: ${firstChannel}\\nSession thread: ${firstThread}$`), "command status must retain detailed diagnostics");
	assert.ok(first.commands.get("discord").getArgumentCompletions("r").some(({ value }) => value === "restart"));
	let gateway = FakeGateway.instances[0];
	const gatewayCountBeforeClientReconnect = FakeGateway.instances.length;
	await first.runCommand("discord", "reconnect");
	assert.equal(FakeGateway.instances.length, gatewayCountBeforeClientReconnect, "/discord reconnect must not replace the shared relay");
	injectedRestartFailure = new Error("Discord relay ownership record is malformed");
	await first.runCommand("discord", "restart");
	assert.deepEqual(first.notifications.at(-1), ["Discord relay restart failed: Discord relay ownership record is malformed", "error"]);
	assert.equal(gateway.connected, true, "failed restart verification must leave the relay untouched");
	injectedRestartFailure = undefined;
	second.setIdle(false);
	const routedSecond = second.nextUserMessage();
	await gateway.emit({ id: "10", channelId: secondThread, content: "route to second", authorBot: false });
	const routedSecondMessage = await routedSecond;
	assert.equal(stripInboundMarker(routedSecondMessage.text), "route to second");
	assert.equal(inboundMessageId(routedSecondMessage.text), "10");
	assert.deepEqual(routedSecondMessage.options, { deliverAs: "followUp" });
	const contextResult = await second.emit("context", {
		messages: [{ role: "user", content: [{ type: "text", text: routedSecondMessage.text }] }],
	});
	assert.equal(contextResult.messages[0].content[0].text, "route to second", "inbound receipt marker must not reach the model");
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: routedSecondMessage.text }] } });
	await waitFor(() => second.entries.some((entry) => entry.data?.messageId === "10"), "durable Pi acceptance receipt");
	assert.equal(first.userMessages.length, 0, "Discord input must route only to its Pi session");

	const integrationImageFetchAttempts = new Map();
	globalThis.fetch = async (url, init) => {
		assert.equal(new URL(url).hostname, "cdn.discordapp.com", "detached relay must fetch only validated Discord CDN URLs");
		assert.equal(init?.redirect, "manual");
		const key = String(url);
		integrationImageFetchAttempts.set(key, (integrationImageFetchAttempts.get(key) ?? 0) + 1);
		if (key.includes("/10003/")) {
			return new Response(Buffer.from("not-png!"), {
				status: 200,
				headers: { "content-type": "image/png", "content-length": "8" },
			});
		}
		return new Response(pngBytes, {
			status: 200,
			headers: { "content-type": "image/png", "content-length": String(pngBytes.length) },
		});
	};
	const captionImageUrl = "https://cdn.discordapp.com/attachments/12345/10001/caption.png?ex=signed";
	second.setIdle(true);
	const captionImageDelivery = second.nextUserMessage();
	await gateway.emit({
		id: "10001",
		channelId: secondThread,
		content: "inspect this caption",
		authorBot: false,
		attachments: [{ id: "10001", url: captionImageUrl, contentType: "image/png", size: pngBytes.length }],
	});
	const captionImageMessage = await captionImageDelivery;
	assert.equal(captionImageMessage.options, undefined, "idle image prompts must route immediately");
	assert.equal(Array.isArray(captionImageMessage.text), true);
	assert.match(stripInboundMarker(captionImageMessage.text[0].text), /^inspect this caption\n\n\[Discord image 1\/1: local_path="[^"]+"; mime=image\/png; bytes=8\]$/);
	assert.equal(inboundMessageId(captionImageMessage.text[0].text), "10001");
	assert.deepEqual(captionImageMessage.text[1], { type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" });
	const captionPending = (await new DiscordStateStore(stateFile).getSession("session-22222222")).pendingMessages
		.find((message) => message.id === "10001");
	assert.equal(captionPending.images.length, 1);
	assert.deepEqual(await readFile(captionPending.images[0].localPath), pngBytes, "relay must retain image files until Pi acceptance");
	const captionContext = await second.emit("context", { messages: [{ role: "user", content: captionImageMessage.text }] });
	assert.equal(captionContext.messages[0].content[0].text, stripInboundMarker(captionImageMessage.text[0].text));
	assert.deepEqual(captionContext.messages[0].content[1], captionImageMessage.text[1]);
	await second.emit("message_end", { message: { role: "user", content: captionImageMessage.text } });
	await waitFor(async () => !(await new DiscordStateStore(stateFile).getSession("session-22222222")).pendingMessages
		.some((message) => message.id === "10001"), "caption image acknowledgement");
	assert.deepEqual(await readFile(captionPending.images[0].localPath), pngBytes, "accepted image path must remain readable during the agent run");
	await second.emit("before_agent_start", { prompt: captionImageMessage.text[0].text });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: captionImageMessage.text } });
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await second.emit("agent_settled", {});
	await assert.rejects(() => readFile(captionPending.images[0].localPath), { code: "ENOENT" });

	const imageOnlyUrl = "https://cdn.discordapp.com/attachments/12345/10002/image-only.png?ex=signed";
	second.setIdle(false);
	const imageOnlyDelivery = second.nextUserMessage();
	await gateway.emit({
		id: "10002",
		channelId: secondThread,
		content: "",
		authorBot: false,
		attachments: [{ id: "10002", url: imageOnlyUrl, contentType: "image/png", size: pngBytes.length }],
	});
	const imageOnlyMessage = await imageOnlyDelivery;
	assert.deepEqual(imageOnlyMessage.options, { deliverAs: "followUp" }, "busy image prompts must retain follow-up routing");
	assert.match(stripInboundMarker(imageOnlyMessage.text[0].text), /^\[Discord image 1\/1: local_path="[^"]+"; mime=image\/png; bytes=8\]$/,
		"image-only prompts must contain only the explicit local path reference");
	assert.equal(inboundMessageId(imageOnlyMessage.text[0].text), "10002");
	assert.deepEqual(imageOnlyMessage.text[1], { type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" });
	await second.emit("message_end", { message: { role: "user", content: imageOnlyMessage.text } });
	await second.emit("before_agent_start", { prompt: imageOnlyMessage.text[0].text });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: imageOnlyMessage.text } });
	await waitFor(() => FakeGateway.lifecycleReactions.get("10002") === "🤔", "image-only lifecycle association");
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await second.emit("agent_settled", {});
	await waitFor(() => FakeGateway.lifecycleReactions.get("10002") === "✅", "image-only settled lifecycle");
	assert.equal(integrationImageFetchAttempts.get(captionImageUrl), 1);
	assert.equal(integrationImageFetchAttempts.get(imageOnlyUrl), 1);

	const rejectedImageUrl = "https://cdn.discordapp.com/attachments/12345/10003/rejected.png?ex=signed";
	second.setIdle(true);
	const rejectedImageDelivery = second.nextUserMessage();
	await gateway.emit({
		id: "10003",
		channelId: secondThread,
		content: "",
		authorBot: false,
		attachments: [{ id: "10003", url: rejectedImageUrl, contentType: "image/png", size: 8 }],
	});
	const rejectedImageMessage = await rejectedImageDelivery;
	assert.equal(typeof rejectedImageMessage.text, "string");
	assert.equal(inboundMessageId(rejectedImageMessage.text), "10003");
	assert.match(stripInboundMarker(rejectedImageMessage.text), /Discord attachment warning: images were not injected: file signature does not match MIME type/);
	await second.emit("message_end", { message: { role: "user", content: rejectedImageMessage.text } });
	await second.emit("before_agent_start", { prompt: rejectedImageMessage.text });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: rejectedImageMessage.text } });
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await second.emit("agent_settled", {});
	await waitFor(() => FakeGateway.lifecycleReactions.get("10003") === "✅", "permanently rejected image lifecycle");
	const afterRejectedDelivery = second.nextUserMessage();
	await gateway.emit({ id: "10004", channelId: secondThread, content: "after rejected image", authorBot: false });
	const afterRejectedMessage = await afterRejectedDelivery;
	assert.equal(stripInboundMarker(afterRejectedMessage.text), "after rejected image", "permanent image rejection must not poison later delivery");
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: afterRejectedMessage.text }] } });

	const unsupportedDelivery = second.nextUserMessage();
	await gateway.emit({
		id: "10005",
		channelId: secondThread,
		content: "unsupported attachment",
		authorBot: false,
		attachments: [{ id: "10005", url: "https://cdn.discordapp.com/attachments/12345/10005/vector.svg", contentType: "image/svg+xml", size: 100 }],
	});
	const unsupportedMessage = await unsupportedDelivery;
	assert.match(stripInboundMarker(unsupportedMessage.text), /attachment MIME type is missing or unsupported/);
	assert.equal(integrationImageFetchAttempts.has("https://cdn.discordapp.com/attachments/12345/10005/vector.svg"), false);
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: unsupportedMessage.text }] } });

	const textOnly = createExtensionHarness(extension, {
		cwd: "/work/text-only-image",
		sessionId: "session-text-only-image",
		sessionName: "Text-only image",
		models: [{ provider: "text", id: "text-only", name: "Text Only", input: ["text"] }],
	});
	await textOnly.emit("session_start", { reason: "startup" });
	const textOnlyThread = (await new DiscordStateStore(stateFile).getSession("session-text-only-image")).threadId;
	textOnly.setIdle(false);
	const textOnlyDelivery = textOnly.nextUserMessage();
	const textOnlyUrl = "https://cdn.discordapp.com/attachments/12345/20001/text-only.png?ex=signed";
	await gateway.emit({
		id: "20001",
		channelId: textOnlyThread,
		content: "inspect without vision",
		authorBot: false,
		attachments: [{ id: "20001", url: textOnlyUrl, contentType: "image/png", size: pngBytes.length }],
	});
	const textOnlyMessage = await textOnlyDelivery;
	assert.equal(typeof textOnlyMessage.text, "string", "text-only models must receive no ImageContent array");
	assert.deepEqual(textOnlyMessage.options, { deliverAs: "followUp" });
	assert.match(stripInboundMarker(textOnlyMessage.text), /^inspect without vision\n\n\[Discord image 1\/1: local_path="[^"]+"; mime=image\/png; bytes=8\]\n\[Discord image warning: the current Pi model does not support image input; local files were not natively injected\.\]$/);
	const textOnlyPending = (await new DiscordStateStore(stateFile).getSession("session-text-only-image")).pendingMessages[0];
	const textOnlyPath = textOnlyPending.images[0].localPath;
	await textOnly.emit("message_end", { message: { role: "user", content: textOnlyMessage.text } });
	await waitFor(async () => (await new DiscordStateStore(stateFile).getSession("session-text-only-image")).pendingMessages.length === 0,
		"text-only image acknowledgement");
	assert.deepEqual(await readFile(textOnlyPath), pngBytes, "text-only local path must remain valid during the run");
	await textOnly.emit("before_agent_start", { prompt: textOnlyMessage.text });
	await textOnly.emit("agent_start", {});
	await textOnly.emit("message_start", { message: { role: "user", content: textOnlyMessage.text } });
	await textOnly.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await textOnly.emit("agent_settled", {});
	await assert.rejects(() => readFile(textOnlyPath), { code: "ENOENT" });
	await textOnly.emit("session_shutdown", { reason: "quit" });

	const retainedCrash = createExtensionHarness(extension, {
		cwd: "/work/retained-crash",
		sessionId: "session-retained-crash",
		sessionName: "Retained crash",
	});
	await retainedCrash.emit("session_start", { reason: "startup" });
	const retainedCrashThread = (await new DiscordStateStore(stateFile).getSession("session-retained-crash")).threadId;
	const retainedCrashDelivery = retainedCrash.nextUserMessage();
	await gateway.emit({
		id: "20002",
		channelId: retainedCrashThread,
		content: "retain across crash",
		authorBot: false,
		attachments: [{
			id: "20002",
			url: "https://cdn.discordapp.com/attachments/12345/20002/crash.png?ex=signed",
			contentType: "image/png",
			size: pngBytes.length,
		}],
	});
	const retainedCrashMessage = await retainedCrashDelivery;
	const retainedCrashPath = (await new DiscordStateStore(stateFile).getSession("session-retained-crash")).pendingMessages[0].images[0].localPath;
	await retainedCrash.emit("message_end", { message: { role: "user", content: retainedCrashMessage.text } });
	await waitFor(async () => (await new DiscordStateStore(stateFile).getSession("session-retained-crash")).retainedImages.length === 1,
		"crash-retained acknowledgement");
	await retainedCrash.emit("session_shutdown", { reason: "quit" });
	assert.deepEqual(await readFile(retainedCrashPath), pngBytes);
	const retainedResume = createExtensionHarness(extension, {
		cwd: "/work/retained-crash",
		sessionId: "session-retained-crash",
		sessionName: "Retained crash",
		entries: retainedCrash.entries,
	});
	await retainedResume.emit("session_start", { reason: "resume" });
	await waitFor(async () => {
		const session = await new DiscordStateStore(stateFile).getSession("session-retained-crash");
		return session.retainedImages.length === 0;
	}, "restart cleanup of acknowledged image files");
	await assert.rejects(() => readFile(retainedCrashPath), { code: "ENOENT" });
	assert.equal(retainedResume.userMessages.length, 0);
	await retainedResume.emit("session_shutdown", { reason: "quit" });

	assert.deepEqual(gateway.modelAutocomplete(firstThread, "claude"), [{
		name: "Claude Test (anthropic/claude-test)",
		value: "anthropic/claude-test",
	}], "model autocomplete must use the live relay registration cache");
	const controlStatus = await gateway.executeControl({ requestId: "discord-status", channelId: firstThread, action: { type: "status" } });
	assert.equal(controlStatus.ok, true);
	assert.match(controlStatus.message, /Pi session: idle\nModel: openai\/gpt-test\nThinking: medium\nQueued messages: no/);
	first.setIdle(false);
	assert.deepEqual(await gateway.executeControl({
		requestId: "busy-model",
		channelId: firstThread,
		action: { type: "model", value: "anthropic/claude-test" },
	}), { ok: false, message: "Model cannot change while Pi is busy." });
	assert.deepEqual(await gateway.executeControl({
		requestId: "busy-thinking",
		channelId: firstThread,
		action: { type: "thinking", level: "high" },
	}), { ok: false, message: "Thinking level cannot change while Pi is busy." });
	first.setIdle(true);
	assert.equal((await gateway.executeControl({
		requestId: "set-model",
		channelId: firstThread,
		action: { type: "model", value: "anthropic/claude-test" },
	})).ok, true);
	assert.equal(first.currentModel().id, "claude-test", "native Pi setModel must execute instead of forwarding slash-looking text");
	assert.equal((await gateway.executeControl({
		requestId: "set-thinking",
		channelId: firstThread,
		action: { type: "thinking", level: "high" },
	})).ok, true);
	assert.equal(first.thinkingLevel(), "high", "native Pi setThinkingLevel must execute and retain persistence semantics");
	assert.deepEqual(await gateway.executeControl({
		requestId: "stale-model",
		channelId: firstThread,
		action: { type: "model", value: "provider/missing" },
	}), { ok: false, message: "Select a model from this session's current autocomplete catalogue." });
	first.setIdle(false);
	first.setPendingMessages(true);
	assert.equal((await gateway.executeControl({
		requestId: "steer-control",
		channelId: firstThread,
		action: { type: "steer", text: "steer natively" },
	})).ok, true);
	assert.equal((await gateway.executeControl({
		requestId: "followup-control",
		channelId: firstThread,
		action: { type: "followup", text: "follow up natively" },
	})).ok, true);
	assert.deepEqual(first.userMessages.slice(-2), [
		{ text: "steer natively", options: { deliverAs: "steer" } },
		{ text: "follow up natively", options: { deliverAs: "followUp" } },
	]);
	const abortResult = await gateway.executeControl({ requestId: "abort-control", channelId: firstThread, action: { type: "abort" } });
	assert.deepEqual(abortResult, { ok: true, message: "Abort requested; queued messages were not discarded." });
	assert.equal(first.abortRequests(), 1, "abort must use Pi's queue-preserving context API");
	assert.equal(first.userMessages.length, 2, "abort must not consume or re-forward queued controls");
	assert.match((await gateway.executeControl({ requestId: "post-abort-status", channelId: firstThread, action: { type: "status" } })).message,
		/Queued messages: yes$/, "abort control must leave Pi's queued-message state intact");
	first.setIdle(true);
	assert.deepEqual(await gateway.executeControl({ requestId: "idle-abort", channelId: firstThread, action: { type: "abort" } }), {
		ok: false,
		message: "Pi is idle; there is no active turn to abort.",
	}, "idle abort must not falsely claim confirmation");
	const deliveriesBeforeIgnoredMessages = second.userMessages.length;
	await gateway.emit({ id: "10", channelId: secondThread, content: "duplicate", authorBot: false });
	assert.equal(second.userMessages.length, deliveriesBeforeIgnoredMessages, "duplicate Discord IDs must not deliver twice");
	await gateway.emit({ id: "11", channelId: secondThread, content: "bot", authorBot: true });
	assert.equal(second.userMessages.length, deliveriesBeforeIgnoredMessages, "bot output must not loop back into Pi");

	await waitFor(() => FakeGateway.lifecycleReactions.get("10") === "👀", "accepted lifecycle reaction");
	await second.emit("before_agent_start", { prompt: routedSecondMessage.text });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: routedSecondMessage.text }] } });
	await waitFor(() => FakeGateway.lifecycleReactions.get("10") === "🤔", "thinking lifecycle reaction");
	await second.emit("tool_execution_start", { toolCallId: "tool-10", toolName: "read", args: {} });
	await second.emit("tool_execution_start", { toolCallId: "tool-10-duplicate", toolName: "read", args: {} });
	await waitFor(() => FakeGateway.lifecycleReactions.get("10") === "⚙️", "tool lifecycle reaction");
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	assert.equal(FakeGateway.lifecycleReactions.get("10"), "⚙️", "success must wait for agent_settled");
	await second.emit("agent_settled", {});
	await waitFor(() => FakeGateway.lifecycleReactions.get("10") === "✅", "settled lifecycle reaction");
	assert.deepEqual(reactionSequence("10"), ["👀", "🤔", "⚙️", "✅"], "duplicate lifecycle events must be idempotent and ordered");

	const toolFreeDelivery = second.nextUserMessage();
	await gateway.emit({ id: "12", channelId: secondThread, content: "tool free", authorBot: false });
	const toolFreeMessage = await toolFreeDelivery;
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: toolFreeMessage.text }] } });
	await second.emit("before_agent_start", { prompt: toolFreeMessage.text });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: toolFreeMessage.text }] } });
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await second.emit("agent_settled", {});
	await waitFor(() => FakeGateway.lifecycleReactions.get("12") === "✅", "tool-free settled reaction");
	assert.deepEqual(reactionSequence("12"), ["👀", "🤔", "✅"], "tool-free runs must skip the tool reaction");

	const queuedA = second.nextUserMessage();
	await gateway.emit({ id: "13", channelId: secondThread, content: "queued a", authorBot: false });
	const queuedAMessage = await queuedA;
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: queuedAMessage.text }] } });
	const queuedB = second.nextUserMessage();
	await gateway.emit({ id: "14", channelId: secondThread, content: "queued b", authorBot: false });
	const queuedBMessage = await queuedB;
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: queuedBMessage.text }] } });
	await second.emit("before_agent_start", { prompt: queuedAMessage.text });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: queuedAMessage.text }] } });
	await second.emit("tool_execution_start", { toolCallId: "tool-13", toolName: "read", args: {} });
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: queuedBMessage.text }] } });
	await second.emit("tool_execution_start", { toolCallId: "tool-14", toolName: "bash", args: {} });
	await waitFor(() => FakeGateway.lifecycleReactions.get("13") === "⚙️" && FakeGateway.lifecycleReactions.get("14") === "⚙️", "queued prompt tool reactions");
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: "unrelated local follow-up" }] } });
	const reactionsBeforeLocalTool = reactionSequence("14").length;
	await second.emit("tool_execution_start", { toolCallId: "local-tool", toolName: "read", args: {} });
	await new Promise((resolveWait) => setTimeout(resolveWait, 30));
	assert.equal(reactionSequence("14").length, reactionsBeforeLocalTool, "local follow-up tools must not react to a Discord prompt");
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await second.emit("agent_settled", {});
	await waitFor(() => FakeGateway.lifecycleReactions.get("13") === "✅" && FakeGateway.lifecycleReactions.get("14") === "✅", "queued prompt terminal reactions");
	assert.deepEqual(reactionSequence("13"), ["👀", "🤔", "⚙️", "✅"]);
	assert.deepEqual(reactionSequence("14"), ["👀", "🤔", "⚙️", "✅"]);

	const localReactionCount = FakeGateway.lifecycleReactionEvents.length;
	await second.emit("before_agent_start", { prompt: "ordinary local prompt" });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: "ordinary local prompt" }] } });
	await second.emit("tool_execution_start", { toolCallId: "local-only-tool", toolName: "read", args: {} });
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await second.emit("agent_settled", {});
	assert.equal(FakeGateway.lifecycleReactionEvents.length, localReactionCount, "local/TUI runs must never receive Discord reactions");

	await first.emit("input", { text: "local input", source: "interactive" });
	await waitFor(() => gateway.sent.some((message) => message.text === prefixedInteractive("local input")), "prefixed interactive user send");
	assert.equal(gateway.sent.at(-1).channelId, firstThread);
	assert.equal(gateway.sent.at(-1).text, prefixedInteractive("local input"));
	await first.emit("input", { text: "line one\nline two", source: "interactive" });
	await waitFor(() => gateway.sent.some((message) => message.text === prefixedInteractive("line one\nline two")), "prefixed multiline interactive send");
	await first.emit("input", { text: " \n ", source: "interactive" });
	await waitFor(() => gateway.sent.some((message) => message.text === prefixedInteractive(" \n ")), "prefixed whitespace-only interactive send");
	const sentBeforeEmptyInput = gateway.sent.length;
	await first.emit("input", { text: "", source: "interactive" });
	assert.equal(gateway.sent.length, sentBeforeEmptyInput, "empty interactive input must not emit a Discord message");
	const markdownInput = "**bold** _under_ `code` \\ slash";
	const markdownOutput = interactiveUserChunks(markdownInput)[0];
	await first.emit("input", { text: markdownInput, source: "interactive" });
	await waitFor(() => gateway.sent.some((message) => message.text === markdownOutput), "unchanged interactive Markdown send");
	const longStart = gateway.sent.length;
	await first.emit("input", { text: longInteractiveInput, source: "interactive" });
	await waitFor(() => gateway.sent.length >= longStart + longInteractiveChunks.length, "chunk-safe long interactive send");
	assert.deepEqual(gateway.sent.slice(longStart).map((message) => message.text), longInteractiveChunks);
	const rpcInput = " RPC **unchanged**\nline two ";
	await first.emit("input", { text: rpcInput, source: "rpc" });
	await waitFor(() => gateway.sent.some((message) => message.text === rpcInput), "byte-for-byte unchanged non-interactive input send");
	const sentBeforeLoopCheck = gateway.sent.length;
	await first.emit("input", { text: "Discord echo", source: "extension" });
	assert.equal(gateway.sent.length, sentBeforeLoopCheck, "Discord-origin extension input must not loop back to Discord");
	await first.emit("before_agent_start", { prompt: "local assistant mirror" });
	FakeGateway.failOnceTexts.add("final only");
	await first.emit("message_end", {
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final only" }] },
	});
	await waitFor(() => FakeGateway.sendAttempts.get("final only") === 1, "post-persistence Discord attempt");
	const persistedAssistant = (await new DiscordStateStore(stateFile).getSession("session-11111111")).outboundMessages
		.find((message) => message.chunks.map((chunk) => chunk.content).join("") === "final only");
	assert.ok(persistedAssistant, "eligible message_end must durably persist before settlement and Discord delivery");
	assert.match(persistedAssistant.id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,
		"message_end capture must assign a stable UUID before persistence");
	await waitFor(() => gateway.sent.some((message) => message.text === "final only"), "transient Discord retry");
	assert.equal(gateway.sent.filter((message) => message.text === "final only").length, 1);
	await first.emit("agent_settled", {});
	assert.equal(gateway.sent.filter((message) => message.text === "final only").length, 1,
		"agent settlement must not own or duplicate assistant persistence");

	async function runTerminalLifecycle(id, stopReason) {
		const delivery = second.nextUserMessage();
		await gateway.emit({ id, channelId: secondThread, content: `terminal ${id}`, authorBot: false });
		const message = await delivery;
		await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: message.text }] } });
		await waitFor(() => FakeGateway.lifecycleReactions.get(id) === "👀", `${id} accepted reaction`);
		await second.emit("before_agent_start", { prompt: message.text });
		await second.emit("agent_start", {});
		await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: message.text }] } });
		await second.emit("agent_end", { messages: [{ role: "assistant", stopReason }] });
		await second.emit("agent_settled", {});
		await waitFor(() => FakeGateway.lifecycleReactions.get(id) === "❌", `${id} failed reaction`);
	}
	await runTerminalLifecycle("16", "error");
	await runTerminalLifecycle("17", "aborted");
	assert.deepEqual(reactionSequence("16"), ["👀", "🤔", "❌"]);
	assert.deepEqual(reactionSequence("17"), ["👀", "🤔", "❌"]);

	FakeGateway.failLifecycleOnce.add("18:👀");
	const reactionFailureDelivery = second.nextUserMessage();
	await gateway.emit({ id: "18", channelId: secondThread, content: "reaction API failure", authorBot: false });
	const reactionFailureMessage = await reactionFailureDelivery;
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: reactionFailureMessage.text }] } });
	await second.emit("before_agent_start", { prompt: reactionFailureMessage.text });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: reactionFailureMessage.text }] } });
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await second.emit("agent_settled", {});
	await waitFor(() => FakeGateway.lifecycleReactions.get("18") === "✅", "progress after reaction API failure");
	assert.equal(stripInboundMarker(reactionFailureMessage.text), "reaction API failure", "reaction failure must not block Pi delivery");
	assert.deepEqual(reactionSequence("18"), ["🤔", "✅"], "later statuses must recover from a reaction API failure");

	const reconnectDelivery = second.nextUserMessage();
	await gateway.emit({ id: "19", channelId: secondThread, content: "survive reconnect", authorBot: false });
	const reconnectMessage = await reconnectDelivery;
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: reconnectMessage.text }] } });
	await second.emit("before_agent_start", { prompt: reconnectMessage.text });
	await second.emit("agent_start", {});
	await second.emit("message_start", { message: { role: "user", content: [{ type: "text", text: reconnectMessage.text }] } });
	await waitFor(() => FakeGateway.lifecycleReactions.get("19") === "🤔", "pre-reconnect thinking reaction");
	const preReconnectGateway = gateway;
	const gatewayCountBeforeReconnect = FakeGateway.instances.length;
	FakeGateway.lifecycleReactions.delete("19");
	await second.runCommand("discord", "restart");
	assert.equal(requestedRestartPid, process.pid);
	assert.equal(typeof requestedRestartNonce, "string", "current relays must provide authenticated lease evidence");
	assert.match(second.notifications.at(-1)[0], /^Discord relay restarted: PID \d+ replaced by PID \d+$/);
	await waitFor(() => FakeGateway.instances.length > gatewayCountBeforeReconnect, "command relay restart");
	gateway = FakeGateway.instances.at(-1);
	await waitFor(() => gateway.modelAutocomplete(firstThread, "").length > 0, "model catalogue republish after relay restart");
	assert.equal(gateway.modelAutocomplete(firstThread, "")[0].value, "anthropic/claude-test",
		"re-registration must refresh the relay catalogue with Pi's current model first");
	await waitFor(() => gateway.managerAutocomplete(managerSummaryMapping.threadId, "").length > 0,
		"manager task catalogue republish after relay restart");
	assert.equal(gateway.managerAutocomplete(managerSummaryMapping.threadId, "")[0].value, "discord-manager-task-summary",
		"manager reconnects must re-register the latest bounded task catalogue without polling");
	await waitFor(() => gateway.managerAutocomplete(managerSummaryMapping.threadId, "pi-extensions", "target").length > 0,
		"manager target catalogue republish after relay restart");
	assert.ok(gateway.managerAutocomplete(managerSummaryMapping.threadId, "pi-extensions", "target").some((choice) =>
		choice.value === "project:pi-extensions"), "reconnect must retain configured project ask targets");
	assert.deepEqual(await gateway.executeManagerControl({
		requestId: "manager-ask-after-relay-restart",
		channelId: managerSummaryMapping.threadId,
		action: "ask",
		target: "project:pi-extensions",
		request: "Verify reconnect routing",
	}), { ok: true, message: "Request sent to project pi-extensions." },
	"manager ask must execute in the same mapped thread after relay re-registration");
	assert.deepEqual(managerSummarySession.userMessages.at(-1), {
		text: "Project: pi-extensions\n\nVerify reconnect routing",
		options: undefined,
	}, "re-registered manager ask must deliver exact canonical project context");
	await waitFor(() => FakeGateway.lifecycleReactionEvents.some((event) =>
		event.messageId === "19" && event.reaction === "🤔" && event.gateway === gateway), "lifecycle replay after reconnect");
	assert.notEqual(gateway, preReconnectGateway);
	await second.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await second.emit("agent_settled", {});
	await waitFor(() => FakeGateway.lifecycleReactions.get("19") === "✅", "post-reconnect settled reaction");

	const failedInjection = createExtensionHarness(extension, {
		cwd: "/work/failing",
		sessionId: "session-44444444",
		sessionName: "Failing injection",
	});
	await failedInjection.emit("session_start", { reason: "startup" });
	const failedThread = (await new DiscordStateStore(stateFile).getSession("session-44444444")).threadId;
	failedInjection.setInjectionError(true);
	FakeGateway.hangLifecycleFor.add("15:👀");
	const failedImageUrl = "https://cdn.discordapp.com/attachments/12345/15000/retry.png?ex=signed";
	await gateway.emit({
		id: "15",
		channelId: failedThread,
		content: "must remain pending",
		authorBot: false,
		attachments: [{ id: "15000", url: failedImageUrl, contentType: "image/png", size: pngBytes.length }],
	});
	await waitFor(() => failedInjection.notifications.some(([text]) => text.includes("injected Pi acceptance failure")), "Pi injection failure");
	assert.deepEqual(failedInjection.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.discord, "⚠️"]);
	assert.equal(failedInjection.userMessages.length, 0);
	const shutdownStarted = Date.now();
	await failedInjection.emit("session_shutdown", { reason: "quit" });
	assert.ok(Date.now() - shutdownStarted < 2_500, "unconfirmed inbound must not block shutdown");
	const failedState = await new DiscordStateStore(stateFile).getSession("session-44444444");
	assert.equal(failedState.pendingMessages.length, 1);
	assert.equal(failedState.pendingMessages[0].id, "15");
	assert.match(failedState.pendingMessages[0].content, /^must remain pending\n\n\[Discord image 1\/1: local_path=/);
	assert.equal(failedState.pendingMessages[0].images.length, 1);
	const failedImagePath = failedState.pendingMessages[0].images[0].localPath;
	assert.deepEqual(await readFile(failedImagePath), pngBytes, "failed Pi injection must retain the relay-owned image");
	const imageRestartGatewayCount = FakeGateway.instances.length;
	await second.runCommand("discord", "restart");
	await waitFor(() => FakeGateway.instances.length > imageRestartGatewayCount, "image persistence relay restart");
	gateway = FakeGateway.instances.at(-1);
	assert.deepEqual(await readFile(failedImagePath), pngBytes, "relay restart orphan cleanup must retain queued images");
	const retriedInjection = createExtensionHarness(extension, {
		cwd: "/work/failing",
		sessionId: "session-44444444",
		sessionName: "Failing injection",
	});
	const retriedDelivery = retriedInjection.nextUserMessage();
	await retriedInjection.emit("session_start", { reason: "resume" });
	const retriedMessage = await retriedDelivery;
	assert.match(stripInboundMarker(retriedMessage.text[0].text), /^must remain pending\n\n\[Discord image 1\/1: local_path=/);
	assert.deepEqual(retriedMessage.text[1], { type: "image", data: pngBytes.toString("base64"), mimeType: "image/png" });
	assert.equal(integrationImageFetchAttempts.get(failedImageUrl), 1, "recovery must read the durable local file without redownloading");
	await retriedInjection.emit("message_end", { message: { role: "user", content: retriedMessage.text } });
	await waitFor(() => retriedInjection.entries.some((entry) => entry.data?.messageId === "15"), "retried Pi acceptance receipt");
	assert.deepEqual(await readFile(failedImagePath), pngBytes);
	await retriedInjection.emit("before_agent_start", { prompt: retriedMessage.text[0].text });
	await retriedInjection.emit("agent_start", {});
	await retriedInjection.emit("message_start", { message: { role: "user", content: retriedMessage.text } });
	await retriedInjection.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await retriedInjection.emit("agent_settled", {});
	await waitFor(async () => {
		try {
			await readFile(failedImagePath);
			return false;
		} catch (error) {
			return error.code === "ENOENT";
		}
	}, "acknowledged retry image cleanup");
	await retriedInjection.emit("session_shutdown", { reason: "quit" });

	const acceptedCleanupSeed = createExtensionHarness(extension, {
		cwd: "/work/accepted-cleanup",
		sessionId: "session-accepted-cleanup",
		sessionName: "Accepted cleanup",
	});
	await acceptedCleanupSeed.emit("session_start", { reason: "startup" });
	const acceptedCleanupThread = (await new DiscordStateStore(stateFile).getSession("session-accepted-cleanup")).threadId;
	await acceptedCleanupSeed.emit("session_shutdown", { reason: "quit" });
	const acceptedCleanupUrl = "https://cdn.discordapp.com/attachments/12345/16000/accepted.png?ex=signed";
	await gateway.emit({
		id: "16000",
		channelId: acceptedCleanupThread,
		content: "already persisted",
		authorBot: false,
		attachments: [{ id: "16000", url: acceptedCleanupUrl, contentType: "image/png", size: pngBytes.length }],
	});
	await waitFor(async () => (await new DiscordStateStore(stateFile).getSession("session-accepted-cleanup")).pendingMessages.length === 1,
		"accepted cleanup image persistence");
	const acceptedCleanupPath = (await new DiscordStateStore(stateFile).getSession("session-accepted-cleanup"))
		.pendingMessages[0].images[0].localPath;
	await writeFile(acceptedCleanupPath, Buffer.from("tampered!"));
	const acceptedCleanup = createExtensionHarness(extension, {
		cwd: "/work/accepted-cleanup",
		sessionId: "session-accepted-cleanup",
		sessionName: "Accepted cleanup",
		entries: [{ type: "custom", customType: "discord-bridge-inbound-accepted", data: { messageId: "16000" } }],
	});
	await acceptedCleanup.emit("session_start", { reason: "resume" });
	await waitFor(async () => (await new DiscordStateStore(stateFile).getSession("session-accepted-cleanup")).pendingMessages.length === 0,
		"accepted image acknowledgement cleanup");
	assert.equal(acceptedCleanup.userMessages.length, 0, "durably accepted messages must acknowledge without rereading untrusted files");
	await waitFor(async () => {
		try { await readFile(acceptedCleanupPath); return false; } catch (error) { return error.code === "ENOENT"; }
	}, "accepted image file release");
	await acceptedCleanup.emit("session_shutdown", { reason: "quit" });

	await first.emit("session_shutdown", { reason: "quit" });
	assert.equal(gateway.connected, true, "relay child must survive the Pi client that launched it");
	assert.equal(FakeGateway.activeConnections, 1);
	assert.equal(FakeGateway.maximumActiveConnections, 1);
	const failoverGateway = gateway;
	const afterFailover = second.nextUserMessage();
	await failoverGateway.emit({ id: "20", channelId: secondThread, content: "after failover", authorBot: false });
	const afterFailoverMessage = await afterFailover;
	assert.equal(stripInboundMarker(afterFailoverMessage.text), "after failover");
	await second.emit("message_end", { message: { role: "user", content: [{ type: "text", text: afterFailoverMessage.text }] } });
	await waitFor(() => second.entries.some((entry) => entry.data?.messageId === "20"), "post-failover Pi acceptance receipt");

	const inactive = createExtensionHarness(extension, {
		cwd: "/work/inactive",
		sessionId: "session-33333333",
		sessionName: "Inactive session",
	});
	await inactive.emit("session_start", { reason: "startup" });
	const inactiveThread = (await new DiscordStateStore(stateFile).getSession("session-33333333")).threadId;
	await inactive.emit("session_shutdown", { reason: "quit" });
	await failoverGateway.emit({ id: "30", channelId: inactiveThread, content: "queued while inactive", authorBot: false });
	assert.equal(inactive.userMessages.length, 0);
	const resumed = createExtensionHarness(extension, {
		cwd: "/work/inactive",
		sessionId: "session-33333333",
		sessionName: "Inactive session",
	});
	const queuedDelivery = resumed.nextUserMessage();
	await resumed.emit("session_start", { reason: "resume" });
	const queuedMessage = await queuedDelivery;
	assert.equal(stripInboundMarker(queuedMessage.text), "queued while inactive", "inactive-session messages must queue durably");
	await resumed.emit("message_end", { message: { role: "user", content: [{ type: "text", text: queuedMessage.text }] } });
	await waitFor(() => resumed.entries.some((entry) => entry.data?.messageId === "30"), "queued Pi acceptance receipt");
	await resumed.emit("session_shutdown", { reason: "quit" });

	await taskNamed.emit("session_shutdown", { reason: "quit" });
	await taskNamedSibling.emit("session_shutdown", { reason: "quit" });
	await taskFallback.emit("session_shutdown", { reason: "quit" });
	await metadataAbsent.emit("session_shutdown", { reason: "quit" });
	await managerSummarySession.emit("session_shutdown", { reason: "quit" });
	await second.emit("session_shutdown", { reason: "quit" });
	await waitFor(() => FakeGateway.activeConnections === 0, "zero-client relay child shutdown");
	FakeGateway.catchUpByThread.set(inactiveThread, [
		{ id: "30", channelId: inactiveThread, content: "old duplicate", authorBot: false },
		{ id: "40", channelId: inactiveThread, content: "missed while offline", authorBot: false },
	]);
	const restarted = createExtensionHarness(extension, {
		cwd: "/work/inactive",
		sessionId: "session-33333333",
		sessionName: "Inactive session",
	});
	const catchUpDelivery = restarted.nextUserMessage();
	await restarted.emit("session_start", { reason: "resume" });
	const catchUpMessage = await catchUpDelivery;
	assert.equal(stripInboundMarker(catchUpMessage.text), "missed while offline", "relay restart must fetch after the durable cursor");
	await restarted.emit("message_end", { message: { role: "user", content: [{ type: "text", text: catchUpMessage.text }] } });
	await waitFor(() => restarted.entries.some((entry) => entry.data?.messageId === "40"), "catch-up Pi acceptance receipt");
	assert.equal(restarted.userMessages.length, 1, "catch-up must not redeliver acknowledged Discord messages");
	await restarted.emit("session_shutdown", { reason: "quit" });
	await waitFor(() => FakeGateway.activeConnections === 0, "restarted zero-client relay shutdown");

	const persisted = JSON.parse(await readFile(stateFile, "utf8"));
	assert.equal(persisted.sessions["session-33333333"].pendingMessages.length, 0);
	assert.equal(persisted.sessions["session-33333333"].threadCursors[inactiveThread], "40");
	assert.equal(FakeGateway.maximumActiveConnections, 1);

	const rolloverDirectory = join(dataDir, "rollover-relay");
	const rolloverStateFile = join(rolloverDirectory, "state.json");
	const rolloverDependencies = (config) => ({
		paths: relayPaths(rolloverDirectory),
		loadConfig: async () => config,
		saveConfig: async () => {},
		createStateStore: () => new DiscordStateStore(rolloverStateFile),
		createTransport: () => new FakeGateway(),
		autoStartForCwd: () => true,
	});
	const rolloverA = createExtensionHarness(createDiscordExtension(rolloverDependencies(environmentFirst)), {
		cwd: "/rollover",
		sessionId: "rollover-a",
		sessionName: "Rollover A",
	});
	await rolloverA.emit("session_start", { reason: "startup" });
	const beforeRolloverCount = FakeGateway.instances.length;
	const rolloverB = createExtensionHarness(createDiscordExtension(rolloverDependencies(environmentSecond)), {
		cwd: "/rollover",
		sessionId: "rollover-b",
		sessionName: "Rollover B",
	});
	await rolloverB.emit("session_start", { reason: "startup" });
	await waitFor(
		() => FakeGateway.instances.length > beforeRolloverCount && FakeGateway.instances.at(-1).config?.token === "environment-two" &&
			rolloverA.statuses.at(-1)?.[1] === "💬" && rolloverB.statuses.at(-1)?.[1] === "💬",
		"atomic config epoch rollover with stale-client convergence",
	);
	assert.equal(FakeGateway.activeConnections, 1);
	assert.equal(FakeGateway.maximumActiveConnections, 1);
	const beforeTerminalCount = FakeGateway.instances.length;
	FakeGateway.instances.at(-1).terminal();
	await waitFor(() => rolloverA.statuses.some(([, text]) => text === "🔄") || rolloverB.statuses.some(([, text]) => text === "🔄"), "compact reconnecting status");
	await waitFor(() => FakeGateway.instances.length > beforeTerminalCount, "terminal gateway replacement");
	await waitFor(() => rolloverA.statuses.at(-1)?.[1] === "💬" && rolloverB.statuses.at(-1)?.[1] === "💬", "compact reconnected statuses");
	assert.equal(FakeGateway.activeConnections, 1);
	assert.equal(FakeGateway.maximumActiveConnections, 1);
	await rolloverB.emit("session_shutdown", { reason: "quit" });
	assert.equal(FakeGateway.activeConnections, 1, "newest-config relay must survive its introducing client");
	assert.equal(rolloverA.statuses.at(-1)?.[1], "💬");
	await rolloverA.emit("session_shutdown", { reason: "quit" });
	await waitFor(() => FakeGateway.activeConnections === 0, "rollover relay shutdown");
	for (const harness of [first, second, textOnly, retainedCrash, retainedResume, taskNamed, taskNamedSibling, taskFallback, metadataAbsent,
		failedInjection, retriedInjection, acceptedCleanupSeed, acceptedCleanup, inactive, resumed, restarted, rolloverA, rolloverB]) {
		for (const [key, text] of harness.statuses) {
			assert.equal(key, PACKAGE_FOOTER_STATUS_KEYS.discord);
			assert.ok(text === undefined || text === "💬" || text === "🔄" || text === "⚠️", `footer status must be compact: ${text}`);
		}
	}

	console.log("[discord bridge test] passed");
} finally {
	globalThis.fetch = originalFetch;
	if (compatibilityDirectory) await rm(compatibilityDirectory, { recursive: true, force: true });
	await rm(output, { recursive: true, force: true });
	await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
