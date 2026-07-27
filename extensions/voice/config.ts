import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type VoiceInputMode = "always-on" | "push-to-talk";

export interface VoiceConfig {
	enabled: boolean;
	announceReady: boolean;
	inputMode: VoiceInputMode;
	inputDevice: string;
	ffmpegPath: string;
	ffplayPath: string;
	sttWorkerPath: string;
	sttModelPath: string;
	ttsWorkerPath: string;
	ttsModelPath: string;
	ttsVoice: string;
	ttsInstruction: string;
	language: string;
	micThreshold: number;
	residualThreshold: number;
	bargeInFrames: number;
	maxEchoDelayMs: number;
	maxSpokenCharacters: number;
	transcriptCleanup: boolean;
	cleanupModel: string;
	cleanupMinChars: number;
	cleanupTimeoutMs: number;
}

const CONFIG_FILE = "voice.json";

export function voiceCacheDir(): string {
	return join(getAgentDir(), "cache", "pi-voice");
}

export function voiceConfigPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

export function defaultVoiceConfig(): VoiceConfig {
	const cache = voiceCacheDir();
	return {
		enabled: false,
		announceReady: true,
		inputMode: "always-on",
		inputDevice: "default",
		ffmpegPath: "ffmpeg",
		ffplayPath: "ffplay",
		sttWorkerPath: join(cache, "bin", "pi-voice-stt"),
		sttModelPath: join(cache, "models", "parakeet", "realtime_eou_120m-v1-q8_0.gguf"),
		ttsWorkerPath: join(cache, "bin", "pi-voice-tts"),
		ttsModelPath: join(cache, "models", "qwen3-tts-1.7b-custom-voice-6bit"),
		ttsVoice: "Aiden",
		ttsInstruction: "Speak naturally in a calm, conversational tone.",
		language: "english",
		micThreshold: 0.006,
		residualThreshold: 0.62,
		bargeInFrames: 5,
		maxEchoDelayMs: 2500,
		maxSpokenCharacters: 800,
		transcriptCleanup: false,
		cleanupModel: "current",
		cleanupMinChars: 160,
		cleanupTimeoutMs: 2500,
	};
}

function jsonObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch (error) {
		console.error(`voice: failed to read ${path}: ${String(error)}`);
		return {};
	}
}

export function loadVoiceConfig(): VoiceConfig {
	const defaults = defaultVoiceConfig();
	const raw = jsonObject(voiceConfigPath());
	const config = { ...defaults };
	for (const key of Object.keys(defaults) as Array<keyof VoiceConfig>) {
		const value = raw[key];
		if (typeof defaults[key] === "boolean" && typeof value === "boolean") {
			(config as Record<string, unknown>)[key] = value;
		} else if (typeof defaults[key] === "string" && typeof value === "string" && value.trim()) {
			(config as Record<string, unknown>)[key] = value.trim();
		} else if (typeof defaults[key] === "number" && typeof value === "number" && Number.isFinite(value)) {
			(config as Record<string, unknown>)[key] = value;
		}
	}
	if (config.inputMode !== "always-on" && config.inputMode !== "push-to-talk") {
		config.inputMode = defaults.inputMode;
	}
	return config;
}

export function updateVoiceConfig(patch: Partial<VoiceConfig>): string {
	const path = voiceConfigPath();
	const current = jsonObject(path);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...current, ...patch }, null, "\t")}\n`, "utf8");
	return path;
}

export function missingRuntimeFiles(config: VoiceConfig): string[] {
	return [
		config.sttWorkerPath,
		config.sttModelPath,
		config.ttsWorkerPath,
		join(config.ttsModelPath, "config.json"),
		join(config.ttsModelPath, "model.safetensors"),
		join(config.ttsModelPath, "speech_tokenizer", "model.safetensors"),
	].filter((path) => !existsSync(path));
}
