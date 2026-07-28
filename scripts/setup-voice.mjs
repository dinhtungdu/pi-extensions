#!/usr/bin/env node

import { createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const PARAKEET_REPO = "https://github.com/mudler/parakeet.cpp.git";
const PARAKEET_COMMIT = "1da853421de9710cbe894a0110711de5a0516486";
const MLX_AUDIO_VERSION = "0.4.6";
const STT_MODEL_REPO = "mudler/parakeet-cpp-gguf";
const STT_MODEL_FILE = "realtime_eou_120m-v1-q8_0.gguf";
const TTS_MODEL_REPO = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit";
const TTS_MODEL_FILES = [
	"config.json",
	"generation_config.json",
	"merges.txt",
	"model.safetensors",
	"model.safetensors.index.json",
	"preprocessor_config.json",
	"speech_tokenizer/config.json",
	"speech_tokenizer/configuration.json",
	"speech_tokenizer/model.safetensors",
	"speech_tokenizer/preprocessor_config.json",
	"tokenizer_config.json",
	"vocab.json",
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/)/, homedir());
const agentDir = configuredAgentDir ? resolve(configuredAgentDir) : join(homedir(), ".pi", "agent");
const cacheDir = join(agentDir, "cache", "pi-voice");
const sourceDir = join(cacheDir, "src");
const buildDir = join(cacheDir, "build");
const binDir = join(cacheDir, "bin");
const modelDir = join(cacheDir, "models");
const args = new Set(process.argv.slice(2));
const sttEnabled = !args.has("--tts-only");
const ttsEnabled = !args.has("--stt-only");
const downloadModels = !args.has("--build-only");

function log(message) {
	process.stdout.write(`[voice setup] ${message}\n`);
}

async function run(command, commandArgs, options = {}) {
	log(`${command} ${commandArgs.join(" ")}`);
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, commandArgs, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => (stdout += chunk.toString("utf8")));
		child.stderr?.on("data", (chunk) => (stderr += chunk.toString("utf8")));
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolvePromise({ stdout, stderr });
			else reject(new Error(`${command} failed (${code ?? signal ?? "unknown"})${stderr ? `: ${stderr.trim()}` : ""}`));
		});
	});
}

async function requireCommand(command, installHint) {
	try {
		await run("/usr/bin/which", [command], { capture: true });
	} catch {
		throw new Error(`missing ${command}; ${installHint}`);
	}
}

async function usableFile(path) {
	try {
		return (await stat(path)).size > 0;
	} catch {
		return false;
	}
}

async function clonePinned(repo, commit, destination) {
	if (!existsSync(join(destination, ".git"))) {
		await rm(destination, { recursive: true, force: true });
		await run("git", ["clone", "--recursive", repo, destination]);
	}
	await run("git", ["fetch", "origin", commit], { cwd: destination });
	await run("git", ["checkout", "--detach", commit], { cwd: destination });
	await run("git", ["submodule", "update", "--init", "--recursive"], { cwd: destination });
}

