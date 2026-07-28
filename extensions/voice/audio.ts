import { spawn, type ChildProcess } from "node:child_process";
import type { VoiceConfig } from "./config.js";

const CAPTURE_SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_BYTES = (CAPTURE_SAMPLE_RATE * FRAME_MS * 2) / 1000;
const CAPTURE_RETRY_MS = 1000;

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

export class AudioIO {
	private capture?: ChildProcess;
	private captureBuffer: Buffer = Buffer.alloc(0);
	private captureRetry?: ReturnType<typeof setTimeout>;
	private captureRequested = false;
	private captureAvailable?: boolean;
	private playback?: ChildProcess;
	private playbackGeneration = 0;

	constructor(
		private readonly config: VoiceConfig,
		private readonly onMicFrame: (pcm: Buffer) => void,
		private readonly onPlaybackEnd: () => void,
		private readonly onError: (message: string) => void,
		private readonly onCaptureState: (available: boolean, message?: string) => void,
	) {}

	startCapture(): void {
		this.captureRequested = true;
		if (this.capture || this.captureRetry) return;
		this.spawnCapture();
	}

	private spawnCapture(): void {
		if (!this.captureRequested || this.capture) return;
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
		let stderr = "";
		let spawnError: Error | undefined;
		child.stdout?.on("data", (chunk: Buffer) => {
			this.reportCaptureState(true);
			this.handleCapture(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
		});
		child.once("error", (error) => (spawnError = error));
		child.once("close", (code, signal) => {
			if (this.capture !== child) return;
			this.capture = undefined;
			this.captureBuffer = Buffer.alloc(0);
			if (!this.captureRequested) return;
			if (spawnError && errorCode(spawnError) === "ENOENT") {
				this.captureRequested = false;
				this.onError(`microphone: ${spawnError.message}`);
				return;
			}
			const detail = spawnError?.message ?? (stderr.trim() || `capture exited (${code ?? signal ?? "unknown"})`);
			this.reportCaptureState(false, detail);
			this.captureRetry = setTimeout(() => {
				this.captureRetry = undefined;
				this.spawnCapture();
			}, CAPTURE_RETRY_MS);
		});
	}

	private reportCaptureState(available: boolean, message?: string): void {
		if (this.captureAvailable === available) return;
		this.captureAvailable = available;
		this.onCaptureState(available, message);
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
		child.stdin?.on("error", (error) => {
			if (generation === this.playbackGeneration && errorCode(error) !== "EPIPE") {
				this.onError(`speaker input: ${String(error)}`);
			}
		});
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
		const input = this.playback?.stdin;
		if (!input?.writable || input.destroyed || input.writableEnded) return;
		try {
			input.write(pcm);
		} catch (error) {
			if (errorCode(error) !== "EPIPE") this.onError(`speaker input: ${String(error)}`);
		}
	}

	finishPlayback(): void {
		const input = this.playback?.stdin;
		if (!input?.writable || input.destroyed || input.writableEnded) {
			this.onPlaybackEnd();
			return;
		}
		try {
			input.end();
		} catch (error) {
			if (errorCode(error) !== "EPIPE") this.onError(`speaker input: ${String(error)}`);
			this.onPlaybackEnd();
		}
	}

	cancelPlayback(): void {
		this.playbackGeneration++;
		const playback = this.playback;
		this.playback = undefined;
		playback?.stdin?.destroy();
		playback?.kill("SIGKILL");
	}

	stopCapture(): void {
		this.captureRequested = false;
		if (this.captureRetry) clearTimeout(this.captureRetry);
		this.captureRetry = undefined;
		this.captureAvailable = undefined;
		this.capture?.kill("SIGTERM");
		this.capture = undefined;
		this.captureBuffer = Buffer.alloc(0);
	}

	stop(): void {
		this.cancelPlayback();
		this.stopCapture();
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
