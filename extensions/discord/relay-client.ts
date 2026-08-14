import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { DiscordBridgeConfig, RelayPaths } from "./config.js";
import { loadOrCreateRelayToken, publishRelayConfigIntent } from "./config.js";
import { BoundedSocketWriter } from "./ipc-writer.js";
import { configFingerprint, encodeFrame, isServerFrame, MAX_IPC_FRAME_BYTES, parseFrame, type ClientFrame, type ServerFrame } from "./protocol.js";
import type { RelaySessionRegistration } from "./relay-core.js";
import { interactiveUserChunks } from "./text.js";
import type { DiscordLifecycleStatus } from "./reactions.js";
import { restartOwnedRelay } from "./leader.js";
import type { QueuedInboundImage } from "./inbound-images.js";
import type { NativeOutboundImage } from "./outbound-images.js";
import {
	boundedControlResult,
	MAX_MODEL_CATALOGUE_ITEMS,
	type PiModelCatalogueEntry,
	type PiSessionControlRequest,
	type PiSessionControlResult,
} from "./controls.js";
import {
	MANAGER_PRESENTATION_SCHEMA_VERSION,
	SUPPORTED_MANAGER_PRESENTATION_CONTROLS,
	type ManagerPresentation,
	type ManagerPresentationActionControl,
} from "./manager-presentation.js";
import type { ManagerTaskSnapshot } from "./manager-task-snapshot.js";
import type { ManagerTaskTerminal } from "./manager-task-terminal.js";

const CONNECT_RETRY_MIN_MS = 25;
const CONNECT_RETRY_MAX_MS = 500;
const INITIAL_CONNECT_ATTEMPTS = 120;
const REQUEST_TIMEOUT_MS = 30_000;
const ACK_TIMEOUT_MS = 2_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const RESTART_RECONNECT_TIMEOUT_MS = 10_000;
const MAX_DESIRED_LIFECYCLE_STATUSES = 256;

export interface RelayClientStatus {
	connected: boolean;
	leaderPid?: number;
	leaderNonce?: string;
	channelId?: string;
	threadId?: string;
	sessionControls?: true;
	managerPresentation?: { schemaVersion: 1; controlIds: string[] };
	inboundImages?: true;
	nativeOutboundImages?: true;
}

export interface RelayClientCallbacks {
	onInbound(messageId: string, text: string, images: readonly QueuedInboundImage[]): void | Promise<void>;
	onError(error: Error): void;
	onStatus(status: RelayClientStatus): void;
	modelCatalogue?(): PiModelCatalogueEntry[];
	onControl?(request: PiSessionControlRequest): Promise<PiSessionControlResult>;
	onManagerPresentationControl?(
		request: { requestId: string; revision: string; controlId: string; command: string; actionControl?: ManagerPresentationActionControl },
		signal: AbortSignal,
	): Promise<PiSessionControlResult>;
}