function hfUrl(repo, file) {
	return `https://huggingface.co/${repo}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;
}

async function download(url, destination, label) {
	if (await usableFile(destination)) return;
	await mkdir(dirname(destination), { recursive: true });
	const temporary = `${destination}.partial`;
	for (let attempt = 1; attempt <= 5; attempt++) {
		try {
			const downloadedBytes = (await usableFile(temporary)) ? (await stat(temporary)).size : 0;
			log(`${downloadedBytes ? "resuming" : "downloading"} ${label}`);
			const response = await fetch(url, {
				redirect: "follow",
				headers: downloadedBytes ? { Range: `bytes=${downloadedBytes}-` } : {},
			});
			if (response.status === 416 && downloadedBytes) {
				const total = Number(response.headers.get("content-range")?.match(/\*\/(\d+)/)?.[1]);
				if (total === downloadedBytes) {
					await rename(temporary, destination);
					return;
				}
			}
			if (!response.ok || !response.body) {
				throw new Error(`HTTP ${response.status}`);
			}
			const append = downloadedBytes > 0 && response.status === 206;
			await pipeline(
				Readable.fromWeb(response.body),
				createWriteStream(temporary, { flags: append ? "a" : "w" }),
			);
			await rename(temporary, destination);
			const sizeMiB = (await stat(destination)).size / 1024 / 1024;
			log(`downloaded ${label} (${sizeMiB.toFixed(1)} MiB)`);
			return;
		} catch (error) {
			if (attempt === 5) throw new Error(`download failed for ${label}: ${String(error)}`);
			log(`download interrupted; retrying ${label} (${attempt}/5)`);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 1000));
		}
	}
}

async function findFile(root, name) {
	const result = await run("find", [root, "-name", name, "-print", "-quit"], { capture: true });
	const path = result.stdout.trim();
	if (!path) throw new Error(`${name} not found under ${root}`);
	return path;
}

async function buildStt() {
	const source = join(sourceDir, "parakeet.cpp");
	const build = join(buildDir, "parakeet");
	await clonePinned(PARAKEET_REPO, PARAKEET_COMMIT, source);
	await run("cmake", [
		"-S",
		source,
		"-B",
		build,
		"-DCMAKE_BUILD_TYPE=Release",
		"-DPARAKEET_SHARED=ON",
		"-DPARAKEET_BUILD_CLI=OFF",
		"-DPARAKEET_BUILD_SERVER=OFF",
		"-DPARAKEET_BUILD_TESTS=OFF",
		"-DPARAKEET_GGML_METAL=OFF",
	]);
	await run("cmake", ["--build", build, "--config", "Release", "--target", "parakeet", "-j"]);
	const library = await findFile(build, "libparakeet.dylib");
	const installedLibrary = join(binDir, "libparakeet.dylib");
	await copyFile(library, installedLibrary);
	await run("install_name_tool", ["-id", "@rpath/libparakeet.dylib", installedLibrary]);
	for (const name of [
		"libggml.0.dylib",
		"libggml-base.0.dylib",
		"libggml-cpu.0.dylib",
		"libggml-blas.0.dylib",
	]) {
		await copyFile(await findFile(build, name), join(binDir, name));
	}
	const worker = join(binDir, "pi-voice-stt");
	await run("c++", [
		"-std=c++17",
		"-O3",
		"-Wall",
		"-Wextra",
		"-Wpedantic",
		join(projectRoot, "native", "voice-stt", "main.cpp"),
		"-I",
		join(source, "include"),
		"-L",
		binDir,
		"-lparakeet",
		"-Wl,-rpath,@loader_path",
		"-o",
		worker,
	]);
	await chmod(worker, 0o755);
	log(`built ${worker}`);
	if (downloadModels) {
		await download(
			hfUrl(STT_MODEL_REPO, STT_MODEL_FILE),
			join(modelDir, "parakeet", STT_MODEL_FILE),
			`${STT_MODEL_REPO}/${STT_MODEL_FILE}`,
		);
	}
}

async function buildTts() {
	const environment = join(cacheDir, "venv");
	const python = join(environment, "bin", "python");
	if (!(await usableFile(python))) await run("uv", ["venv", "--python", "3.12", environment]);
	await run("uv", ["pip", "install", "--python", python, `mlx-audio==${MLX_AUDIO_VERSION}`]);
	const pythonWorker = join(binDir, "pi-voice-tts.py");
	await copyFile(join(projectRoot, "native", "voice-tts", "worker.py"), pythonWorker);
	const worker = join(binDir, "pi-voice-tts");
	await writeFile(worker, `#!/bin/sh\nexec "${python}" "${pythonWorker}" "$@"\n`, "utf8");
	await chmod(worker, 0o755);
	log(`installed ${worker}`);

	if (downloadModels) {
		const destination = join(modelDir, "qwen3-tts-1.7b-custom-voice-6bit");
		for (const file of TTS_MODEL_FILES) {
			await download(hfUrl(TTS_MODEL_REPO, file), join(destination, file), `${TTS_MODEL_REPO}/${file}`);
		}
	}
}

async function main() {
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		throw new Error("voice setup currently requires Apple Silicon macOS");
	}
	await mkdir(binDir, { recursive: true });
	await mkdir(modelDir, { recursive: true });
	if (sttEnabled) await requireCommand("ffmpeg", "run: brew install ffmpeg");
	if (ttsEnabled) await requireCommand("ffplay", "run: brew install ffmpeg");
	if (sttEnabled) {
		await requireCommand("git", "install Xcode command line tools");
		await requireCommand("cmake", "run: brew install cmake");
		await requireCommand("c++", "install Xcode command line tools");
	}
	if (ttsEnabled) await requireCommand("uv", "install uv from https://docs.astral.sh/uv/");
	if (sttEnabled) await buildStt();
	if (ttsEnabled) await buildTts();
	log("complete. Run /voice device, then /voice on.");
}

main().catch((error) => {
	console.error(`[voice setup] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exitCode = 1;
});
