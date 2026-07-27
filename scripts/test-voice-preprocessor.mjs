#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".voice-cleanup-test-"));

try {
	const compile = spawnSync(
		join(root, "node_modules", ".bin", "tsc"),
		["--noEmit", "false", "--rootDir", ".", "--outDir", output],
		{ cwd: root, encoding: "utf8" },
	);
	if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`.trim());

	const cleanup = await import(pathToFileURL(join(output, "extensions", "voice", "transcript-cleanup.js")));
	const preprocessorModule = await import(
		pathToFileURL(join(output, "extensions", "voice", "transcript-preprocessor.js"))
	);
	const { cleanTranscriptDeterministically, preservesTechnicalText } = cleanup;
	const { TranscriptCleanupCancelled, TranscriptPreprocessor } = preprocessorModule;
	const ctx = {};
	const baseConfig = {
		transcriptCleanup: true,
		cleanupModel: "current",
		cleanupMinChars: 160,
		cleanupTimeoutMs: 2500,
	};

	const technical = 'Um, run `npm test` in ~/workspace/foo at version 1.2.3 and do not change "API_KEY" or WordPress.';
	const technicalCleaned = cleanTranscriptDeterministically(technical);
	assert.equal(
		technicalCleaned,
		'Run `npm test` in ~/workspace/foo at version 1.2.3 and do not change "API_KEY" or WordPress.',
	);
	assert.equal(preservesTechnicalText(technical, technicalCleaned), true);
	assert.equal(
		cleanTranscriptDeterministically(
			"Can you, um, inspect the login—the login component and, you know, don't rename loginHandler?",
		),
		"Can you inspect the login component and don't rename loginHandler?",
	);

	let shortModelCalls = 0;
	const short = new TranscriptPreprocessor(baseConfig, () => {}, async () => {
		shortModelCalls++;
		return "wrong";
	});
	assert.equal(await short.process("Uh, inspect src/auth/login.ts.", ctx), "Inspect src/auth/login.ts.");
	assert.equal(shortModelCalls, 0);

	const raw = "Um, please inspect src/auth/login.ts:42 and do not change API_KEY version 1.2.3 because the redirect repeats repeats.";
	let modelInput = "";
	const modeled = new TranscriptPreprocessor(
		{ ...baseConfig, cleanupMinChars: 1 },
		() => {},
		async (text) => {
			modelInput = text;
			return "Please inspect src/auth/login.ts:42 and do not change API_KEY version 1.2.3 because the redirect repeats.";
		},
	);
	assert.equal(
		await modeled.process(raw, ctx),
		"Please inspect src/auth/login.ts:42 and do not change API_KEY version 1.2.3 because the redirect repeats.",
	);
	assert.equal(modelInput.startsWith("Please inspect"), true);

	let fallbackReason = "";
	const unsafe = new TranscriptPreprocessor(
		{ ...baseConfig, cleanupMinChars: 1 },
		(message) => (fallbackReason = message),
		async () => "Inspect src/auth/session.ts:42 and change API_KEY version 2.0.",
	);
	assert.equal(await unsafe.process(raw, ctx), raw);
	assert.match(fallbackReason, /protected technical text/);

	const timedOut = new TranscriptPreprocessor(
		{ ...baseConfig, cleanupMinChars: 1, cleanupTimeoutMs: 20 },
		() => {},
		async () => new Promise(() => {}),
	);
	const started = performance.now();
	assert.equal(await timedOut.process(raw, ctx), raw);
	assert.ok(performance.now() - started < 1000);

	const cancelled = new TranscriptPreprocessor(
		{ ...baseConfig, cleanupMinChars: 1, cleanupTimeoutMs: 5000 },
		() => {},
		async () => new Promise(() => {}),
	);
	const pending = cancelled.process(raw, ctx);
	cancelled.cancel();
	await assert.rejects(pending, TranscriptCleanupCancelled);

	console.log("[voice cleanup test] passed");
} finally {
	await rm(output, { recursive: true, force: true });
}
