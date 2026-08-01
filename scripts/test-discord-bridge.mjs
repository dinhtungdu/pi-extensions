#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
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

class FakeTransport {
	connected = false;
	disconnected = false;
	projectRequests = [];
	threadRequests = [];
	sent = [];
	listeners = new Set();

	async connect(config) {
		this.config = config;
		this.connected = true;
	}

	async disconnect() {
		this.disconnected = true;
		this.connected = false;
	}

	onMessage(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async ensureProjectChannel(request) {
		this.projectRequests.push(request);
		return request.mappedChannelId ?? "channel-1";
	}

	async ensureSessionThread(request) {
		this.threadRequests.push(request);
		return request.mappedThreadId ?? "thread-1";
	}

	async sendText(channelId, text) {
		this.sent.push({ channelId, text });
	}

	async emit(message) {
		await Promise.all([...this.listeners].map((listener) => listener(message)));
	}
}

function createExtensionHarness(extension, transport) {
	const events = new Map();
	const commands = new Map();
	const notifications = [];
	const statuses = [];
	const userMessages = [];
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
			userMessages.push({ text, options });
		},
		getSessionName() {
			return "Bridge test";
		},
	};
	const ctx = {
		cwd: "/work/project",
		hasUI: true,
		isIdle: () => idle,
		sessionManager: { getSessionId: () => "session-12345678" },
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
		async emit(name, event = {}) {
			let result;
			for (const handler of events.get(name) ?? []) result = await handler(event, ctx);
			return result;
		},
		transport,
	};
}

