#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".discord-bridge-test-"));

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

	assert.equal(isClientFrame({
		type: "register",
		token: "token",
		clientId: "client",
		generation: "generation",
		configFingerprint: "fingerprint",
		configEpoch: 1,
		cwd: "/the-manager",
		sessionId: "manager",
		managerTaskSummaryProducer: true,
		managerPresentation: { schemaVersion: 1, controlIds: ["github-refresh-reconcile"] },
	}), true);
	assert.equal(isServerFrame({
		type: "manager_presentation_control",
		requestId: "presentation",
		revision: "a".repeat(64),
		controlId: "github-refresh-reconcile",
		command: "github-refresh-reconcile",
	}), true, "Manager presentation buttons retain protocol support");

	const events = [];
	const transport = new DiscordJsTransport();
	transport.guild = async () => ({
		commands: {
			async fetch() { return [{ id: "pi-command", name: "pi" }]; },
			async edit(id, definition) { events.push(["edit", id, definition.name]); },
			async create(definition) { events.push(["create", definition.name]); },
		},
	});
	await transport.registerControls("guild");
	assert.deepEqual(events, [["edit", "pi-command", "pi"]], "registration changes only /pi");

	const files = [
		"extensions/discord/bridge.ts",
		"extensions/discord/controls.ts",
		"extensions/discord/index.ts",
		"extensions/discord/protocol.ts",
		"extensions/discord/relay-client.ts",
		"extensions/discord/relay-core.ts",
		"extensions/discord/relay-host.ts",
		"extensions/discord/transport.ts",
		"README.md",
	];
	const removedSurface = [
		["manager", "Controls"].join(""),
		["manager_", "control"].join(""),
		["manager", "Command", "Definition"].join(""),
		["on", "Manager", "Control"].join(""),
	];
	for (const path of files) {
		const text = await readFile(join(root, path), "utf8");
		for (const token of removedSurface) assert.equal(text.includes(token), false, `${path} retains removed command surface`);
	}

	const scan = spawnSync("git", ["grep", "-n", "-E", "/" + "m([[:space:]`<]|$)"], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(scan.status, 1, "tracked repository must not advertise removed slash command");

	console.log("discord bridge command-surface tests passed");
} finally {
	await rm(output, { recursive: true, force: true });
}
