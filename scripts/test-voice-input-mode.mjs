#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".voice-input-mode-test-"));

try {
	const compile = spawnSync(
		join(root, "node_modules", ".bin", "tsc"),
		["--noEmit", "false", "--rootDir", ".", "--outDir", output],
		{ cwd: root, encoding: "utf8" },
	);
	if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`.trim());

	const { defaultVoiceConfig } = await import(
		pathToFileURL(join(output, "extensions", "voice", "config.js"))
	);
	const { VoiceRuntime } = await import(
		pathToFileURL(join(output, "extensions", "voice", "runtime.js"))
	);

	function harness(inputMode, idle = true) {
		const messages = [];
		let aborts = 0;
		let pushedFrames = 0;
		const config = { ...defaultVoiceConfig(), inputMode, transcriptCleanup: false };
		const ctx = {
			isIdle: () => idle,
			abort: () => aborts++,
			ui: {
				setStatus: () => {},
				setWidget: () => {},
				notify: () => {},
				theme: { fg: (_color, text) => text },
			},
		};
		const runtime = new VoiceRuntime(
			{ sendUserMessage: (text) => messages.push(text) },
			ctx,
			config,
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
			get aborts() {
				return aborts;
			},
			get pushedFrames() {
				return pushedFrames;
			},
		};
	}

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

	const escaped = harness("always-on", false);
	escaped.runtime.phase = "speaking";
	escaped.runtime.playbackActive = true;
	const generationBeforeEscape = escaped.runtime.generation;
	escaped.runtime.onAssistantEnd(escaped.ctx, true);
	assert.equal(escaped.runtime.generation, generationBeforeEscape + 1);
	assert.equal(escaped.runtime.playbackActive, false);
	escaped.runtime.stop();

	console.log("[voice input-mode test] passed");
} finally {
	await rm(output, { recursive: true, force: true });
}
