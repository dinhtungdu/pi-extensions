#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".voice-input-mode-test-"));

try {
	const compile = spawnSync(
		join(root, "node_modules", ".bin", "tsc"),
		["--noEmit", "false", "--rootDir", ".", "--outDir", output],
		{ cwd: root, encoding: "utf8" },
	);
	if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`.trim());

	const { defaultVoiceConfig, missingRuntimeFiles } = await import(
		pathToFileURL(join(output, "extensions", "voice", "config.js"))
	);
	const { VoiceRuntime } = await import(
		pathToFileURL(join(output, "extensions", "voice", "runtime.js"))
	);
	const { renderTwoLineFooter } = await import(
		pathToFileURL(join(output, "extensions", "voice", "footer.js"))
	);
	const { voiceResponseSystemPrompt } = await import(
		pathToFileURL(join(output, "extensions", "voice", "response-style.js"))
	);

	const defaults = defaultVoiceConfig();
	assert.equal("enabled" in defaults, false, "voice activation must remain session-scoped");
	assert.equal(defaults.maxSpokenCharacters, 400);
	assert.equal(missingRuntimeFiles(defaults).includes(defaults.sttWorkerPath), false);
	assert.equal(missingRuntimeFiles(defaults, ["stt"]).includes(defaults.sttWorkerPath), true);

	const writtenPrompt = "Base coding-agent instructions.";
	assert.equal(voiceResponseSystemPrompt(writtenPrompt, false), undefined);
	const spokenPrompt = voiceResponseSystemPrompt(writtenPrompt, true);
	assert.ok(spokenPrompt?.startsWith(writtenPrompt));
	assert.match(spokenPrompt, /response will be read aloud/i);
	assert.match(spokenPrompt, /concise, natural conversational sentences/i);

	const footerLines = renderTwoLineFooter(
		{
			render: (width) => [
				"~/workspace/pi-extensions".slice(0, width),
				"usage                 model".slice(0, width),
				"goal active",
			],
		},
		32,
		" • fast • mic",
	);
	assert.equal(footerLines.length, 2, "voice footer must stay two lines");
	assert.match(footerLines[0], /goal active$/);
	assert.match(footerLines[1], / • fast • mic$/);
	assert.ok(footerLines.every((line) => visibleWidth(line) <= 32));
	const narrowFooterLines = renderTwoLineFooter(
		{ render: () => ["project", "model", "long status"] },
		8,
		" • mic",
	);
	assert.equal(narrowFooterLines.length, 2);
	assert.ok(narrowFooterLines.every((line) => visibleWidth(line) <= 8));

	function harness(inputMode, idle = true, sttEnabled = true) {
		const messages = [];
		let aborts = 0;
		let pushedFrames = 0;
		const statuses = [];
		const config = { ...defaultVoiceConfig(), inputMode, transcriptCleanup: false };
		const ctx = {
			isIdle: () => idle,
			abort: () => aborts++,
			ui: {
				setStatus: (...args) => statuses.push(args),
				setWidget: () => {},
				notify: () => {},
				theme: { fg: (_color, text) => text },
			},
		};
		const runtime = new VoiceRuntime(
			{ sendUserMessage: (text) => messages.push(text) },
			ctx,
			config,
			undefined,
			sttEnabled,
		);
		runtime.stt = {
			reset: () => {},
			pushPcm: () => pushedFrames++,
			stop: () => {},
		};
		runtime.sttReady = true;
		return {
			runtime,
			ctx,
			messages,
			statuses,
			get aborts() {
				return aborts;
			},
			get pushedFrames() {
				return pushedFrames;
			},
		};
	}

	const ttsOnly = harness("always-on", true, false);
	let ttsOnlySttStarts = 0;
	let ttsOnlyCaptureStarts = 0;
	let ttsOnlyTtsStarts = 0;
	ttsOnly.runtime.stt = {
		start: () => ttsOnlySttStarts++,
		reset: () => {},
		pushPcm: () => {},
		stop: () => {},
	};
	ttsOnly.runtime.audio = {
		startCapture: () => ttsOnlyCaptureStarts++,
		stopCapture: () => {},
		cancelPlayback: () => {},
		stop: () => {},
	};
	ttsOnly.runtime.tts = {
		start: () => ttsOnlyTtsStarts++,
		stop: () => {},
		cancelAll: () => {},
		pending: () => 0,
	};
	ttsOnly.runtime.start();
	assert.equal(ttsOnlySttStarts, 0);
	assert.equal(ttsOnlyCaptureStarts, 0);
	assert.equal(ttsOnlyTtsStarts, 1);
	assert.match(ttsOnly.runtime.status(), /microphone=disabled/);
	assert.match(ttsOnly.runtime.status(), /STT=not installed/);
	assert.equal(ttsOnly.runtime.armPushToTalk(), false);
	ttsOnly.runtime.stop();

	const pushToTalk = harness("push-to-talk");
	pushToTalk.runtime.handleMicFrame(Buffer.alloc(640));
	pushToTalk.runtime.handleSttEvent({ type: "interim", text: "background speech" });
	assert.equal(pushToTalk.pushedFrames, 0);
	assert.deepEqual(pushToTalk.messages, []);

	assert.equal(pushToTalk.runtime.armPushToTalk(), true);
	pushToTalk.runtime.handleMicFrame(Buffer.alloc(640));
	assert.equal(pushToTalk.pushedFrames, 1);
	pushToTalk.runtime.handleSttEvent({ type: "final", text: "intentional request" });
	await pushToTalk.runtime.transcriptQueue;
	assert.deepEqual(pushToTalk.messages, ["intentional request"]);
	pushToTalk.runtime.handleMicFrame(Buffer.alloc(640));
	assert.equal(pushToTalk.pushedFrames, 1);
	pushToTalk.runtime.stop();
	assert.deepEqual(pushToTalk.statuses, [], "voice must not add a third footer line");

	const busyPushToTalk = harness("push-to-talk", false);
	assert.equal(busyPushToTalk.runtime.armPushToTalk(), false);
	busyPushToTalk.runtime.handleMicFrame(Buffer.alloc(640));
	busyPushToTalk.runtime.handleSttEvent({ type: "final", text: "voice interruption" });
	await busyPushToTalk.runtime.transcriptQueue;
	assert.equal(busyPushToTalk.pushedFrames, 0);
	assert.equal(busyPushToTalk.aborts, 0);
	assert.deepEqual(busyPushToTalk.messages, []);
	busyPushToTalk.runtime.stop();

	const alwaysOn = harness("always-on", false);
	alwaysOn.runtime.phase = "thinking";
	alwaysOn.runtime.handleMicFrame(Buffer.alloc(640));
	alwaysOn.runtime.handleSttEvent({ type: "interim", text: "pi stop" });
	alwaysOn.runtime.handleSttEvent({ type: "final", text: "pi stop" });
	await alwaysOn.runtime.transcriptQueue;
	assert.equal(alwaysOn.pushedFrames, 0);
	assert.equal(alwaysOn.aborts, 0);
	assert.deepEqual(alwaysOn.messages, []);

	alwaysOn.runtime.phase = "speaking";
	alwaysOn.runtime.handleMicFrame(Buffer.alloc(640));
	alwaysOn.runtime.handleSttEvent({ type: "interim", text: "speaker echo" });
	alwaysOn.runtime.handleSttEvent({ type: "final", text: "speaker echo" });
	await alwaysOn.runtime.transcriptQueue;
	assert.equal(alwaysOn.pushedFrames, 0);
	assert.equal(alwaysOn.aborts, 0);
	assert.deepEqual(alwaysOn.messages, []);

	// Even a recognition result racing with active work is queued, never used to abort it.
	alwaysOn.runtime.phase = "listening";
	alwaysOn.runtime.handleSttEvent({ type: "final", text: "late transcript" });
	await alwaysOn.runtime.transcriptQueue;
	assert.equal(alwaysOn.aborts, 0);
	assert.equal(alwaysOn.runtime.pendingTranscript, "late transcript");

	// Explicit keyboard/command paths still stop speech and abort active work.
	alwaysOn.runtime.interruptSpeech("keyboard interrupt", true);
	assert.equal(alwaysOn.aborts, 1);
	alwaysOn.runtime.stop();

	const escaped = harness("always-on", true);
	escaped.runtime.phase = "speaking";
	escaped.runtime.playbackActive = true;
	const generationBeforeEscape = escaped.runtime.generation;
	escaped.runtime.onTerminalInput("x");
	assert.equal(escaped.runtime.generation, generationBeforeEscape);
	assert.equal(escaped.runtime.playbackActive, true);
	escaped.runtime.onTerminalInput("\x1b");
	assert.equal(escaped.runtime.generation, generationBeforeEscape + 1);
	assert.equal(escaped.runtime.playbackActive, false);
	assert.equal(escaped.aborts, 0, "Pi's non-consuming Escape handler remains responsible for agent aborts");
	escaped.runtime.stop();

	console.log("[voice input-mode test] passed");
} finally {
	await rm(output, { recursive: true, force: true });
}
