#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const temp = await mkdtemp(join(tmpdir(), "auto-dark-mode-test-"));
const originalPath = process.env.PATH;
const originalPlatform = process.platform;
try {
	const osascript = join(temp, "osascript");
	await writeFile(osascript, "#!/bin/sh\necho true\n");
	await chmod(osascript, 0o755);
	await mkdir(join(temp, ".pi"));
	await writeFile(join(temp, ".pi", "auto-dark-mode.json"), JSON.stringify({ darkTheme: "dark", lightTheme: "light" }));
	process.env.PATH = `${temp}:${originalPath}`;
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

	const jiti = createJiti(import.meta.url);
	const { default: autoDarkMode } = await jiti.import("../extensions/auto-dark-mode.ts");
	const events = new Map();
	const themeCalls = [];
	const notifications = [];
	autoDarkMode({
		on: (name, handler) => events.set(name, handler),
		registerCommand: () => {},
	});
	const ctx = (mode) => ({
		mode,
		hasUI: true,
		cwd: temp,
		ui: {
			setTheme(name) {
				themeCalls.push(name);
				return mode === "rpc"
					? { success: false, error: "Theme switching not supported in RPC mode" }
					: { success: true };
			},
			notify: (...args) => notifications.push(args),
		},
	});

	await events.get("session_start")({}, ctx("rpc"));
	await events.get("session_shutdown")();
	assert.deepEqual(themeCalls, [], "RPC must never attempt terminal theme switching");
	assert.deepEqual(notifications, [], "RPC must not emit theme errors");

	await events.get("session_start")({}, ctx("tui"));
	await events.get("session_shutdown")();
	assert.deepEqual(themeCalls, ["dark"], "TUI still switches to the detected theme");
	assert.deepEqual(notifications, []);
	console.log("auto-dark-mode RPC/TUI: pass");
} finally {
	process.env.PATH = originalPath;
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	await rm(temp, { recursive: true, force: true });
}
