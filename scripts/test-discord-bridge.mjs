#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
		if (predicate()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

class FakeGateway {
	static instances = [];
	static activeConnections = 0;
	static maximumActiveConnections = 0;
	static catchUpByThread = new Map();

	connected = false;
	listeners = new Set();
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
		return request.mappedThreadId ?? `thread-${++this.threadCounter}-${request.name.slice(-8)}`;
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

	async sendText(channelId, text) {
		this.sent.push({ channelId, text });
	}

	async emit(message) {
		await Promise.all([...this.listeners].map((listener) => listener(message)));
	}
}

function createExtensionHarness(extension, { cwd, sessionId, sessionName }) {
	const events = new Map();
	const commands = new Map();
	const notifications = [];
	const statuses = [];
	const userMessages = [];
	const userWaiters = [];
	let idle = true;
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
			const message = { text, options };
			userMessages.push(message);
			userWaiters.shift()?.(message);
		},
		getSessionName() {
			return sessionName;
		},
	};
	const ctx = {
		cwd,
		hasUI: true,
		isIdle: () => idle,
		sessionManager: { getSessionId: () => sessionId },
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
		setIdle(value) { idle = value; },
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
	} = await importBuilt("extensions/discord/config.js");
	const { DiscordStateStore } = await importBuilt("extensions/discord/state.js");
	const { createDiscordExtension } = await importBuilt("extensions/discord/index.js");
	const { tryAcquireLeader } = await importBuilt("extensions/discord/leader.js");
	const { assistantText, projectChannelName, sessionThreadName, splitDiscordText } = await importBuilt("extensions/discord/text.js");
	const { assertConfiguredCategory, reuseSessionThread } = await importBuilt("extensions/discord/transport.js");

	assert.deepEqual(parseDiscordConfig({ token: " token ", guildId: "12345", categoryId: "" }), {
		token: "token",
		guildId: "12345",
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

	assert.equal(projectChannelName("/one/My Project"), projectChannelName("/one/My Project"));
	assert.notEqual(projectChannelName("/one/project"), projectChannelName("/two/project"));
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

	const electionPaths = relayPaths(join(dataDir, "election"));
	const contenders = await Promise.all([
		tryAcquireLeader(electionPaths),
		tryAcquireLeader(electionPaths),
		tryAcquireLeader(electionPaths),
	]);
	const winningLeases = contenders.filter(Boolean);
	assert.equal(winningLeases.length, 1, "atomic leader contention must produce exactly one winner");
	await winningLeases[0].release();
	await writeFile(electionPaths.leaderLock, JSON.stringify({ pid: 999_999_999, nonce: "stale", createdAt: 1 }));
	assert.equal(await tryAcquireLeader(electionPaths), undefined, "first stale-owner pass performs guarded recovery");
	const recoveredLease = await tryAcquireLeader(electionPaths);
	assert.ok(recoveredLease, "next contender must acquire after stale-owner recovery");
	await recoveredLease.release();

	const relayDirectory = join(dataDir, "shared-relay");
	const paths = relayPaths(relayDirectory);
	const stateFile = join(relayDirectory, "state.json");
	const extension = createDiscordExtension({
		paths,
		loadConfig: async () => ({ token: "token", guildId: "12345", categoryId: "67890" }),
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
	assert.deepEqual(await routedSecond, { text: "route to second", options: { deliverAs: "followUp" } });
	assert.equal(first.userMessages.length, 0, "Discord input must route only to its Pi session");
	await gateway.emit({ id: "10", channelId: secondThread, content: "duplicate", authorBot: false });
	assert.equal(second.userMessages.length, 1, "duplicate Discord IDs must not deliver twice");
	await gateway.emit({ id: "11", channelId: secondThread, content: "bot", authorBot: true });
	assert.equal(second.userMessages.length, 1, "bot output must not loop back into Pi");

	await first.emit("input", { text: "local input", source: "interactive" });
	assert.deepEqual(gateway.sent.at(-1), { channelId: firstThread, text: "local input" });
	const sentBeforeLoopCheck = gateway.sent.length;
	await first.emit("input", { text: "Discord echo", source: "extension" });
	assert.equal(gateway.sent.length, sentBeforeLoopCheck, "extension input must not loop back to Discord");
	await first.emit("before_agent_start", {});
	await first.emit("message_end", {
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final only" }] },
	});
	assert.notEqual(gateway.sent.at(-1)?.text, "final only");
	await first.emit("agent_settled", {});
	assert.equal(gateway.sent.at(-1)?.text, "final only", "assistant output must wait for agent_settled");

	await first.emit("session_shutdown", { reason: "quit" });
	await waitFor(
		() => FakeGateway.instances.length === 2 && second.statuses.at(-1)?.[1]?.startsWith("Discord relay "),
		"follower relay failover",
	);
	assert.equal(FakeGateway.activeConnections, 1, "failover must restore exactly one gateway connection");
	assert.equal(FakeGateway.maximumActiveConnections, 1, "leader handoff must not overlap gateway clients");
	const failoverGateway = FakeGateway.instances[1];
	const afterFailover = second.nextUserMessage();
	await failoverGateway.emit({ id: "20", channelId: secondThread, content: "after failover", authorBot: false });
	assert.equal((await afterFailover).text, "after failover");

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
	assert.equal((await queuedDelivery).text, "queued while inactive", "inactive-session messages must queue durably");
	await resumed.emit("session_shutdown", { reason: "quit" });

	await second.emit("session_shutdown", { reason: "quit" });
	assert.equal(FakeGateway.activeConnections, 0, "relay may stop when every Pi process is closed");
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
	assert.equal((await catchUpDelivery).text, "missed while offline", "relay restart must fetch after the durable cursor");
	assert.equal(restarted.userMessages.length, 1, "catch-up must not redeliver acknowledged Discord messages");
	await restarted.emit("session_shutdown", { reason: "quit" });

	const persisted = JSON.parse(await readFile(stateFile, "utf8"));
	assert.equal(persisted.sessions["session-33333333"].pendingMessages.length, 0);
	assert.equal(persisted.sessions["session-33333333"].lastMessageId, "40");
	assert.equal(FakeGateway.maximumActiveConnections, 1);

	console.log("[discord bridge test] passed");
} finally {
	await rm(output, { recursive: true, force: true });
	await rm(dataDir, { recursive: true, force: true });
}
