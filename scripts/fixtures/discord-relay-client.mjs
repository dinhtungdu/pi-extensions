#!/usr/bin/env node

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [buildRoot, directory, eventsFile, configFile, token, sessionId] = process.argv.slice(2);
const configModule = await import(pathToFileURL(join(buildRoot, "extensions/discord/config.js")));
const { LocalRelayClient } = await import(pathToFileURL(join(buildRoot, "extensions/discord/relay-client.js")));
const paths = configModule.relayPaths(directory);
const loadConfig = async () => {
	const config = await configModule.loadDiscordConfig(configFile, { DISCORD_TOKEN: token });
	if (!config) throw new Error("fixture config missing");
	return config;
};
const childFixture = resolve(import.meta.dirname, "discord-relay-child.mjs");
let stopping = false;

const client = new LocalRelayClient(
	await loadConfig(),
	{ cwd: `/fixture/${sessionId}`, sessionId, sessionName: sessionId },
	{
		onInbound() {},
		onError(error) {
			if (!stopping) process.stdout.write(`ERROR ${error.message}\n`);
		},
		onStatus(status) {
			process.stdout.write(`STATUS ${status.connected ? "connected" : "disconnected"}\n`);
		},
	},
	{
		paths,
		reloadConfig: loadConfig,
		async launchRelay() {
			const child = spawn(process.execPath, [childFixture, buildRoot, directory, eventsFile], {
				detached: true,
				stdio: "ignore",
			});
			child.unref();
		},
	},
);

async function stop() {
	if (stopping) return;
	stopping = true;
	await client.stop().catch(() => {});
	process.exit(0);
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
await client.start();
process.stdout.write("READY\n");
setInterval(() => {}, 60_000);
