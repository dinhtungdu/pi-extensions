#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".discord-bridge-test-"));
const data = await mkdtemp(join(root, ".discord-bridge-data-"));

async function waitFor(predicate, description) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await predicate()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

class TestTransport {
	messages = [];
	locked = [];
	archived = [];
	presentationListeners = new Set();
	controlListeners = new Set();
	terminalListeners = new Set();

	async connect() {}
	async disconnect() {}
	onMessage() { return () => {}; }
	onSessionControl(listener) { this.controlListeners.add(listener); return () => this.controlListeners.delete(listener); }
	onModelAutocomplete() { return () => {}; }
	onPresentationControl(listener) { this.presentationListeners.add(listener); return () => this.presentationListeners.delete(listener); }
	onTerminalError(listener) { this.terminalListeners.add(listener); return () => this.terminalListeners.delete(listener); }
	async ensureProjectChannel() { return "project-channel"; }
	async ensureSessionThread(request) { return request.mappedThreadId ?? "session-thread"; }
	async fetchMessagesAfter() { return []; }
	async sendText(channelId, text) { this.messages.push({ channelId, text }); return `message-${this.messages.length}`; }
	async sendUserText(channelId, text) { return this.sendText(channelId, text); }
	async sendImages(channelId, text) { return this.sendText(channelId, text); }
	async sendPresentation(channelId, presentation) { return this.sendText(channelId, presentation.content); }
	async lockThread(channelId) { this.locked.push(channelId); }
	async archiveThread(channelId) { this.archived.push(channelId); }
	async latestMessageId() { return undefined; }
	async managerSummaryMessages() { return []; }
	async editOwnText() {}
	async editOwnPresentation() {}
	async deleteOwnText() {}
	async setLifecycleReaction() {}
}

