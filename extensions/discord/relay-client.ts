import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { DiscordBridgeConfig, RelayPaths } from "./config.js";
import { loadOrCreateRelayToken } from "./config.js";
import type { LeaderLease } from "./leader.js";
import { tryAcquireLeader } from "./leader.js";
import { configFingerprint, encodeFrame, isServerFrame, MAX_IPC_FRAME_BYTES, parseFrame, type ClientFrame, type ServerFrame } from "./protocol.js";
import type { LocalRelayHost } from "./relay-host.js";
import type { RelaySessionRegistration } from "./relay-core.js";

const CONNECT_RETRY_MIN_MS = 25;
const CONNECT_RETRY_MAX_MS = 500;
const INITIAL_CONNECT_ATTEMPTS = 120;
const REQUEST_TIMEOUT_MS = 30_000;

export interface RelayClientStatus {
	connected: boolean;
	leaderPid?: number;
	channelId?: string;
	threadId?: string;
}

export interface RelayClientCallbacks {
	onInbound(text: string): void | Promise<void>;
	onError(error: Error): void;
	onStatus(status: RelayClientStatus): void;
}

export interface RelayClientDependencies {
	paths: RelayPaths;
	createHost(lease: LeaderLease, token: string, fingerprint: string): LocalRelayHost;
}

interface PendingRequest {
	resolve(): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

interface RegistrationWaiter {
	resolve(status: RelayClientStatus): void;
	reject(error: Error): void;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

class FatalRelayConnectionError extends Error {}

export class LocalRelayClient {
	private readonly clientId = randomUUID();
	private readonly fingerprint: string;
	private token: string | undefined;
	private socket: Socket | undefined;
	private ownedHost: LocalRelayHost | undefined;
	private connecting: Promise<void> | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly pendingInboundAcks = new Set<string>();
	private readonly inboundAckWaiters = new Set<() => void>();
	private currentStatus: RelayClientStatus = { connected: false };
	private stopped = true;

	constructor(
		private readonly config: DiscordBridgeConfig,
		private readonly registration: RelaySessionRegistration,
		private readonly callbacks: RelayClientCallbacks,
		private readonly dependencies: RelayClientDependencies,
	) {
		this.fingerprint = configFingerprint(config);
	}

	async start(): Promise<void> {
		if (!this.stopped) return this.ensureConnected();
		this.stopped = false;
		this.token = await loadOrCreateRelayToken(this.dependencies.paths);
		await this.ensureConnected();
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		const socket = this.socket;
		if (socket && !socket.destroyed) await this.waitForInboundAcks();
		this.socket = undefined;
		if (socket && !socket.destroyed) {
			const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
			socket.write(encodeFrame({ type: "unregister" }));
			socket.end();
			await closed;
		}
		this.rejectPending(new Error("Local Discord relay client stopped"));
		const host = this.ownedHost;
		this.ownedHost = undefined;
		try {
			await host?.stop();
		} finally {
			this.updateStatus({ connected: false });
		}
	}

	status(): RelayClientStatus {
		return { ...this.currentStatus };
	}

	async sendUserText(text: string): Promise<void> {
		if (!text.trim()) return;
		await this.sendRequest("user_text", text);
	}

	async sendAssistantText(text: string): Promise<void> {
		if (!text.trim()) return;
		await this.sendRequest("assistant_text", text);
	}

