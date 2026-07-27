import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { VoiceConfig } from "./config.js";
import { BinaryFrameParser, makeFrame } from "./protocol.js";

const INPUT_SPEAK = 1;
const INPUT_CANCEL = 2;
const INPUT_SHUTDOWN = 3;
const OUTPUT_READY = 1;
const OUTPUT_AUDIO_START = 2;
const OUTPUT_AUDIO_CHUNK = 3;
const OUTPUT_AUDIO_DONE = 4;
const OUTPUT_ERROR = 5;

export interface TtsCallbacks {
	onReady: () => void;
	onAudioStart: (requestId: number, sampleRate: number) => void;
	onAudio: (requestId: number, pcm: Buffer) => void;
	onDone: (requestId: number) => void;
	onError: (message: string, requestId?: number) => void;
	onLog: (message: string) => void;
}

export class TtsClient {
	private child?: ChildProcessWithoutNullStreams;
	private readonly parser = new BinaryFrameParser();
	private readonly active = new Set<number>();
	private nextRequestId = 1;

	constructor(
		private readonly config: VoiceConfig,
		private readonly callbacks: TtsCallbacks,
	) {}

	start(): void {
		if (this.child) return;
		const args = [
			"--serve",
			"--model-name",
			this.config.ttsModelPath,
			"--ref-audio",
			this.config.referenceAudioPath,
			"--ref-text-file",
			this.config.referenceTextPath,
			"--language",
			this.config.language,
			"--output-sample-rate",
			"24000",
			"--blocksize",
			"4800",
			"--temperature",
			"0.7",
			"--top-k",
			"30",
		];
		const child = spawn(this.config.ttsWorkerPath, args, { stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split(/\r?\n/)) {
				if (line.trim()) this.callbacks.onLog(line.trim());
			}
		});
		child.once("error", (error) => this.callbacks.onError(error.message));
		child.once("exit", (code, signal) => {
			if (this.child === child) this.child = undefined;
			if (code !== 0) this.callbacks.onError(`TTS exited (${code ?? signal ?? "unknown"})`);
		});
	}

	speak(text: string): number {
		const id = this.nextRequestId++;
		this.active.add(id);
		this.write(makeFrame(INPUT_SPEAK, id, Buffer.from(text, "utf8")));
		return id;
	}

	cancelAll(): void {
		for (const id of this.active) this.write(makeFrame(INPUT_CANCEL, id));
	}

	pending(): number {
		return this.active.size;
	}

	stop(): void {
		if (!this.child) return;
		this.write(makeFrame(INPUT_SHUTDOWN, 0));
		this.child.kill();
		this.child = undefined;
		this.active.clear();
	}

	private write(frame: Buffer): void {
		if (this.child?.stdin.writable) this.child.stdin.write(frame);
	}

	private handleStdout(chunk: Buffer): void {
		let frames;
		try {
			frames = this.parser.push(chunk);
		} catch (error) {
			this.callbacks.onError(String(error));
			return;
		}
		for (const frame of frames) {
			if (frame.type === OUTPUT_READY) {
				this.callbacks.onReady();
				continue;
			}
			if (frame.type === OUTPUT_AUDIO_START) {
				const sampleRate = frame.payload.length >= 4 ? frame.payload.readUInt32LE(0) : 24000;
				this.callbacks.onAudioStart(frame.id, sampleRate);
				continue;
			}
			if (frame.type === OUTPUT_AUDIO_CHUNK) {
				this.callbacks.onAudio(frame.id, frame.payload);
				continue;
			}
			if (frame.type === OUTPUT_AUDIO_DONE) {
				this.active.delete(frame.id);
				this.callbacks.onDone(frame.id);
				continue;
			}
			if (frame.type === OUTPUT_ERROR) {
				this.active.delete(frame.id);
				this.callbacks.onError(frame.payload.toString("utf8"), frame.id || undefined);
			}
		}
	}
}