try {
	const compile = spawnSync(
		join(root, "node_modules", ".bin", "tsc"),
		["--noEmit", "false", "--rootDir", ".", "--outDir", output],
		{ cwd: root, encoding: "utf8" },
	);
	if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`.trim());

	const importBuilt = (path) => import(pathToFileURL(join(output, path)));
	const { isClientFrame, isServerFrame } = await importBuilt("extensions/discord/protocol.js");
	const { DiscordJsTransport } = await importBuilt("extensions/discord/transport.js");
	const { DiscordRelayCore } = await importBuilt("extensions/discord/relay-core.js");
	const { DiscordStateStore } = await importBuilt("extensions/discord/state.js");

	assert.equal(isClientFrame({
		type: "register", token: "token", clientId: "client", generation: "generation", configFingerprint: "fingerprint",
		configEpoch: 1, cwd: "/the-manager", sessionId: "manager", managerTaskSummaryProducer: true,
		managerPresentation: { schemaVersion: 1, controlIds: ["github-refresh-reconcile"] },
	}), true);
	assert.equal(isServerFrame({
		type: "manager_presentation_control", requestId: "presentation", revision: "a".repeat(64),
		controlId: "github-refresh-reconcile", command: "github-refresh-reconcile",
	}), true, "Manager presentation buttons retain protocol support");

	const registrationEvents = [];
	const transport = new DiscordJsTransport();
	transport.guild = async () => ({
		commands: {
			async fetch() { return [{ id: "pi-command", name: "pi" }]; },
			async edit(id, definition) { registrationEvents.push(["edit", id, definition.name]); },
			async create(definition) { registrationEvents.push(["create", definition.name]); },
		},
	});
	await transport.registerControls("guild");
	assert.deepEqual(registrationEvents, [["edit", "pi-command", "pi"]], "registration changes only /pi");

	const controlResults = [];
	transport.onSessionControl(async (request) => {
		controlResults.push(request);
		return { ok: true, message: "Pi status" };
	});
	const controlReplies = [];
	await transport.executeControlInteraction({
		id: "pi-status", options: { getSubcommand: () => "status" },
		async deferReply() {}, async editReply(reply) { controlReplies.push(reply); },
	}, "session-thread");
	assert.deepEqual(controlResults, [{ requestId: "pi-status", channelId: "session-thread", action: { type: "status" } }]);
	assert.equal(controlReplies[0].content, "✅ Pi status");

	const presentationRequests = [];
	transport.onPresentationControl(async (request) => {
		presentationRequests.push(request);
		return { ok: true, message: "Refresh started" };
	});
	const presentationReplies = [];
	await transport.executePresentationControlInteraction({
		id: "refresh", guildId: "guild", message: { id: "summary", channelId: "project-channel" },
		customId: `m:${"b".repeat(64)}:github-refresh-reconcile`,
		async deferReply() {}, async editReply(reply) { presentationReplies.push(reply); },
	}, "wrong-interaction-channel");
	assert.deepEqual(presentationRequests, [{
		requestId: "refresh", guildId: "guild", channelId: "project-channel", messageId: "summary",
		customId: `m:${"b".repeat(64)}:github-refresh-reconcile`,
	}], "Manager summary button uses its message channel, not conflicting interaction metadata");
	assert.equal(presentationReplies[0].content, "✅ Refresh started");

	const relayTransport = new TestTransport();
	const relay = new DiscordRelayCore(
		{ token: "token", guildId: "guild", epoch: 1 },
		new DiscordStateStore(join(data, "state.json")),
		relayTransport,
	);
	await relay.start();
	await relay.prepareRegistration("target", "target-generation", {
		cwd: "/task", projectIdentityResolved: true, sessionId: "target-session", managerTaskSnapshotTaskId: "task-id",
	});
	await relay.activateRegistration("target", "target-generation", "target-session", () => true,
		undefined, false, false, undefined, "task-id");
	const snapshot = {
		schemaVersion: 1, revision: "c".repeat(64), taskId: "task-id", title: "Task", status: "active", content: "snapshot",
	};
	await relay.queueManagerTaskSnapshot("target", "target-generation", "target-session", snapshot);
	await waitFor(() => relayTransport.messages.some((message) => message.text === "snapshot"), "task snapshot delivery");

	await relay.prepareRegistration("producer", "producer-generation", {
		cwd: "/the-manager", projectIdentityResolved: true, sessionId: "producer-session",
	});
	await relay.activateRegistration("producer", "producer-generation", "producer-session", () => true,
		undefined, false, true, undefined, undefined, true);
	const terminal = {
		schemaVersion: 1, revision: "d".repeat(64), taskId: "task-id", content: "terminal", closeThread: true,
	};
	await relay.queueManagerTaskTerminal("producer", "producer-generation", "producer-session", terminal);
	await waitFor(() => relayTransport.archived.length === 1, "task terminal archival");
	assert.deepEqual(relayTransport.locked, ["session-thread"]);
	assert.deepEqual(relayTransport.archived, ["session-thread"]);
	await relay.stop();

	const summaryTransport = new TestTransport();
	const summaryState = new DiscordStateStore(join(data, "summary-state.json"));
	const summaryRelay = new DiscordRelayCore(
		{ token: "token", guildId: "guild", epoch: 1 }, summaryState, summaryTransport,
	);
	const invokedCommands = [];
	const presentation = {
		schemaVersion: 1, revision: "e".repeat(64), content: "Current manager summary",
		controls: [{ id: "github-refresh-reconcile", label: "Refresh & Reconcile", style: "secondary", command: "github-refresh-reconcile" }],
		degraded: false, warnings: [],
	};
	await summaryRelay.start();
	await summaryRelay.prepareRegistration("summary", "summary-generation", {
		cwd: "/the-manager", projectIdentityResolved: true, sessionId: "summary-session",
	});
	await summaryRelay.activateRegistration("summary", "summary-generation", "summary-session", () => true,
		undefined, false, true, {
			controlIds: ["github-refresh-reconcile"],
			execute: async (request) => {
				invokedCommands.push(request);
				return { ok: true, message: "Refresh started" };
			},
		});
	await summaryRelay.queueManagerPresentation("summary", "summary-generation", "summary-session", presentation);
	await waitFor(async () => (await summaryState.projectSummaries())[0]?.summary.delivery?.presentation?.revision === presentation.revision,
		"current manager summary delivery");
	const summary = (await summaryState.projectSummaries())[0];
	assert.ok(summary, "current summary state must remain mapped");
	const interactionTransport = new DiscordJsTransport();
	interactionTransport.onPresentationControl((request) => summaryRelay.executeDiscordPresentationControl(request));
	const summaryReplies = [];
	await interactionTransport.executePresentationControlInteraction({
		id: "current-summary-control", guildId: "guild",
		message: { id: summary.summary.delivery.messageId, channelId: summary.mapping.channelId },
		customId: `m:${presentation.revision}:github-refresh-reconcile`,
		async deferReply() {}, async editReply(reply) { summaryReplies.push(reply); },
	}, "wrong-interaction-channel");
	assert.deepEqual(invokedCommands, [{
		requestId: "current-summary-control", revision: presentation.revision,
		controlId: "github-refresh-reconcile", command: "github-refresh-reconcile",
	}], "current summary control invokes canonical Manager command");
	assert.equal(summaryReplies[0].content, "✅ Refresh started");
	assert.deepEqual(await summaryRelay.executeDiscordPresentationControl({
		requestId: "unrelated-summary-control", guildId: "guild", channelId: "unrelated-channel",
		messageId: summary.summary.delivery.messageId,
		customId: `m:${presentation.revision}:github-refresh-reconcile`,
	}), { ok: false, message: "This manager presentation control is not mapped to a current project summary." },
	"unrelated presentation controls remain rejected");
	await summaryRelay.stop();

	const files = [
		"extensions/discord/bridge.ts", "extensions/discord/controls.ts", "extensions/discord/index.ts",
		"extensions/discord/protocol.ts", "extensions/discord/relay-client.ts", "extensions/discord/relay-core.ts",
		"extensions/discord/relay-host.ts", "extensions/discord/transport.ts", "README.md",
	];
	const removedSurface = [
		["manager", "Controls"].join(""), ["manager_", "control"].join(""),
		["manager", "Command", "Definition"].join(""), ["on", "Manager", "Control"].join(""),
	];
	for (const path of files) {
		const text = await readFile(join(root, path), "utf8");
		for (const token of removedSurface) assert.equal(text.includes(token), false, `${path} retains removed command surface`);
	}
	const scan = spawnSync("git", ["grep", "-n", "-E", "/" + "m([[:space:]`<]|$)"], { cwd: root, encoding: "utf8" });
	assert.equal(scan.status, 1, "tracked repository must not advertise removed slash command");

	console.log("discord bridge command-surface tests passed");
} finally {
	await rm(output, { recursive: true, force: true });
	await rm(data, { recursive: true, force: true });
}
