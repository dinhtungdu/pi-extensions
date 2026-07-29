#!/usr/bin/env node

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/)/, homedir());
const agentDir = configuredAgentDir ? resolve(configuredAgentDir) : join(homedir(), ".pi", "agent");
const cacheDir = join(agentDir, "cache", "pi-voice");
const target = process.argv[2] ?? "all";

function log(message) {
	process.stdout.write(`[voice uninstall] ${message}\n`);
}

async function remove(paths) {
	for (const path of paths) {
		await rm(path, { recursive: true, force: true });
		log(`removed ${path}`);
	}
}

async function main() {
	if (target === "all") {
		await remove([cacheDir]);
	} else if (target === "stt") {
		await remove([
			join(cacheDir, "src", "parakeet.cpp"),
			join(cacheDir, "build", "parakeet"),
			join(cacheDir, "models", "parakeet"),
			join(cacheDir, "bin", "pi-voice-stt"),
			...[
				"libparakeet.dylib",
				"libggml.0.dylib",
				"libggml-base.0.dylib",
				"libggml-cpu.0.dylib",
				"libggml-blas.0.dylib",
			].map((name) => join(cacheDir, "bin", name)),
		]);
	} else if (target === "tts") {
		await remove([
			join(cacheDir, "venv"),
			join(cacheDir, "models", "qwen3-tts-1.7b-custom-voice-6bit"),
			join(cacheDir, "bin", "pi-voice-tts"),
			join(cacheDir, "bin", "pi-voice-tts.py"),
		]);
	} else {
		throw new Error("usage: uninstall-voice.mjs [stt|tts|all]");
	}
	log(`complete. Removed ${target}; configuration was preserved.`);
}

main().catch((error) => {
	console.error(`[voice uninstall] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exitCode = 1;
});
