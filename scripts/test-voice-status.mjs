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
	const notifications = [];
	const widgets = [];
	const sentMessages = [];
	const ctx = {
		isIdle: () => true,
		abort: () => {},
		ui: {
			setStatus: (...args) => statuses.push(args),
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
		inputMode: "always-on",
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
	assert.ok(visibleWidth(statuses.at(-1)[1]) <= 2, "voice status must remain compact on narrow terminals");

	runtime.setInputMode("push-to-talk");
	assert.deepEqual(statuses.at(-1), [VOICE_STATUS_KEY, styled("dim")], "idle push-to-talk must remain visible but subdued");
	assert.equal(runtime.armPushToTalk(), true);
	assert.deepEqual(statuses.at(-1), [VOICE_STATUS_KEY, styled("accent")], "armed capture must become active");
	runtime.handleSttEvent({ type: "interim", text: "hello" });
	assert.deepEqual(statuses.at(-1), [VOICE_STATUS_KEY, styled("accent")], "live transcription must remain active");
	runtime.handleSttEvent({ type: "final", text: "hello pi" });
	await runtime.transcriptQueue;
	assert.deepEqual(sentMessages, ["hello pi"]);
	assert.deepEqual(statuses.at(-1), [VOICE_STATUS_KEY, styled("dim")], "submitted transcription must enter thinking state");

	runtime.setInputMode("always-on");
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
	assert.deepEqual(stopped, { audio: 1, stt: 1, tts: 1 });
	assert.deepEqual(widgets.at(-1), ["voice-transcript", undefined]);

	const handlers = new Map();
	const footerCalls = [];
	const lifecycleStatuses = [];
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
			setStatus: (...args) => lifecycleStatuses.push(args),
			setFooter: (...args) => footerCalls.push(args),
			onTerminalInput: () => () => terminalUnsubscribes++,
		},
	};
	await handlers.get("session_start")({ reason: "startup" }, lifecycleCtx);
	assert.deepEqual(lifecycleStatuses.at(-1), [VOICE_STATUS_KEY, undefined], "session startup must clear stale voice status");
	assert.deepEqual(footerCalls, [], "voice must not replace Pi's footer");
	await handlers.get("session_shutdown")({ reason: "quit" }, lifecycleCtx);
	assert.deepEqual(lifecycleStatuses.at(-1), [VOICE_STATUS_KEY, undefined], "shutdown must clear status through Pi's status API");
	assert.equal(terminalUnsubscribes, 1, "shutdown must retain terminal-input cleanup");
	assert.deepEqual(footerCalls, [], "shutdown must not touch a shared custom footer");

	console.log("[voice status test] passed");
} finally {
	await rm(output, { recursive: true, force: true });
}
