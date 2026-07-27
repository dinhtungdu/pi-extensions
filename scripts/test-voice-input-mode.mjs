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

	pushToTalk.runtime.armPushToTalk();
	pushToTalk.runtime.handleMicFrame(Buffer.alloc(640));
	assert.equal(pushToTalk.pushedFrames, 1);
	pushToTalk.runtime.handleSttEvent({ type: "final", text: "intentional request" });
	await pushToTalk.runtime.transcriptQueue;
	assert.deepEqual(pushToTalk.messages, ["intentional request"]);
	pushToTalk.runtime.handleMicFrame(Buffer.alloc(640));
	assert.equal(pushToTalk.pushedFrames, 1);
	pushToTalk.runtime.stop();

	const busyPushToTalk = harness("push-to-talk", false);
	busyPushToTalk.runtime.armPushToTalk();
	assert.equal(busyPushToTalk.aborts, 0);
	busyPushToTalk.runtime.handleSttEvent({ type: "final", text: "intentional interruption" });
	await busyPushToTalk.runtime.transcriptQueue;
	assert.equal(busyPushToTalk.aborts, 1);
	busyPushToTalk.runtime.stop();

	const alwaysOn = harness("always-on", false);
	alwaysOn.runtime.phase = "thinking";
	alwaysOn.runtime.detector = {
		observe: () => true,
		preroll: () => Buffer.alloc(0),
		reset: () => {},
	};
	alwaysOn.runtime.handleMicFrame(Buffer.alloc(640));
	assert.equal(alwaysOn.runtime.phase, "thinking");
	assert.equal(alwaysOn.aborts, 0);
	alwaysOn.runtime.handleSttEvent({ type: "interim", text: "background conversation" });
	alwaysOn.runtime.handleSttEvent({ type: "final", text: "background conversation" });
	await alwaysOn.runtime.transcriptQueue;
	assert.equal(alwaysOn.aborts, 0);
	assert.deepEqual(alwaysOn.messages, []);

	alwaysOn.runtime.handleBargeIn();
	assert.equal(alwaysOn.aborts, 0);
	alwaysOn.runtime.handleSttEvent({ type: "final", text: "confirmed interruption" });
	await alwaysOn.runtime.transcriptQueue;
	assert.equal(alwaysOn.aborts, 1);
	alwaysOn.runtime.stop();

	console.log("[voice input-mode test] passed");
} finally {
	await rm(output, { recursive: true, force: true });
}
