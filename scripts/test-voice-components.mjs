#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const agentDir = await mkdtemp(join(tmpdir(), "pi-voice-components-"));
const cacheDir = join(agentDir, "cache", "pi-voice");
const configPath = join(agentDir, "voice.json");
const sttPaths = [
	join(cacheDir, "src", "parakeet.cpp", "source"),
	join(cacheDir, "build", "parakeet", "build"),
	join(cacheDir, "models", "parakeet", "model.gguf"),
	join(cacheDir, "bin", "pi-voice-stt"),
	join(cacheDir, "bin", "libparakeet.dylib"),
];
const ttsPaths = [
	join(cacheDir, "venv", "bin", "python"),
	join(cacheDir, "models", "qwen3-tts-1.7b-custom-voice-6bit", "model.safetensors"),
	join(cacheDir, "bin", "pi-voice-tts"),
	join(cacheDir, "bin", "pi-voice-tts.py"),
];

async function create(paths) {
	for (const path of paths) {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "fixture");
	}
}

function uninstall(target) {
	const result = spawnSync(process.execPath, [join(root, "scripts", "uninstall-voice.mjs"), target], {
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		encoding: "utf8",
	});
	if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`.trim());
}

try {
	await writeFile(configPath, '{"inputMode":"always-on","ttsVoice":"Aiden"}\n');
	await create([...sttPaths, ...ttsPaths]);
	uninstall("stt");
	assert.ok(sttPaths.every((path) => !existsSync(path)));
	assert.ok(ttsPaths.every((path) => existsSync(path)));
	assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { inputMode: "external", ttsVoice: "Aiden" });

	await create(sttPaths);
	uninstall("tts");
	assert.ok(sttPaths.every((path) => existsSync(path)));
	assert.ok(ttsPaths.every((path) => !existsSync(path)));
	assert.ok(existsSync(configPath));

	await create(ttsPaths);
	uninstall("all");
	assert.equal(existsSync(cacheDir), false);
	assert.ok(existsSync(configPath));
	console.log("[voice component test] passed");
} finally {
	await rm(agentDir, { recursive: true, force: true });
}