	private ensureConnected(): Promise<void> {
		if (this.socket && this.currentStatus.connected) return Promise.resolve();
		if (this.connecting) return this.connecting;
		this.connecting = this.connectLoop().finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private async connectLoop(): Promise<void> {
		let lastError = new Error("Local Discord relay is unavailable");
		for (let attempt = 0; attempt < INITIAL_CONNECT_ATTEMPTS && !this.stopped; attempt++) {
			try {
				await this.connectOnce();
				return;
			} catch (error) {
				lastError = asError(error);
				if (lastError instanceof FatalRelayConnectionError) throw lastError;
			}

			if (!this.ownedHost) {
				const lease = await tryAcquireLeader(this.dependencies.paths);
				if (lease) {
					const host = this.dependencies.createHost(lease, this.token!, this.fingerprint);
					try {
						await host.start();
						this.ownedHost = host;
					} catch (error) {
						lastError = asError(error);
						await host.stop().catch(() => {});
						throw lastError;
					}
				}
			}
			const wait = Math.min(CONNECT_RETRY_MIN_MS * 2 ** Math.min(attempt, 5), CONNECT_RETRY_MAX_MS);
			await delay(wait);
		}
		if (this.stopped) throw new Error("Local Discord relay client stopped");
		throw lastError;
	}

	private connectOnce(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const socket = createConnection(this.dependencies.paths.socket);
			socket.setEncoding("utf8");
			let settled = false;
			let buffer = "";
			let frameQueue = Promise.resolve();
			const waiter: RegistrationWaiter = {
				resolve: (status) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					this.socket = socket;
					this.updateStatus(status);
					resolve();
				},
				reject: (error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					socket.destroy();
					reject(error);
				},
			};
			const timeout = setTimeout(
				() => waiter.reject(new Error(`Local Discord relay registration timed out after ${REQUEST_TIMEOUT_MS}ms`)),
				REQUEST_TIMEOUT_MS,
			);
			socket.once("connect", () => {
				const frame: ClientFrame = {
					type: "register",
					token: this.token!,
					clientId: this.clientId,
					configFingerprint: this.fingerprint,
					...this.registration,
				};
				socket.write(encodeFrame(frame));
			});
			socket.on("data", (data: string) => {
				buffer += data;
				if (Buffer.byteLength(buffer) > MAX_IPC_FRAME_BYTES) {
					waiter.reject(new Error("Local Discord relay response buffer is too large"));
					return;
				}
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line) {
						frameQueue = frameQueue
							.then(() => this.handleServerLine(socket, waiter, line))
							.catch((error) => this.callbacks.onError(asError(error)));
					}
					newline = buffer.indexOf("\n");
				}
			});
			socket.once("error", (error) => waiter.reject(error));
			socket.once("close", () => {
				if (!settled) {
					waiter.reject(new Error("Local Discord relay connection closed during registration"));
					return;
				}
				if (this.socket !== socket) return;
				this.socket = undefined;
				this.pendingInboundAcks.clear();
				this.notifyInboundAckWaiters();
				this.updateStatus({ connected: false });
				this.rejectPending(new Error("Local Discord relay connection closed"));
				if (!this.stopped) {
					const host = this.ownedHost;
					this.ownedHost = undefined;
					if (host) {
						void host.stop()
							.catch((error) => this.callbacks.onError(asError(error)))
							.finally(() => this.scheduleReconnect());
					} else this.scheduleReconnect();
				}
			});
		});
	}

	private async handleServerLine(socket: Socket, waiter: RegistrationWaiter, line: string): Promise<void> {
		const parsed = parseFrame(line);
		if (!isServerFrame(parsed)) throw new Error("Invalid local Discord relay response");
		const frame: ServerFrame = parsed;
		if (frame.type === "registered") {
			waiter.resolve({
				connected: true,
				leaderPid: frame.leaderPid,
				channelId: frame.channelId,
				threadId: frame.threadId,
			});
			return;
		}
		if (frame.type === "error") {
			const error = frame.fatal ? new FatalRelayConnectionError(frame.message) : new Error(frame.message);
			if (!this.currentStatus.connected || frame.fatal) waiter.reject(error);
			else this.callbacks.onError(error);
			return;
		}
		if (frame.type === "inbound") {
			try {
				this.pendingInboundAcks.add(frame.messageId);
				const delivery = this.callbacks.onInbound(frame.text);
				if (delivery instanceof Promise) await delivery;
				socket.write(encodeFrame({ type: "ack_inbound", messageId: frame.messageId }));
			} catch (error) {
				this.pendingInboundAcks.delete(frame.messageId);
				this.notifyInboundAckWaiters();
				this.callbacks.onError(asError(error));
			}
			return;
		}
		if (frame.type === "inbound_acked") {
			this.pendingInboundAcks.delete(frame.messageId);
			this.notifyInboundAckWaiters();
			return;
		}
		if (frame.type === "sent") {
			const pending = this.pendingRequests.get(frame.requestId);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingRequests.delete(frame.requestId);
				pending.resolve();
			}
		}
	}

	private async sendRequest(type: "user_text" | "assistant_text", text: string): Promise<void> {
		if (this.stopped) throw new Error("Local Discord relay client is stopped");
		await this.ensureConnected();
		const socket = this.socket;
		if (!socket || socket.destroyed) throw new Error("Local Discord relay is disconnected");
		const requestId = randomUUID();
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(requestId);
				reject(new Error(`Local Discord relay request timed out after ${REQUEST_TIMEOUT_MS}ms`));
			}, REQUEST_TIMEOUT_MS);
			this.pendingRequests.set(requestId, { resolve, reject, timer });
			socket.write(encodeFrame({ type, requestId, text }));
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || this.stopped) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.ensureConnected().catch((error) => {
				const failure = asError(error);
				this.callbacks.onError(failure);
				if (!(failure instanceof FatalRelayConnectionError)) this.scheduleReconnect();
			});
		}, CONNECT_RETRY_MIN_MS);
	}

	private waitForInboundAcks(): Promise<void> {
		if (this.pendingInboundAcks.size === 0) return Promise.resolve();
		return new Promise((resolve) => this.inboundAckWaiters.add(resolve));
	}

	private notifyInboundAckWaiters(): void {
		if (this.pendingInboundAcks.size > 0) return;
		for (const resolve of this.inboundAckWaiters) resolve();
		this.inboundAckWaiters.clear();
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	private updateStatus(status: RelayClientStatus): void {
		this.currentStatus = status;
		this.callbacks.onStatus({ ...status });
	}
}
