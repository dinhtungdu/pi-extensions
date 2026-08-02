#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [buildRoot, directory, eventsFile] = process.argv.slice(2);
const { runRelayChild } = await import(pathToFileURL(join(buildRoot, "extensions/discord/relay-child.js")));
const { DiscordStateStore } = await import(pathToFileURL(join(buildRoot, "extensions/discord/state.js")));

async function record(event) {
	await appendFile(eventsFile, `${JSON.stringify({ ...event, pid: process.pid, at: Date.now() })}\n`);
}

class ChildFakeTransport {
	messageListeners = new Set();
	terminalListeners = new Set();

	async connect(config) {
		this.config = config;
		await record({ event: "connect", token: config.token, epoch: config.epoch });
	}

	async disconnect() {
		await record({ event: "disconnect", token: this.config?.token, epoch: this.config?.epoch });
	}

	onMessage(listener) {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	onSessionControl() {
		return () => {};
	}

	onModelAutocomplete() {
		return () => {};
	}

	onTerminalError(listener) {
		this.terminalListeners.add(listener);
		return () => this.terminalListeners.delete(listener);
	}

	async ensureProjectChannel(request) {
		return request.mappedChannelId ?? `channel-${Buffer.from(request.name).toString("hex").slice(-12)}`;
	}

	async ensureSessionThread(request) {
		return request.mappedThreadId ?? `thread-${Buffer.from(request.name).toString("hex").slice(-16)}`;
	}

	async fetchMessagesAfter() {
		return [];
	}

	async sendText(channelId, text, nonce) {
		await record({ event: "send", channelId, text, nonce });
		return `message-${nonce}`;
	}
}

await runRelayChild((await import(pathToFileURL(join(buildRoot, "extensions/discord/config.js")))).relayPaths(directory), {
	createStateStore: () => new DiscordStateStore(join(directory, "state.json")),
	createTransport: () => new ChildFakeTransport(),
});
