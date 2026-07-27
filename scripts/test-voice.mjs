#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/)/, homedir());
const agentDir = configuredAgentDir ? resolve(configuredAgentDir) : join(homedir(), ".pi", "agent");
const root = join(agentDir, "cache", "pi-voice");
const paths = {
	tts: join(root, "bin", "pi-voice-tts"),
	ttsModel: join(root, "models", "qwen3-tts-1.7b-custom-voice-6bit"),
	stt: join(root, "bin", "pi-voice-stt"),
	sttModel: join(root, "models", "parakeet", "realtime_eou_120m-v1-q8_0.gguf"),
};

for (const path of Object.values(paths)) {
	if (!existsSync(path)) throw new Error(`voice self-test missing ${path}; run npm run setup:voice`);
}

function ttsFrame(type, id, payload = Buffer.alloc(0)) {
	const header = Buffer.allocUnsafe(9);
	header.writeUInt8(type, 0);
	header.writeUInt32LE(id, 1);
	header.writeUInt32LE(payload.length, 5);
	return Buffer.concat([header, payload]);
}

function sttFrame(type, payload = Buffer.alloc(0)) {
	const header = Buffer.allocUnsafe(5);
	header.writeUInt8(type, 0);
	header.writeUInt32LE(payload.length, 1);
	return Buffer.concat([header, payload]);
}

async function synthesize(text) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(paths.tts, [
			"--serve",
			"--model-name",
			paths.ttsModel,
			"--voice",
			"Aiden",
			"--instruct",
			"Speak naturally in a calm, conversational tone.",
			"--language",
			"english",
		]);
		let buffered = Buffer.alloc(0);
		let stderr = "";
		const audio = [];
		child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
		child.stdout.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 9) {
				const type = buffered.readUInt8(0);
				const id = buffered.readUInt32LE(1);
				const length = buffered.readUInt32LE(5);
				if (buffered.length < 9 + length) return;
				const payload = Buffer.from(buffered.subarray(9, 9 + length));
				buffered = buffered.subarray(9 + length);
				if (type === 1) child.stdin.write(ttsFrame(1, 1, Buffer.from(text)));
				if (type === 3) audio.push(payload);
				if (type === 4 && id === 1) {
					child.stdin.write(ttsFrame(3, 0));
					resolvePromise(Buffer.concat(audio));
				}
				if (type === 5) reject(new Error(`TTS self-test failed: ${payload.toString("utf8")}`));
			}
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) reject(new Error(`TTS exited ${code}: ${stderr.slice(-2000)}`));
		});
	});
}

async function transcribe(pcm) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(paths.stt, [paths.sttModel]);
		let stdout = "";
		let stderr = "";
		let sent = false;
		child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
			while (true) {
				const newline = stdout.indexOf("\n");
				if (newline < 0) break;
				const line = stdout.slice(0, newline).trim();
				stdout = stdout.slice(newline + 1);
				if (!line) continue;
				const event = JSON.parse(line);
				if (event.type === "ready" && !sent) {
					sent = true;
					const withSilence = Buffer.concat([pcm, Buffer.alloc(16000 * 2 * 2)]);
					for (let offset = 0; offset < withSilence.length; offset += 640) {
						child.stdin.write(sttFrame(1, withSilence.subarray(offset, offset + 640)));
					}
				}
				if (event.type === "final") {
					child.stdin.write(sttFrame(3));
					resolvePromise(String(event.text));
				}
				if (event.type === "error") reject(new Error(`STT self-test failed: ${event.message}`));
			}
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) reject(new Error(`STT exited ${code}: ${stderr.slice(-2000)}`));
		});
	});
}

const phrase = "Voice system ready for local coding.";
console.log("[voice test] synthesizing");
const audio = await synthesize(phrase);
if (!audio.length) throw new Error("TTS produced no PCM");
console.log(`[voice test] transcribing ${(audio.length / 2 / 24000).toFixed(2)} seconds of PCM`);
const transcript = await transcribe(audio);
console.log(`[voice test] transcript: ${transcript}`);
if (!/voice system ready for local coding/i.test(transcript)) {
	throw new Error(`unexpected transcript: ${transcript}`);
}
console.log("[voice test] passed");