try {
	compileExtensions();
	const importBuilt = (path) => import(pathToFileURL(join(output, path)));
	const { parseDiscordConfig, loadDiscordConfig } = await importBuilt("extensions/discord/config.js");
	const { DiscordStateStore } = await importBuilt("extensions/discord/state.js");
	const { DiscordBridge } = await importBuilt("extensions/discord/bridge.js");
	const { assistantText, projectChannelName, sessionThreadName, splitDiscordText } = await importBuilt("extensions/discord/text.js");
	const { createDiscordExtension } = await importBuilt("extensions/discord/index.js");
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
		"an invalid configured category must fail instead of falling back to root",
	);
	let reopened = false;
	assert.equal(await reuseSessionThread({
		id: "thread-1",
		parentId: "channel-1",
		archived: true,
		isThread: () => true,
		async setArchived(value) { reopened = value === false; },
	}, "channel-1"), "thread-1");
	assert.equal(reopened, true, "mapped archived threads must reopen");
	const malformedConfig = join(dataDir, "malformed-config.json");
	await writeFile(malformedConfig, "{oops");
	await assert.rejects(() => loadDiscordConfig(malformedConfig, {}), /Cannot read Discord bridge config/);

	assert.equal(projectChannelName("/one/My Project"), projectChannelName("/one/My Project"));
	assert.notEqual(projectChannelName("/one/project"), projectChannelName("/two/project"));
	assert.match(sessionThreadName("12345678-abcd", "Fix Things"), /^pi-fix-things-12345678$/);
	assert.equal(
		assistantText({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "Final" }],
		}),
		"Final",
	);
	assert.equal(assistantText({ role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] }), undefined);
	const chunks = splitDiscordText("a".repeat(4_100));
	assert.equal(chunks.join(""), "a".repeat(4_100));
	assert.ok(chunks.every((chunk) => chunk.length <= 1_900));

	const stateFile = join(dataDir, "state.json");
	const store = new DiscordStateStore(stateFile);
	let projectExisting;
	assert.equal(await store.resolveProjectChannel("/work/project", async (existing) => {
		projectExisting = existing;
		return "channel-1";
	}), "channel-1");
	assert.equal(projectExisting, undefined);
	await store.resolveProjectChannel("/work/project", async (existing) => {
		assert.equal(existing, "channel-1");
		return existing;
	});
	await store.resolveSessionThread("session-1", "/work/project", "channel-1", async (existing) => {
		assert.equal(existing, undefined);
		return "thread-1";
	});
	await store.resolveSessionThread("session-1", "/work/project", "channel-1", async (existing) => {
		assert.equal(existing, "thread-1", "persisted thread must be offered for reopening");
		return existing;
	});
	assert.equal(await store.markMessageSeen("message-1"), true);
	assert.equal(await new DiscordStateStore(stateFile).markMessageSeen("message-1"), false, "deduplication must survive store reload");
	assert.equal(JSON.parse(await readFile(stateFile, "utf8")).version, 1);

	const bridgeStateFile = join(dataDir, "bridge-state.json");
	const transport = new FakeTransport();
	const incoming = [];
	const errors = [];
	const bridge = new DiscordBridge(
		{ token: "token", guildId: "12345", categoryId: "67890" },
		{ cwd: "/work/project", sessionId: "session-12345678", sessionName: "Bridge test" },
		new DiscordStateStore(bridgeStateFile),
		transport,
		{ onUserText: (text) => incoming.push(text), onError: (error) => errors.push(error) },
	);
	assert.deepEqual(await bridge.start(), { connected: true, channelId: "channel-1", threadId: "thread-1" });
	assert.equal(transport.projectRequests[0].categoryId, "67890");
	await transport.emit({ id: "m-1", channelId: "thread-1", content: "from Discord", authorBot: false });
	await transport.emit({ id: "m-1", channelId: "thread-1", content: "duplicate", authorBot: false });
	await transport.emit({ id: "m-2", channelId: "thread-1", content: "bot", authorBot: true });
	await transport.emit({ id: "m-3", channelId: "wrong-thread", content: "wrong", authorBot: false });
	assert.deepEqual(incoming, ["from Discord"]);
	assert.deepEqual(errors, []);

	await bridge.mirrorUserText("from Pi");
	assert.deepEqual(transport.sent, [{ channelId: "thread-1", text: "from Pi" }]);
	bridge.beginAgentRun();
	bridge.captureAssistantMessage({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "progress" }] });
	bridge.captureAssistantMessage({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final only" }] });
	assert.equal(transport.sent.length, 1, "assistant text must not send before agent_settled boundary");
	await bridge.flushSettledAssistant();
	assert.deepEqual(transport.sent.at(-1), { channelId: "thread-1", text: "final only" });
	await bridge.flushSettledAssistant();
	assert.equal(transport.sent.length, 2, "settled output must flush once");
	await bridge.stop();
	assert.equal(transport.disconnected, true);

	const extensionTransport = new FakeTransport();
	const extensionStateFile = join(dataDir, "extension-state.json");
	const extension = createDiscordExtension({
		loadConfig: async () => ({ token: "token", guildId: "12345" }),
		saveConfig: async () => {},
		createStateStore: () => new DiscordStateStore(extensionStateFile),
		createTransport: () => extensionTransport,
	});
	const harness = createExtensionHarness(extension, extensionTransport);
	await harness.emit("session_start", { reason: "startup" });
	assert.deepEqual([...harness.commands.keys()], ["discord"]);
	assert.ok(harness.events.has("agent_settled"), "final output must use Pi 0.83 agent_settled");
	assert.equal(harness.events.has("agent_end"), false, "agent_end must not forward assistant output");
	assert.deepEqual(await harness.emit("input", { text: "local input", source: "interactive" }), { action: "continue" });
	assert.deepEqual(extensionTransport.sent.at(-1), { channelId: "thread-1", text: "local input" });
	const sentBeforeLoopCheck = extensionTransport.sent.length;
	await harness.emit("input", { text: "Discord echo", source: "extension" });
	assert.equal(extensionTransport.sent.length, sentBeforeLoopCheck, "extension input must not loop back to Discord");

	harness.setIdle(false);
	await extensionTransport.emit({ id: "queued-1", channelId: "thread-1", content: "queue me", authorBot: false });
	assert.deepEqual(harness.userMessages.at(-1), { text: "queue me", options: { deliverAs: "followUp" } });
	harness.setIdle(true);
	await extensionTransport.emit({ id: "idle-1", channelId: "thread-1", content: "run now", authorBot: false });
	assert.deepEqual(harness.userMessages.at(-1), { text: "run now", options: undefined });

	await harness.emit("before_agent_start", { prompt: "", systemPrompt: "" });
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "settled answer" }] },
	});
	assert.notEqual(extensionTransport.sent.at(-1)?.text, "settled answer");
	await harness.emit("agent_settled", {});
	assert.equal(extensionTransport.sent.at(-1)?.text, "settled answer");
	await harness.emit("session_shutdown", { reason: "quit" });

	console.log("[discord bridge test] passed");
} finally {
	await rm(output, { recursive: true, force: true });
	await rm(dataDir, { recursive: true, force: true });
}
