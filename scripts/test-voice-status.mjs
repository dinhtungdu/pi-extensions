#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".voice-status-test-"));

try {
	const compile = spawnSync(
		join(root, "node_modules", ".bin", "tsc"),
		["--noEmit", "false", "--rootDir", ".", "--outDir", output],
		{ cwd: root, encoding: "utf8" },
	);
	if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`.trim());

	const { PACKAGE_FOOTER_STATUS_KEYS } = await import(
		pathToFileURL(join(output, "extensions", "footer-status.js"))
	);
	const { default: voiceExtension } = await import(
		pathToFileURL(join(output, "extensions", "voice", "index.js"))
	);
	const { defaultVoiceConfig } = await import(
		pathToFileURL(join(output, "extensions", "voice", "config.js"))
	);
	const { VoiceRuntime } = await import(
		pathToFileURL(join(output, "extensions", "voice", "runtime.js"))
	);
	const { syncVoiceStatus, VOICE_STATUS_ICON, VOICE_STATUS_KEY } = await import(
		pathToFileURL(join(output, "extensions", "voice", "status.js"))
	);

	const colorCodes = { dim: 2, accent: 36, success: 32, error: 31 };
	const styled = (color) => `\u001b[${colorCodes[color]}m${VOICE_STATUS_ICON}\u001b[0m`;
	const statuses = [];
	const footerStatuses = new Map([["agentmemory", "🧠 agentmemory"]]);
	const orderedFooterKeys = () => [...footerStatuses.keys()].sort((left, right) => left.localeCompare(right));
	const setFooterStatus = (key, text) => {
		statuses.push([key, text]);
		if (text === undefined) footerStatuses.delete(key);
		else footerStatuses.set(key, text);
	};
	for (const key of Object.values(PACKAGE_FOOTER_STATUS_KEYS)) {
		assert.ok(key.localeCompare("agentmemory") < 0, `${key} must sort before agentmemory under Pi 0.83 footer semantics`);
	}
	const simulatedFooter = new Map([["agentmemory", "🧠 agentmemory"]]);
	for (const key of Object.values(PACKAGE_FOOTER_STATUS_KEYS)) simulatedFooter.set(key, "package-status");
	assert.equal([...simulatedFooter.keys()].sort((left, right) => left.localeCompare(right)).at(-1), "agentmemory");
	const notifications = [];
	const widgets = [];
	const sentMessages = [];
	const ctx = {
		isIdle: () => true,
		abort: () => {},
		ui: {
			setStatus: setFooterStatus,
			setWidget: (...args) => widgets.push(args),
			notify: (...args) => notifications.push(args),
			theme: {
				fg: (color, text) => `\u001b[${colorCodes[color] ?? 0}m${text}\u001b[0m`,
			},
		},
	};
	const config = {
		...defaultVoiceConfig(),
		announceReady: false,
		transcriptCleanup: false,
	};
	const stopped = { audio: 0, stt: 0, tts: 0 };
	const runtime = new VoiceRuntime(
		{ sendUserMessage: (text) => sentMessages.push(text) },
		ctx,
		config,
		(phase) => syncVoiceStatus(ctx, phase),
		true,
	);
	runtime.stt = {
		reset: () => {},
		pushPcm: () => {},
		stop: () => stopped.stt++,
	};
	runtime.audio = {
		startPlayback: () => {},
		cancelPlayback: () => {},
		finishPlayback: () => {},
		stop: () => stopped.audio++,
	};
	runtime.tts = {
		cancelAll: () => {},
		pending: () => 0,
		stop: () => stopped.tts++,
	};

	runtime.handleSttEvent({ type: "ready" });
	assert.deepEqual(statuses.at(-1), [VOICE_STATUS_KEY, styled("success")], "idle listening must use the compact success mic");
	assert.deepEqual(orderedFooterKeys(), [VOICE_STATUS_KEY, "agentmemory"], "late-enabled voice must render before an earlier agentmemory status");
	assert.ok(visibleWidth(statuses.at(-1)[1]) <= 2, "voice status must remain compact on narrow terminals");

	runtime.handleSttEvent({ type: "interim", text: "hello" });
	assert.deepEqual(statuses.at(-1), [VOICE_STATUS_KEY, styled("accent")], "live transcription must become active");
	runtime.handleSttEvent({ type: "final", text: "hello pi" });
	await runtime.transcriptQueue;
	assert.deepEqual(sentMessages, ["hello pi"]);
	assert.deepEqual(statuses.at(-1), [VOICE_STATUS_KEY, styled("dim")], "submitted transcription must enter thinking state");

	runtime.setPhase("speaking");
	assert.deepEqual(statuses.at(-1), [VOICE_STATUS_KEY, styled("accent")], "speech playback must be active");
	runtime.playbackActive = true;
	runtime.handlePlaybackEnd();
	assert.deepEqual(statuses.at(-1), [VOICE_STATUS_KEY, styled("success")], "completed playback must return to idle listening");

	const originalConsoleError = console.error;
	const loggedErrors = [];
	console.error = (...args) => loggedErrors.push(args);
	try {
		runtime.fail("fixture failure");
	} finally {
		console.error = originalConsoleError;
	}
	assert.deepEqual(statuses.at(-1), [VOICE_STATUS_KEY, styled("error")], "runtime errors must use the error mic");
	assert.deepEqual(notifications.at(-1), ["voice: fixture failure", "error"]);
	assert.deepEqual(loggedErrors, [["voice: fixture failure"]]);

	runtime.stop();
	assert.deepEqual(statuses.at(-1), [VOICE_STATUS_KEY, undefined], "runtime cleanup must clear footer status");
	assert.deepEqual(orderedFooterKeys(), ["agentmemory"], "voice cleanup must preserve agentmemory while removing only voice");
	assert.deepEqual(stopped, { audio: 1, stt: 1, tts: 1 });
	assert.deepEqual(widgets.at(-1), ["voice-transcript", undefined]);

	const handlers = new Map();
	const footerCalls = [];
	const lifecycleStatuses = [];
	const setLifecycleStatus = (key, text) => {
		lifecycleStatuses.push([key, text]);
		if (text === undefined) footerStatuses.delete(key);
		else footerStatuses.set(key, text);
	};
	let terminalUnsubscribes = 0;
	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: () => {},
		registerShortcut: () => {},
	};
	voiceExtension(pi);
	const lifecycleCtx = {
		hasUI: true,
		mode: "tui",
		ui: {
			setStatus: setLifecycleStatus,
			setFooter: (...args) => footerCalls.push(args),
			onTerminalInput: () => () => terminalUnsubscribes++,
			theme: {
				fg: (color, text) => `\u001b[${colorCodes[color] ?? 0}m${text}\u001b[0m`,
			},
		},
	};
	footerStatuses.set(VOICE_STATUS_KEY, styled("dim"));
	await handlers.get("session_start")({ reason: "reload" }, lifecycleCtx);
	assert.deepEqual(lifecycleStatuses.at(-1), [VOICE_STATUS_KEY, undefined], "reload startup must clear stale voice status");
	assert.deepEqual(orderedFooterKeys(), ["agentmemory"]);
	assert.deepEqual(footerCalls, [], "voice must not replace Pi's footer");
	syncVoiceStatus(lifecycleCtx, "listening");
	assert.deepEqual(orderedFooterKeys(), [VOICE_STATUS_KEY, "agentmemory"], "voice enabled after reload must still sort first");
	await handlers.get("session_shutdown")({ reason: "quit" }, lifecycleCtx);
	assert.deepEqual(lifecycleStatuses.at(-1), [VOICE_STATUS_KEY, undefined], "shutdown must clear status through Pi's status API");
	assert.deepEqual(orderedFooterKeys(), ["agentmemory"]);
	assert.equal(terminalUnsubscribes, 1, "shutdown must retain terminal-input cleanup");
	assert.deepEqual(footerCalls, [], "shutdown must not touch a shared custom footer");

	console.log("[voice status test] passed");
} finally {
	await rm(output, { recursive: true, force: true });
}
