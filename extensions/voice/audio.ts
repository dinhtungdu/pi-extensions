import { spawn, type ChildProcess } from "node:child_process";
import type { VoiceConfig } from "./config.js";

const CAPTURE_SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_BYTES = (CAPTURE_SAMPLE_RATE * FRAME_MS * 2) / 1000;

export class AudioIO {
	private capture?: ChildProcess;
	private captureBuffer: Buffer = Buffer.alloc(0);
	private playback?: ChildProcess;
	private playbackGeneration = 0;

	constructor(
		private readonly config: VoiceConfig,
		private readonly onMicFrame: (pcm: Buffer) => void,
		private readonly onPlaybackEnd: () => void,
		private readonly onError: (message: string) => void,
	) {}

	startCapture(): void {
		if (this.capture) return;
		const input = `:${this.config.inputDevice}`;
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-thread_queue_size",
			"512",
			"-f",
			"avfoundation",
			"-i",
			input,
			"-vn",
			"-ac",
			"1",
			"-ar",
			String(CAPTURE_SAMPLE_RATE),
			"-f",
			"s16le",
			"pipe:1",
		];
		const child = spawn(this.config.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		this.capture = child;
		child.stdout?.on("data", (chunk: Buffer) => this.handleCapture(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			const message = chunk.toString("utf8").trim();
			if (message) this.onError(`microphone: ${message}`);
		});
		child.once("error", (error) => this.onError(`microphone: ${error.message}`));
		child.once("exit", (code, signal) => {
			if (this.capture === child) this.capture = undefined;
			if (code !== 0 && signal !== "SIGTERM") this.onError(`microphone exited (${code ?? signal ?? "unknown"})`);
		});
	}

	startPlayback(sampleRate: number): void {
		if (this.playback) return;
		const generation = ++this.playbackGeneration;
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-nodisp",
			"-autoexit",
			"-f",
			"s16le",
			"-ar",
			String(sampleRate),
			"-ch_layout",
			"mono",
			"pipe:0",
		];
		const child = spawn(this.config.ffplayPath, args, { stdio: ["pipe", "ignore", "pipe"] });
		this.playback = child;
		let playbackError = "";
		child.stderr?.on("data", (chunk: Buffer) => (playbackError += chunk.toString("utf8")));
		child.once("error", (error) => this.onError(`speaker: ${error.message}`));
		child.once("exit", (code, signal) => {
			if (this.playback === child) this.playback = undefined;
			if (generation !== this.playbackGeneration) return;
			if (code !== 0 && signal !== "SIGTERM") {
				this.onError(`speaker exited (${code ?? signal ?? "unknown"}): ${playbackError.trim()}`);
			}
			this.onPlaybackEnd();
		});
	}

	writePlayback(pcm: Buffer): void {
		if (this.playback?.stdin?.writable) this.playback.stdin.write(pcm);
	}

	finishPlayback(): void {
		if (this.playback?.stdin?.writable) this.playback.stdin.end();
		else this.onPlaybackEnd();
	}

	cancelPlayback(): void {
		this.playbackGeneration++;
		this.playback?.kill("SIGTERM");
		this.playback = undefined;
	}

	stop(): void {
		this.cancelPlayback();
		this.capture?.kill("SIGTERM");
		this.capture = undefined;
		this.captureBuffer = Buffer.alloc(0);
	}

	private handleCapture(chunk: Buffer): void {
		this.captureBuffer = this.captureBuffer.length ? Buffer.concat([this.captureBuffer, chunk]) : chunk;
		while (this.captureBuffer.length >= FRAME_BYTES) {
			const frame = Buffer.from(this.captureBuffer.subarray(0, FRAME_BYTES));
			this.captureBuffer = this.captureBuffer.subarray(FRAME_BYTES);
			this.onMicFrame(frame);
		}
	}
}

export const AUDIO_SAMPLE_RATE = CAPTURE_SAMPLE_RATE;
