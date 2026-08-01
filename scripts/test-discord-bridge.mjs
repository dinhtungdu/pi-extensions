#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ChannelType } from "discord.js";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".discord-bridge-test-"));
const dataDir = await mkdtemp(join(tmpdir(), "pi-discord-bridge-data-"));

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

	connected = false;
	listeners = new Set();
	terminalListeners = new Set();
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

	async sendText(channelId, text, nonce) {
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

function createExtensionHarness(extension, { cwd, sessionId, sessionName, entries = [] }) {
	const events = new Map();
	const commands = new Map();
	const notifications = [];
	const statuses = [];
	const userMessages = [];
	const userWaiters = [];
	let idle = true;
	let injectionError = false;
	const pi = {
		on(name, handler) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		sendUserMessage(text, options) {
			if (injectionError) throw new Error("injected Pi acceptance failure");
			const message = { text, options };
			userMessages.push(message);
			userWaiters.shift()?.(message);
		},
		getSessionName() {
			return sessionName;
		},
		appendEntry(customType, data) {
			entries.push({ type: "custom", customType, data });
		},
	};
	const ctx = {
		cwd,
		hasUI: true,
		isIdle: () => idle,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
		ui: {
			notify: (...args) => notifications.push(args),
			setStatus: (...args) => statuses.push(args),
		},
	};
	extension(pi);
	return {
		commands,
		events,
		notifications,
		statuses,
		userMessages,
		entries,
		setIdle(value) { idle = value; },
		setInjectionError(value) { injectionError = value; },
		nextUserMessage() {
			return new Promise((resolveMessage) => userWaiters.push(resolveMessage));
		},
		async emit(name, event = {}) {
			let result;
			for (const handler of events.get(name) ?? []) result = await handler(event, ctx);
			return result;
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
	const { DiscordStateStore } = await importBuilt("extensions/discord/state.js");
	const { createDiscordExtension } = await importBuilt("extensions/discord/index.js");
	const { DiscordRelayCore } = await importBuilt("extensions/discord/relay-core.js");
	const { inboundMessageId, stripInboundMarker } = await importBuilt("extensions/discord/bridge.js");
	const { BoundedSocketWriter, MAX_QUEUED_IPC_FRAMES } = await importBuilt("extensions/discord/ipc-writer.js");
	const { tryAcquireLeader } = await importBuilt("extensions/discord/leader.js");
	const {
		assistantText,
		collidingProjectChannelName,
		interactiveUserChunks,
		projectChannelName,
		sessionThreadName,
		splitDiscordText,
	} = await importBuilt("extensions/discord/text.js");
	const { assertConfiguredCategory, collectChronologicalMessages, reuseSessionThread } = await importBuilt("extensions/discord/transport.js");

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
	let reopened = false;
	assert.equal(await reuseSessionThread({
		id: "thread-1",
		parentId: "channel-1",
		archived: true,
		isThread: () => true,
		async setArchived(value) { reopened = value === false; },
	}, "channel-1"), "thread-1");
	assert.equal(reopened, true);
	const malformedConfig = join(dataDir, "malformed-config.json");
	await writeFile(malformedConfig, "{oops");
	await assert.rejects(() => loadDiscordConfig(malformedConfig, {}), /Cannot read Discord bridge config/);
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

	assert.equal(projectChannelName("/one/My Project"), "my-project");
	assert.equal(projectChannelName("/one/project"), projectChannelName("/two/project"));
	assert.equal(projectChannelName(`/tmp/${"a".repeat(150)}`).length, 100);
	assert.equal(collidingProjectChannelName(`/tmp/${"a".repeat(150)}`).length, 100);
	assert.match(collidingProjectChannelName("/one/project"), /^project-[a-f0-9]{8}$/);
	assert.equal(projectChannelName("/tmp/项目"), "project");
	assert.match(collidingProjectChannelName("/tmp/另一个项目"), /^project-[a-f0-9]{8}$/);
	assert.equal(projectChannelName("/tmp/Café déjà"), "cafe-deja");
	assert.match(sessionThreadName("12345678-abcd", "Fix Things"), /^pi-fix-things-12345678$/);
	assert.equal(assistantText({
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "Final" }],
	}), "Final");
	assert.equal(assistantText({
		role: "assistant",
		stopReason: "aborted",
		content: [{ type: "text", text: "partial" }],
	}), undefined);
	const chunks = splitDiscordText("a".repeat(4_100));
	assert.equal(chunks.join(""), "a".repeat(4_100));
	assert.ok(chunks.every((chunk) => chunk.length <= 1_900));
	assert.deepEqual(interactiveUserChunks("ordinary input"), ["🖥️ **ordinary input**"]);
	assert.deepEqual(interactiveUserChunks("line one\nline two"), ["🖥️ **line one\nline two**"]);
	assert.deepEqual(
		interactiveUserChunks("**bold** _under_ `code` \\ slash"),
		["🖥️ **\\*\\*bold\\*\\* \\_under\\_ \\`code\\` \\\\ slash**"],
	);
	const longInteractiveInput = "long *markdown* line\n".repeat(300);
	const longInteractiveChunks = interactiveUserChunks(longInteractiveInput);
	assert.ok(longInteractiveChunks.length > 1);
	assert.ok(longInteractiveChunks.every((chunk) => chunk.startsWith("🖥️ **") && chunk.endsWith("**") && chunk.length <= 1_900));
	const reconstructedInteractive = longInteractiveChunks
		.map((chunk) => chunk.slice("🖥️ **".length, -2).replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1"))
		.join("");
	assert.equal(reconstructedInteractive, longInteractiveInput);

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

	const relayDirectory = join(dataDir, "shared-relay");
	const paths = relayPaths(relayDirectory);
	const stateFile = join(relayDirectory, "state.json");
	const extension = createDiscordExtension({
		paths,
		loadConfig: async () => ({ token: "token", guildId: "12345", categoryId: "67890", epoch: 1 }),
		saveConfig: async () => {},
		createStateStore: () => new DiscordStateStore(stateFile),
		createTransport: () => new FakeGateway(),
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
	assert.equal(first.events.has("agent_end"), false);

	const firstStatus = first.statuses.findLast(([, text]) => text?.startsWith("Discord relay "))[1];
	const secondStatus = second.statuses.findLast(([, text]) => text?.startsWith("Discord relay "))[1];
	const [firstChannel, firstThread] = firstStatus.replace("Discord relay ", "").split("/");
	const [secondChannel, secondThread] = secondStatus.replace("Discord relay ", "").split("/");
	assert.equal(firstChannel, secondChannel, "sessions in one cwd must share its durable project channel");
	assert.notEqual(firstThread, secondThread);
	const gateway = FakeGateway.instances[0];
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
	await gateway.emit({ id: "10", channelId: secondThread, content: "duplicate", authorBot: false });
	assert.equal(second.userMessages.length, 1, "duplicate Discord IDs must not deliver twice");
	await gateway.emit({ id: "11", channelId: secondThread, content: "bot", authorBot: true });
	assert.equal(second.userMessages.length, 1, "bot output must not loop back into Pi");

	await first.emit("input", { text: "local input", source: "interactive" });
	await waitFor(() => gateway.sent.some((message) => message.text === "🖥️ **local input**"), "formatted interactive user send");
	assert.equal(gateway.sent.at(-1).channelId, firstThread);
	assert.equal(gateway.sent.at(-1).text, "🖥️ **local input**");
	await first.emit("input", { text: "line one\nline two", source: "interactive" });
	await waitFor(() => gateway.sent.some((message) => message.text === "🖥️ **line one\nline two**"), "formatted multiline interactive send");
	const markdownInput = "**bold** _under_ `code` \\ slash";
	const markdownOutput = interactiveUserChunks(markdownInput)[0];
	await first.emit("input", { text: markdownInput, source: "interactive" });
	await waitFor(() => gateway.sent.some((message) => message.text === markdownOutput), "markdown-safe interactive send");
	const longStart = gateway.sent.length;
	await first.emit("input", { text: longInteractiveInput, source: "interactive" });
	await waitFor(() => gateway.sent.length >= longStart + longInteractiveChunks.length, "chunk-safe long interactive send");
	assert.deepEqual(gateway.sent.slice(longStart).map((message) => message.text), longInteractiveChunks);
	await first.emit("input", { text: "RPC input", source: "rpc" });
	await waitFor(() => gateway.sent.some((message) => message.text === "RPC input"), "unchanged non-interactive input send");
	const sentBeforeLoopCheck = gateway.sent.length;
	await first.emit("input", { text: "Discord echo", source: "extension" });
	assert.equal(gateway.sent.length, sentBeforeLoopCheck, "Discord-origin extension input must not loop back to Discord");
	await first.emit("before_agent_start", {});
	await first.emit("message_end", {
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final only" }] },
	});
	assert.notEqual(gateway.sent.at(-1)?.text, "final only");
	await first.emit("agent_settled", {});
	await waitFor(() => gateway.sent.some((message) => message.text === "final only"), "durable final assistant send");
	assert.equal(gateway.sent.at(-1)?.text, "final only", "assistant output must wait for agent_settled");

	const failedInjection = createExtensionHarness(extension, {
		cwd: "/work/failing",
		sessionId: "session-44444444",
		sessionName: "Failing injection",
	});
	await failedInjection.emit("session_start", { reason: "startup" });
	const failedThread = failedInjection.statuses.findLast(([, text]) => text?.startsWith("Discord relay "))[1].split("/").at(-1);
	failedInjection.setInjectionError(true);
	await gateway.emit({ id: "15", channelId: failedThread, content: "must remain pending", authorBot: false });
	await waitFor(() => failedInjection.notifications.some(([text]) => text.includes("injected Pi acceptance failure")), "Pi injection failure");
	assert.equal(failedInjection.userMessages.length, 0);
	const shutdownStarted = Date.now();
	await failedInjection.emit("session_shutdown", { reason: "quit" });
	assert.ok(Date.now() - shutdownStarted < 2_500, "unconfirmed inbound must not block shutdown");
	const failedState = await new DiscordStateStore(stateFile).getSession("session-44444444");
	assert.deepEqual(failedState.pendingMessages, [{ id: "15", content: "must remain pending" }]);
	const retriedInjection = createExtensionHarness(extension, {
		cwd: "/work/failing",
		sessionId: "session-44444444",
		sessionName: "Failing injection",
	});
	const retriedDelivery = retriedInjection.nextUserMessage();
	await retriedInjection.emit("session_start", { reason: "resume" });
	const retriedMessage = await retriedDelivery;
	assert.equal(stripInboundMarker(retriedMessage.text), "must remain pending");
	await retriedInjection.emit("message_end", { message: { role: "user", content: [{ type: "text", text: retriedMessage.text }] } });
	await waitFor(() => retriedInjection.entries.some((entry) => entry.data?.messageId === "15"), "retried Pi acceptance receipt");
	await retriedInjection.emit("session_shutdown", { reason: "quit" });

	await first.emit("session_shutdown", { reason: "quit" });
	assert.equal(FakeGateway.instances.length, 1, "relay child must survive the Pi client that launched it");
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
	const inactiveStatus = inactive.statuses.findLast(([, text]) => text?.startsWith("Discord relay "))[1];
	const inactiveThread = inactiveStatus.split("/").at(-1);
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
			rolloverA.statuses.at(-1)?.[1]?.startsWith("Discord relay ") && rolloverB.statuses.at(-1)?.[1]?.startsWith("Discord relay "),
		"atomic config epoch rollover with stale-client convergence",
	);
	assert.equal(FakeGateway.activeConnections, 1);
	assert.equal(FakeGateway.maximumActiveConnections, 1);
	const beforeTerminalCount = FakeGateway.instances.length;
	FakeGateway.instances.at(-1).terminal();
	await waitFor(() => FakeGateway.instances.length > beforeTerminalCount, "terminal gateway replacement");
	assert.equal(FakeGateway.activeConnections, 1);
	assert.equal(FakeGateway.maximumActiveConnections, 1);
	await rolloverB.emit("session_shutdown", { reason: "quit" });
	assert.equal(FakeGateway.activeConnections, 1, "newest-config relay must survive its introducing client");
	assert.ok(rolloverA.statuses.at(-1)?.[1]?.startsWith("Discord relay "));
	await rolloverA.emit("session_shutdown", { reason: "quit" });
	await waitFor(() => FakeGateway.activeConnections === 0, "rollover relay shutdown");

	console.log("[discord bridge test] passed");
} finally {
	await rm(output, { recursive: true, force: true });
	await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
