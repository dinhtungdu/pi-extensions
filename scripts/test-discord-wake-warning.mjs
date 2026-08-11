#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".discord-wake-warning-test-"));
const dataDir = await mkdtemp(join(tmpdir(), "pi-discord-wake-warning-"));

class FakeGateway {
	messageListeners = new Set();
	wakeWarningListeners = new Set();
	warnings = [];
	deleted = [];

	async connect() {}
	async disconnect() {}
	onMessage(listener) { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener); }
	onSessionControl() { return () => {}; }
	onModelAutocomplete() { return () => {}; }
	onManagerControl() { return () => {}; }
	onManagerAutocomplete() { return () => {}; }
	onPresentationControl() { return () => {}; }
	onWakeWarningDismiss(listener) { this.wakeWarningListeners.add(listener); return () => this.wakeWarningListeners.delete(listener); }
	onTerminalError() { return () => {}; }
	async ensureProjectChannel() { return "wake-channel"; }
	async ensureSessionThread(request) { return request.mappedThreadId ?? "wake-thread"; }
	async fetchMessagesAfter() { return []; }
	async latestMessageId() { return undefined; }
	async sendText() { throw new Error("unexpected ordinary text send"); }
	async sendPresentation() { throw new Error("unexpected presentation send"); }
	async editOwnText() {}
	async editOwnPresentation() {}
	async setLifecycleReaction() {}
	async sendWakeWarning(channelId, text, nonce, customId) {
		const id = `warning-${this.warnings.length + 1}`;
		this.warnings.push({ id, channelId, text, nonce, customId });
		return id;
	}
	async deleteOwnText(channelId, messageId) { this.deleted.push({ channelId, messageId }); }
	async emit(message) { await Promise.all([...this.messageListeners].map((listener) => listener(message))); }
	async dismiss(request) {
		const listener = this.wakeWarningListeners.values().next().value;
		return listener(request);
	}
}

try {
	const compile = spawnSync(
		join(root, "node_modules", ".bin", "tsc"),
		["--noEmit", "false", "--rootDir", ".", "--outDir", output],
		{ cwd: root, encoding: "utf8" },
	);
	if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`.trim());
	const importBuilt = (path) => import(pathToFileURL(join(output, path)).href);
	const { DiscordRelayCore } = await importBuilt("extensions/discord/relay-core.js");
	const { DiscordStateStore } = await importBuilt("extensions/discord/state.js");
	const { wakeWarningComponents } = await importBuilt("extensions/discord/transport.js");

	assert.deepEqual(wakeWarningComponents("wq:0123456789abcdefabcd").map((row) => row.toJSON()), [{
		type: 1,
		components: [{
			type: 2, emoji: undefined, custom_id: "wq:0123456789abcdefabcd", label: "Dismiss", style: 2,
		}],
	}], "wake warnings must render one clear Dismiss button");

	const state = new DiscordStateStore(join(dataDir, "state.json"));
	const gateway = new FakeGateway();
	const core = new DiscordRelayCore(
		{ token: "token", guildId: "12345", epoch: 1 },
		state,
		gateway,
		() => {},
		undefined,
		{
			scheduleStateCompaction: () => () => {},
			wakeManagerSession: async () => { throw new Error("injected wake failure"); },
		},
	);
	await core.start();
	const registration = {
		cwd: "/wake-manager",
		projectIdentityResolved: true,
		sessionId: "wake-session",
		managerWake: {
			schemaVersion: 1,
			provider: "the-manager",
			socketPath: join(dataDir, ".manager", "supervisor.sock"),
			taskId: "wake-task",
			generation: 1,
			capability: "a".repeat(64),
		},
	};
	const prepared = await core.prepareRegistration("wake-client", "wake-generation", registration);
	await core.activateRegistration("wake-client", "wake-generation", "wake-session", () => true);
	core.unregisterClient("wake-client", "wake-generation");
	await gateway.emit({ id: "queued-message", channelId: prepared.threadId, content: "keep me", authorBot: false });

	assert.deepEqual((await state.pendingMessages("wake-session")).map((message) => message.id), ["queued-message"]);
	assert.equal(gateway.warnings.length, 1);
	const warning = gateway.warnings[0];
	assert.match(warning.text, /^⚠️ Message queued/);
	assert.match(warning.customId, /^wq:[a-f0-9]{20}$/);
	const request = {
		requestId: "dismiss-current",
		guildId: "12345",
		channelId: prepared.threadId,
		messageId: warning.id,
		customId: warning.customId,
	};

	assert.equal((await gateway.dismiss({ ...request, requestId: "dismiss-unauthorized", guildId: "other" })).ok, false);
	assert.equal((await gateway.dismiss({ ...request, requestId: "dismiss-malformed", customId: "wq:not-valid" })).ok, false);
	assert.equal((await gateway.dismiss({ ...request, requestId: "dismiss-stale", messageId: "other-warning" })).ok, false);
	assert.deepEqual(gateway.deleted, [], "unauthorized and stale interactions must not delete messages");
	assert.deepEqual((await state.pendingMessages("wake-session")).map((message) => message.id), ["queued-message"],
		"failed interactions must preserve the queue");

	assert.deepEqual(await gateway.dismiss(request), {
		ok: true,
		message: "Wake warning dismissed; the inbound message remains queued.",
	});
	assert.deepEqual(gateway.deleted, [{ channelId: prepared.threadId, messageId: warning.id }]);
	assert.deepEqual((await state.pendingMessages("wake-session")).map((message) => message.id), ["queued-message"],
		"dismissal must not acknowledge or dequeue inbound work");
	assert.equal((await gateway.dismiss({ ...request, requestId: "dismiss-completed" })).ok, false,
		"a consumed interaction must fail stale without another deletion");

	const delivered = [];
	await core.prepareRegistration("wake-client", "wake-generation-2", registration);
	await core.activateRegistration("wake-client", "wake-generation-2", "wake-session", (message) => {
		delivered.push(message.id);
		return true;
	});
	assert.deepEqual(delivered, ["queued-message"], "the queued message must deliver after reconnect");
	assert.deepEqual((await state.pendingMessages("wake-session")).map((message) => message.id), ["queued-message"],
		"delivery alone must not dequeue the message");
	await core.acknowledge("wake-client", "wake-generation-2", "wake-session", "queued-message");
	assert.deepEqual(await state.pendingMessages("wake-session"), []);
	await core.stop();

	console.log("[discord wake warning test] passed");
} finally {
	await rm(output, { recursive: true, force: true });
	await rm(dataDir, { recursive: true, force: true });
}
