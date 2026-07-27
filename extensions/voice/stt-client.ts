import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { makeSimpleFrame } from "./protocol.js";

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

export type SttEvent =
	| { type: "ready"; sampleRate: number }
	| { type: "reset" }
	| { type: "interim" | "final" | "backchannel"; text: string }
	| { type: "error"; message: string };

export class SttClient {
	private child?: ChildProcessWithoutNullStreams;
	private stdout = "";

	constructor(
		private readonly workerPath: string,
		private readonly modelPath: string,
		private readonly onEvent: (event: SttEvent) => void,
		private readonly onLog: (message: string) => void,
	) {}

	start(): void {
		if (this.child) return;
		const child = spawn(this.workerPath, [this.modelPath], { stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		child.stdin.on("error", (error) => {
			if (errorCode(error) !== "EPIPE") this.onEvent({ type: "error", message: `STT input: ${String(error)}` });
		});
		child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split(/\r?\n/)) {
				if (line.trim()) this.onLog(line.trim());
			}
		});
		child.once("error", (error) => this.onEvent({ type: "error", message: error.message }));
		child.once("exit", (code, signal) => {
			if (this.child === child) this.child = undefined;
			if (code !== 0) this.onEvent({ type: "error", message: `STT exited (${code ?? signal ?? "unknown"})` });
		});
	}

	pushPcm(pcm: Buffer): void {
		this.write(makeSimpleFrame(1, pcm));
	}

	reset(): void {
		this.write(makeSimpleFrame(2));
	}

	stop(): void {
		if (!this.child) return;
		this.write(makeSimpleFrame(3));
		this.child.kill();
		this.child = undefined;
	}

	private write(frame: Buffer): void {
		const input = this.child?.stdin;
		if (!input?.writable || input.destroyed || input.writableEnded) return;
		try {
			input.write(frame);
		} catch (error) {
			if (errorCode(error) !== "EPIPE") this.onEvent({ type: "error", message: `STT input: ${String(error)}` });
		}
	}

	private handleStdout(chunk: Buffer): void {
		this.stdout += chunk.toString("utf8");
		while (true) {
			const newline = this.stdout.indexOf("\n");
			if (newline < 0) return;
			const line = this.stdout.slice(0, newline).trim();
			this.stdout = this.stdout.slice(newline + 1);
			if (!line) continue;
			try {
				this.onEvent(JSON.parse(line) as SttEvent);
			} catch (error) {
				this.onLog(`invalid STT event: ${line}; ${String(error)}`);
			}
		}
	}
}