export interface RelayClientDependencies {
	paths: RelayPaths;
	launchRelay(): Promise<void>;
	reloadConfig?: () => Promise<DiscordBridgeConfig>;
	restartRelay?: (expectedPid: number, expectedNonce?: string) => Promise<void>;
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
class RelayRequestError extends Error {}

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), milliseconds);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export class LocalRelayClient {
	private readonly clientId = randomUUID();
	private config: DiscordBridgeConfig;
	private fingerprint: string;
	private token: string | undefined;
	private socket: Socket | undefined;
	private connectingSocket: Socket | undefined;
	private writer: BoundedSocketWriter | undefined;
	private connecting: Promise<void> | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private lastRelayLaunchAt = 0;
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly presentationControlAborts = new Map<string, AbortController>();
	private readonly desiredLifecycleStatuses = new Map<string, { status: DiscordLifecycleStatus; sentGeneration?: string }>();
	private readonly pendingLifecycleFrames: Array<{ messageId: string; status: DiscordLifecycleStatus }> = [];
	private lifecycleGeneration: string | undefined;
	private lifecycleSupported = false;
	private currentStatus: RelayClientStatus = { connected: false };
	private stopped = true;

	constructor(
		config: DiscordBridgeConfig,
		private readonly registration: RelaySessionRegistration,
		private readonly callbacks: RelayClientCallbacks,
		private readonly dependencies: RelayClientDependencies,
	) {
		this.config = config;
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
		const connectingSocket = this.connectingSocket;
		const writer = this.writer;
		this.socket = undefined;
		this.connectingSocket = undefined;
		this.writer = undefined;
		this.lifecycleGeneration = undefined;
		this.lifecycleSupported = false;
		this.desiredLifecycleStatuses.clear();
		this.pendingLifecycleFrames.length = 0;
		connectingSocket?.destroy();
		if (socket && !socket.destroyed) {
			const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
			writer?.write(encodeFrame({ type: "unregister" }));
			socket.end();
			await bounded(closed, SHUTDOWN_TIMEOUT_MS, "Timed out closing local Discord relay socket").catch(() => socket.destroy());
		}
		this.rejectPending(new Error("Local Discord relay client stopped"));
		this.abortPresentationControls();
		if (this.connecting) {
			await bounded(this.connecting.catch(() => {}), SHUTDOWN_TIMEOUT_MS, "Timed out stopping local Discord relay connection").catch(() => {});
		}
		this.updateStatus({ connected: false });
	}

	status(): RelayClientStatus {
		return { ...this.currentStatus };
	}

	async restartRelay(): Promise<RelayClientStatus> {
		if (this.stopped) throw new Error("Discord bridge is stopped; connect it before restarting the relay");
		const originalSocket = this.socket;
		const leaderPid = this.currentStatus.connected ? this.currentStatus.leaderPid : undefined;
		const leaderNonce = this.currentStatus.connected ? this.currentStatus.leaderNonce : undefined;
		if (!originalSocket || !leaderPid) throw new Error("Discord bridge is disconnected; reconnect it before restarting the relay");
		const restart = this.dependencies.restartRelay ?? (async (expectedPid: number, expectedNonce?: string) => {
			await restartOwnedRelay(this.dependencies.paths, expectedPid, expectedNonce);
		});
		await restart(leaderPid, leaderNonce);
		const deadline = Date.now() + RESTART_RECONNECT_TIMEOUT_MS;
		while (!this.stopped && Date.now() < deadline) {
			if (this.socket && this.socket !== originalSocket && this.currentStatus.connected) return this.status();
			await delay(CONNECT_RETRY_MIN_MS);
		}
		if (this.stopped) throw new Error("Discord bridge stopped while waiting for its replacement relay");
		throw new Error(`Timed out after ${RESTART_RECONNECT_TIMEOUT_MS}ms waiting for the replacement Discord relay`);
	}

	async sendUserText(text: string): Promise<void> {
		await this.queueOutbound("user", text);
	}

	async sendInteractiveUserText(text: string): Promise<void> {
		if (!text) return;
		for (const chunk of interactiveUserChunks(text)) await this.queueOutbound("user", chunk);
	}

	async sendAssistantText(
		messageId: string,
		text: string,
		responseTo: readonly string[] = [],
		nativeImages: readonly NativeOutboundImage[] = [],
	): Promise<void> {
		await this.queueOutbound("assistant", text, messageId, responseTo,
			this.currentStatus.nativeOutboundImages ? nativeImages : []);
	}

	async startWorking(messageId: string): Promise<void> {
		for (;;) {
			if (this.stopped) throw new Error("Local Discord relay client is stopped");
			try {
				await this.sendRequest({ type: "working", requestId: randomUUID(), messageId }, REQUEST_TIMEOUT_MS);
				return;
			} catch (error) {
				if (this.stopped || error instanceof RelayRequestError) throw error;
				await this.ensureConnected();
				await delay(CONNECT_RETRY_MIN_MS);
			}
		}
	}

	async publishManagerTaskSnapshot(snapshot: ManagerTaskSnapshot): Promise<void> {
		for (;;) {
			if (this.stopped) throw new Error("Local Discord relay client is stopped");
			try {
				await this.sendRequest({
					type: "manager_task_snapshot",
					requestId: randomUUID(),
					snapshot: structuredClone(snapshot),
				}, REQUEST_TIMEOUT_MS);
				return;
			} catch (error) {
				if (this.stopped || error instanceof RelayRequestError) throw error;
				await this.ensureConnected();
				await delay(CONNECT_RETRY_MIN_MS);
			}
		}
	}

	async publishManagerTaskTerminal(terminal: ManagerTaskTerminal): Promise<boolean> {
		for (;;) {
			if (this.stopped) throw new Error("Local Discord relay client is stopped");
			try {
				await this.sendRequest({
					type: "manager_task_terminal",
					requestId: randomUUID(),
					terminal: structuredClone(terminal),
				}, REQUEST_TIMEOUT_MS);
				return true;
			} catch (error) {
				if (error instanceof RelayRequestError) return false;
				if (this.stopped) throw error;
				await this.ensureConnected();
				await delay(CONNECT_RETRY_MIN_MS);
			}
		}
	}

	async publishManagerPresentation(presentation: ManagerPresentation): Promise<boolean> {
		const capability = this.currentStatus.managerPresentation;
		if (!capability) return false;
		if (presentation.controls.some((control) => !capability.controlIds.includes(control.id))) return false;
		await this.sendRequest({
			type: "manager_presentation",
			requestId: randomUUID(),
			presentation: structuredClone(presentation),
		}, REQUEST_TIMEOUT_MS);
		return true;
	}

	async acknowledgeInbound(messageId: string): Promise<void> {
		await this.sendRequest({ type: "ack_inbound", requestId: randomUUID(), messageId }, ACK_TIMEOUT_MS);
	}

	async releaseInboundImages(messageId: string): Promise<void> {
		await this.sendRequest({ type: "release_inbound_images", requestId: randomUUID(), messageId }, ACK_TIMEOUT_MS);
	}

	updateLifecycle(messageId: string, status: DiscordLifecycleStatus): void {
		if (this.stopped) return;
		const existing = this.desiredLifecycleStatuses.get(messageId);
		if (existing?.status === status) {
			this.flushLifecycleStatuses();
			return;
		}
		if (existing) this.desiredLifecycleStatuses.delete(messageId);
		this.desiredLifecycleStatuses.set(messageId, { status });
		if (this.pendingLifecycleFrames.length < MAX_DESIRED_LIFECYCLE_STATUSES) {
			this.pendingLifecycleFrames.push({ messageId, status });
		}
		while (this.desiredLifecycleStatuses.size > MAX_DESIRED_LIFECYCLE_STATUSES) {
			this.desiredLifecycleStatuses.delete(this.desiredLifecycleStatuses.keys().next().value!);
		}
		this.flushLifecycleStatuses();
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
				if (this.dependencies.reloadConfig) {
					this.config = await this.dependencies.reloadConfig();
					this.fingerprint = configFingerprint(this.config);
				}
				await publishRelayConfigIntent(this.dependencies.paths, this.config, this.fingerprint);
				if (this.stopped) throw new Error("Local Discord relay client stopped during connection");
				await this.connectOnce();
				return;
			} catch (error) {
				lastError = asError(error);
				if (lastError instanceof FatalRelayConnectionError) throw lastError;
			}

			if (Date.now() - this.lastRelayLaunchAt >= CONNECT_RETRY_MAX_MS) {
				this.lastRelayLaunchAt = Date.now();
				await this.dependencies.launchRelay();
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
			this.connectingSocket = socket;
			const generation = randomUUID();
			const writer = new BoundedSocketWriter(socket, () => {
				if (this.writer === writer) this.flushLifecycleStatuses();
			});
			socket.setEncoding("utf8");
			let settled = false;
			let buffer = "";
			let frameQueue = Promise.resolve();
			const waiter: RegistrationWaiter = {
				resolve: (status) => {
					if (settled) return;
					if (this.stopped) {
						waiter.reject(new Error("Local Discord relay client stopped during registration"));
						return;
					}
					settled = true;
					clearTimeout(timeout);
					this.socket = socket;
					if (this.connectingSocket === socket) this.connectingSocket = undefined;
					this.writer = writer;
					this.updateStatus(status);
					resolve();
				},
				reject: (error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					writer.close();
					if (this.connectingSocket === socket) this.connectingSocket = undefined;
					socket.destroy();
					reject(error);
				},
			};
			const timeout = setTimeout(
				() => waiter.reject(new Error(`Local Discord relay registration timed out after ${REQUEST_TIMEOUT_MS}ms`)),
				REQUEST_TIMEOUT_MS,
			);
			socket.once("connect", () => {
				const modelCatalogue = this.callbacks.onControl
					? (this.callbacks.modelCatalogue?.() ?? []).slice(0, MAX_MODEL_CATALOGUE_ITEMS)
					: undefined;
				const frame: ClientFrame = {
					type: "register",
					token: this.token!,
					clientId: this.clientId,
					generation,
					configFingerprint: this.fingerprint,
					configEpoch: this.config.epoch,
					...this.registration,
					inboundImages: true,
					nativeOutboundImages: true,
					...(modelCatalogue ? { sessionControls: { modelCatalogue } } : {}),
					...(this.callbacks.onManagerPresentationControl ? {
						managerPresentation: {
							schemaVersion: MANAGER_PRESENTATION_SCHEMA_VERSION,
							controlIds: [...SUPPORTED_MANAGER_PRESENTATION_CONTROLS],
						},
					} : {}),
				};
				if (!writer.write(encodeFrame(frame))) {
					waiter.reject(new Error("Local Discord relay request queue is full during registration"));
				}
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
							.then(() => this.handleServerLine(socket, waiter, line, generation))
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
				writer.close();
				if (this.socket !== socket) return;
				this.socket = undefined;
				this.writer = undefined;
				this.lifecycleGeneration = undefined;
				this.lifecycleSupported = false;
				this.updateStatus({ connected: false });
				this.rejectPending(new Error("Local Discord relay connection closed"));
				this.abortPresentationControls();
				if (!this.stopped) {
					this.scheduleReconnect();
				}
			});
		});
	}

	private async handleServerLine(socket: Socket, waiter: RegistrationWaiter, line: string, generation: string): Promise<void> {
		const parsed = parseFrame(line);
		if (!isServerFrame(parsed)) throw new Error("Invalid local Discord relay response");
		const frame: ServerFrame = parsed;
		if (frame.type === "registered") {
			this.lifecycleSupported = frame.lifecycleReactions === true;
			this.lifecycleGeneration = generation;
			waiter.resolve({
				connected: true,
				leaderPid: frame.leaderPid,
				...(frame.leaderNonce ? { leaderNonce: frame.leaderNonce } : {}),
				channelId: frame.channelId,
				threadId: frame.threadId,
				...(frame.sessionControls ? { sessionControls: true as const } : {}),
				...(frame.managerPresentation ? { managerPresentation: {
					schemaVersion: 1 as const,
					controlIds: frame.managerPresentation.controlIds.slice(),
				} } : {}),
				...(frame.inboundImages ? { inboundImages: true as const } : {}),
				...(frame.nativeOutboundImages ? { nativeOutboundImages: true as const } : {}),
			});
			this.flushLifecycleStatuses();
			return;
		}
		if (frame.type === "error") {
			const error = frame.fatal ? new FatalRelayConnectionError(frame.message) : new RelayRequestError(frame.message);
			if (frame.requestId) {
				const pending = this.pendingRequests.get(frame.requestId);
				if (pending) {
					clearTimeout(pending.timer);
					this.pendingRequests.delete(frame.requestId);
					pending.reject(error);
					return;
				}
			}
			if (!this.currentStatus.connected || frame.fatal) waiter.reject(error);
			else this.callbacks.onError(error);
			return;
		}
		if (frame.type === "inbound") {
			try {
				if (frame.images?.length && !this.currentStatus.inboundImages) {
					throw new Error("Local Discord relay sent images without negotiating image support");
				}
				await this.callbacks.onInbound(frame.messageId, frame.text, frame.images ?? []);
			} catch (error) {
				this.callbacks.onError(asError(error));
			}
			return;
		}
		if (frame.type === "control") {
			let result: PiSessionControlResult;
			try {
				result = this.callbacks.onControl
					? boundedControlResult(await this.callbacks.onControl({ requestId: frame.requestId, action: frame.action }))
					: { ok: false, message: "This Pi client does not support Discord session controls." };
			} catch (error) {
				result = boundedControlResult({ ok: false, message: asError(error).message });
			}
			if (this.socket === socket && this.writer) {
				if (!this.writer.write(encodeFrame({ type: "control_result", requestId: frame.requestId, ...result }))) {
					this.callbacks.onError(new Error("Local Discord relay request queue is full while returning a session control result"));
				}
			}
			return;
		}
		if (frame.type === "manager_presentation_control") {
			const abort = new AbortController();
			this.presentationControlAborts.set(frame.requestId, abort);
			let result: PiSessionControlResult;
			try {
				result = this.callbacks.onManagerPresentationControl
					? boundedControlResult(await this.callbacks.onManagerPresentationControl({
						requestId: frame.requestId,
						revision: frame.revision,
						controlId: frame.controlId,
						command: frame.command,
						...(frame.actionControl ? { actionControl: structuredClone(frame.actionControl) } : {}),
					}, abort.signal))
					: { ok: false, message: "This Pi client does not support manager presentation controls." };
			} catch (error) {
				result = boundedControlResult({ ok: false, message: asError(error).message });
			} finally {
				this.presentationControlAborts.delete(frame.requestId);
			}
			if (this.socket === socket && this.writer) {
				if (!this.writer.write(encodeFrame({ type: "manager_presentation_control_result", requestId: frame.requestId, ...result }))) {
					this.callbacks.onError(new Error("Local Discord relay request queue is full while returning a presentation control result"));
				}
			}
			return;
		}
		if (frame.type === "replacing") {
			socket.destroy();
			waiter.reject(new Error(`Local Discord relay is replacing configuration with epoch ${frame.configEpoch}`));
			return;
		}
		if (frame.type === "inbound_acked" || frame.type === "inbound_images_released" ||
			frame.type === "outbound_queued" || frame.type === "working_queued" || frame.type === "manager_presentation_queued" ||
			frame.type === "manager_task_snapshot_queued" || frame.type === "manager_task_terminal_queued") {
			const pending = this.pendingRequests.get(frame.requestId);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingRequests.delete(frame.requestId);
				pending.resolve();
			}
		}
	}

	private async queueOutbound(
		kind: "user" | "assistant",
		text: string,
		messageId: string = randomUUID(),
		responseTo: readonly string[] = [],
		nativeImages: readonly NativeOutboundImage[] = [],
	): Promise<void> {
		if (!text.trim() && nativeImages.length === 0) return;
		for (;;) {
			if (this.stopped) throw new Error("Local Discord relay client is stopped");
			try {
				await this.sendRequest({
					type: "outbound",
					requestId: randomUUID(),
					messageId,
					kind,
					text,
					...(kind === "assistant" && responseTo.length ? { responseTo: [...responseTo] } : {}),
					...(kind === "assistant" && nativeImages.length ? { nativeImages: nativeImages.map((image) => ({ ...image })) } : {}),
				}, REQUEST_TIMEOUT_MS);
				return;
			} catch (error) {
				if (this.stopped || error instanceof RelayRequestError) throw error;
				await this.ensureConnected();
				await delay(CONNECT_RETRY_MIN_MS);
			}
		}
	}

	private async sendRequest(frame: Extract<ClientFrame, { requestId: string }>, timeoutMs: number): Promise<void> {
		if (this.stopped) throw new Error("Local Discord relay client is stopped");
		await this.ensureConnected();
		const socket = this.socket;
		const writer = this.writer;
		if (!socket || socket.destroyed || !writer) throw new Error("Local Discord relay is disconnected");
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(frame.requestId);
				reject(new Error(`Local Discord relay request timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pendingRequests.set(frame.requestId, { resolve, reject, timer });
			if (!writer.write(encodeFrame(frame))) {
				clearTimeout(timer);
				this.pendingRequests.delete(frame.requestId);
				reject(new Error("Local Discord relay request queue is full"));
			}
		});
	}

	private flushLifecycleStatuses(): void {
		const writer = this.writer;
		const generation = this.lifecycleGeneration;
		if (!this.lifecycleSupported || !generation || !writer || !this.currentStatus.connected) return;
		while (this.pendingLifecycleFrames.length > 0) {
			const pending = this.pendingLifecycleFrames[0]!;
			if (!writer.writeBestEffort(encodeFrame({ type: "lifecycle", ...pending }))) return;
			this.pendingLifecycleFrames.shift();
			const desired = this.desiredLifecycleStatuses.get(pending.messageId);
			if (desired?.status === pending.status) desired.sentGeneration = generation;
		}
		for (const [messageId, desired] of this.desiredLifecycleStatuses) {
			if (desired.sentGeneration === generation) continue;
			if (!writer.writeBestEffort(encodeFrame({ type: "lifecycle", messageId, status: desired.status }))) return;
			desired.sentGeneration = generation;
		}
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

	private abortPresentationControls(): void {
		for (const abort of this.presentationControlAborts.values()) abort.abort();
		this.presentationControlAborts.clear();
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
