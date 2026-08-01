import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { RelayPaths } from "./config.js";
import type { LeaderLease } from "./leader.js";
import { encodeFrame, isClientFrame, MAX_IPC_FRAME_BYTES, parseFrame, type ServerFrame } from "./protocol.js";
import { DiscordRelayCore } from "./relay-core.js";

export interface RelayHostOptions {
	paths: RelayPaths;
	token: string;
	configFingerprint: string;
	configEpoch: number;
	lease: LeaderLease;
	core: DiscordRelayCore;
}

interface SocketState {
	clientId?: string;
	generation?: string;
	sessionId?: string;
	closed: boolean;
	buffer: string;
	queue: Promise<void>;
}

export class LocalRelayHost {
	private server: Server | undefined;
	private readonly sockets = new Set<Socket>();
	private stopPromise: Promise<void> | undefined;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private stopped = true;

	constructor(private readonly options: RelayHostOptions) {}

	async start(): Promise<void> {
		if (!this.stopped) return;
		this.stopped = false;
		this.heartbeatTimer = setInterval(() => {
			void this.options.lease.heartbeat().then((current) => {
				if (!current) void this.stop();
			}).catch(() => void this.stop());
		}, 1_000);
		this.heartbeatTimer.unref();
		try {
			await this.options.core.start();
			if (process.platform !== "win32") {
				await unlink(this.options.paths.socket).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			}
			const server = createServer((socket) => this.accept(socket));
			this.server = server;
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => reject(error);
				server.once("error", onError);
				server.listen(this.options.paths.socket, () => {
					server.off("error", onError);
					resolve();
				});
			});
			if (process.platform !== "win32") await chmod(this.options.paths.socket, 0o600);
			server.on("error", (error) => {
				for (const socket of this.sockets) this.fail(socket, `Local Discord relay failed: ${error.message}`, true);
				void this.stop().catch((stopError) => {
					console.error("[discord-bridge] Failed to stop local relay:", stopError);
				});
			});
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		if (this.stopped) return;
		this.stopped = true;
		this.stopPromise = this.performStop();
		return this.stopPromise;
	}

	private async performStop(): Promise<void> {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
		}
		await this.options.core.stop().catch(() => {});
		try {
			if (process.platform !== "win32") {
				await unlink(this.options.paths.socket).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			}
		} finally {
			await this.options.lease.release();
		}
	}

	private accept(socket: Socket): void {
		this.sockets.add(socket);
		socket.setEncoding("utf8");
		const state: SocketState = { closed: false, buffer: "", queue: Promise.resolve() };
		socket.on("data", (data: string) => {
			state.buffer += data;
			if (Buffer.byteLength(state.buffer) > MAX_IPC_FRAME_BYTES) {
				this.fail(socket, "Local Discord relay IPC buffer is too large", true);
				return;
			}
			let newline = state.buffer.indexOf("\n");
			while (newline >= 0) {
				const line = state.buffer.slice(0, newline);
				state.buffer = state.buffer.slice(newline + 1);
				if (line) {
					state.queue = state.queue
						.then(() => this.handleLine(socket, state, line))
						.catch((error) => this.fail(
							socket,
							error instanceof Error ? error.message : String(error),
							!state.clientId,
						));
				}
				newline = state.buffer.indexOf("\n");
			}
		});
		const close = () => {
			if (state.closed) return;
			state.closed = true;
			this.sockets.delete(socket);
			void state.queue.finally(() => {
				if (state.clientId && state.generation) this.options.core.unregisterClient(state.clientId, state.generation);
			});
		};
		socket.once("close", close);
		socket.once("error", () => close());
	}

	private async handleLine(socket: Socket, state: SocketState, line: string): Promise<void> {
		const parsed = parseFrame(line);
		if (!isClientFrame(parsed)) throw new Error("Invalid local Discord relay IPC frame");
		if (!state.clientId) {
			if (parsed.type !== "register") throw new Error("Local Discord relay requires registration first");
			if (parsed.token !== this.options.token) {
				this.fail(socket, "Local Discord relay authentication failed", true);
				return;
			}
			if (parsed.configEpoch > this.options.configEpoch) {
				this.write(socket, { type: "replacing", configEpoch: parsed.configEpoch });
				void this.stop().catch(() => {});
				return;
			}
			if (parsed.configEpoch !== this.options.configEpoch || parsed.configFingerprint !== this.options.configFingerprint) {
				this.fail(socket, "Discord bridge client configuration is stale or differs from the active relay", true);
				return;
			}
			const prepared = await this.options.core.prepareRegistration(parsed.clientId, parsed.generation, {
				cwd: parsed.cwd,
				sessionId: parsed.sessionId,
				sessionName: parsed.sessionName,
			});
			if (state.closed) {
				this.options.core.unregisterClient(parsed.clientId, parsed.generation);
				return;
			}
			state.clientId = parsed.clientId;
			state.generation = parsed.generation;
			state.sessionId = parsed.sessionId;
			let registered = false;
			const buffered: Array<{ id: string; content: string }> = [];
			await this.options.core.activateRegistration(parsed.clientId, parsed.generation, parsed.sessionId, (message) => {
				if (!registered) buffered.push(message);
				else this.write(socket, { type: "inbound", messageId: message.id, text: message.content });
			});
			if (state.closed) {
				this.options.core.unregisterClient(parsed.clientId, parsed.generation);
				return;
			}
			this.write(socket, {
				type: "registered",
				channelId: prepared.channelId,
				threadId: prepared.threadId,
				leaderPid: this.options.lease.pid,
			});
			registered = true;
			for (const message of buffered) {
				this.write(socket, { type: "inbound", messageId: message.id, text: message.content });
			}
			return;
		}

		const clientId = state.clientId;
		const generation = state.generation!;
		const sessionId = state.sessionId!;
		if (parsed.type === "register") throw new Error("Local Discord relay client is already registered");
		if (parsed.type === "ack_inbound") {
			await this.options.core.acknowledge(clientId, generation, sessionId, parsed.messageId);
			this.write(socket, { type: "inbound_acked", requestId: parsed.requestId, messageId: parsed.messageId });
			return;
		}
		if (parsed.type === "outbound") {
			await this.options.core.queueOutbound(clientId, generation, sessionId, parsed.messageId, parsed.kind, parsed.text);
			this.write(socket, { type: "outbound_queued", requestId: parsed.requestId, messageId: parsed.messageId });
			return;
		}
		if (parsed.type === "ping") {
			this.write(socket, { type: "pong" });
			return;
		}
		if (parsed.type === "unregister") socket.end();
	}

	private write(socket: Socket, frame: ServerFrame): void {
		if (!socket.destroyed) socket.write(encodeFrame(frame));
	}

	private fail(socket: Socket, message: string, fatal: boolean): void {
		this.write(socket, { type: "error", message, fatal });
		if (fatal) socket.end();
	}
}
