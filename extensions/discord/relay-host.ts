import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename } from "node:path";
import type { RelayPaths } from "./config.js";
import type { LeaderLease } from "./leader.js";
import { encodeFrame, isClientFrame, MAX_IPC_FRAME_BYTES, parseFrame, type ServerFrame } from "./protocol.js";
import { BoundedSocketWriter, MAX_QUEUED_IPC_BYTES, MAX_QUEUED_IPC_FRAMES } from "./ipc-writer.js";
import { DiscordRelayCore } from "./relay-core.js";
import {
	MAX_SESSION_CONTROL_QUEUE,
	type PiManagerControlRequest,
	type PiSessionControlRequest,
	type PiSessionControlResult,
} from "./controls.js";
import { MANAGER_PRESENTATION_SCHEMA_VERSION, SUPPORTED_MANAGER_PRESENTATION_CONTROLS } from "./manager-presentation.js";

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
	registered: boolean;
	managerControls: boolean;
	managerPresentation: boolean;
	managerTaskTerminalProducer: boolean;
	outboundImages: boolean;
	buffer: string;
	queue: Promise<void>;
	queuedInputFrames: number;
	queuedInputBytes: number;
	writer: BoundedSocketWriter;
	pendingControls: Map<string, {
		resolve(result: PiSessionControlResult): void;
		reject(error: Error): void;
		timer: ReturnType<typeof setTimeout>;
		resultType: "control_result" | "manager_control_result" | "manager_presentation_control_result";
	}>;
}

const ZERO_CLIENT_GRACE_MS = 1_000;
const SESSION_CONTROL_TIMEOUT_MS = 10_000;
export const MANAGER_CONTROL_IPC_TIMEOUT_MS = 170_000;

export function isEligibleManagerTaskSummaryProducer(
	cwd: string,
	registration: { managerControls?: unknown; managerTaskSummaryProducer?: true },
): boolean {
	return basename(cwd) === "the-manager" && registration.managerControls !== undefined &&
		registration.managerTaskSummaryProducer === true;
}

export function negotiatedManagerPresentation(
	cwd: string,
	registration: { managerControls?: unknown; managerTaskSummaryProducer?: true; managerPresentation?: { schemaVersion: 1; controlIds: string[] } },
): { schemaVersion: 1; controlIds: string[] } | undefined {
	if (!isEligibleManagerTaskSummaryProducer(cwd, registration) ||
		registration.managerPresentation?.schemaVersion !== MANAGER_PRESENTATION_SCHEMA_VERSION) return undefined;
	return {
		schemaVersion: 1,
		controlIds: registration.managerPresentation.controlIds.filter((id) => SUPPORTED_MANAGER_PRESENTATION_CONTROLS.includes(id)),
	};
}

export class LocalRelayHost {
	private server: Server | undefined;
	private readonly sockets = new Set<Socket>();
	private readonly socketStates = new Map<Socket, SocketState>();
	private stopPromise: Promise<void> | undefined;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private zeroClientTimer: ReturnType<typeof setTimeout> | undefined;
	private registeredClientCount = 0;
	private readonly stopWaiters = new Set<() => void>();
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
			this.scheduleZeroClientStop();
			server.on("error", (error) => {
				for (const socket of this.sockets) {
					const state = this.socketStates.get(socket);
					if (state) this.fail(socket, state, `Local Discord relay failed: ${error.message}`, true);
				}
				void this.stop().catch((stopError) => {
					console.error("[discord-bridge] Failed to stop local relay:", stopError);
				});
			});
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	waitForStop(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		return new Promise((resolve) => this.stopWaiters.add(resolve));
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
		if (this.zeroClientTimer) clearTimeout(this.zeroClientTimer);
		this.heartbeatTimer = undefined;
		this.zeroClientTimer = undefined;
		for (const [socket, state] of this.socketStates) {
			state.writer.close();
			socket.destroy();
		}
		this.sockets.clear();
		this.socketStates.clear();
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
		}
		await this.options.core.stop().catch(() => {});
		try {
			const stillOwnsLease = await this.options.lease.heartbeat().catch(() => false);
			if (stillOwnsLease && process.platform !== "win32") {
				await unlink(this.options.paths.socket).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			}
		} finally {
			await this.options.lease.release();
			for (const resolve of this.stopWaiters) resolve();
			this.stopWaiters.clear();
		}
	}

	private accept(socket: Socket): void {
		this.sockets.add(socket);
		socket.setEncoding("utf8");
		const state = {} as SocketState;
		Object.assign(state, {
			closed: false,
			registered: false,
			managerControls: false,
			managerPresentation: false,
			managerTaskTerminalProducer: false,
			outboundImages: false,
			buffer: "",
			queue: Promise.resolve(),
			queuedInputFrames: 0,
			queuedInputBytes: 0,
			pendingControls: new Map(),
			writer: new BoundedSocketWriter(socket, () => {
				if (state.sessionId) void this.options.core.resumeDelivery(state.sessionId);
			}),
		});
		this.socketStates.set(socket, state);
		socket.on("data", (data: string) => {
			state.buffer += data;
			if (Buffer.byteLength(state.buffer) > MAX_IPC_FRAME_BYTES) {
				this.fail(socket, state, "Local Discord relay IPC buffer is too large", true);
				return;
			}
			let newline = state.buffer.indexOf("\n");
			while (newline >= 0) {
				const line = state.buffer.slice(0, newline);
				state.buffer = state.buffer.slice(newline + 1);
				if (line) {
					const lineBytes = Buffer.byteLength(line);
					if (state.queuedInputFrames >= MAX_QUEUED_IPC_FRAMES || state.queuedInputBytes + lineBytes > MAX_QUEUED_IPC_BYTES) {
						this.fail(socket, state, "Local Discord relay input queue is full", true);
						return;
					}
					state.queuedInputFrames++;
					state.queuedInputBytes += lineBytes;
					state.queue = state.queue
						.then(() => this.handleLine(socket, state, line))
						.catch((error) => this.fail(
							socket,
							state,
							error instanceof Error ? error.message : String(error),
							!state.clientId,
						))
						.finally(() => {
							state.queuedInputFrames--;
							state.queuedInputBytes -= lineBytes;
						});
				}
				newline = state.buffer.indexOf("\n");
			}
		});
		const close = () => {
			if (state.closed) return;
			state.closed = true;
			state.writer.close();
			for (const pending of state.pendingControls.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error("Pi session disconnected while executing a Discord control"));
			}
			state.pendingControls.clear();
			this.sockets.delete(socket);
			this.socketStates.delete(socket);
			if (state.registered) {
				this.registeredClientCount--;
				this.scheduleZeroClientStop();
			}
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
			if (parsed.type === "ping") {
				this.write(state, { type: "pong" });
				return;
			}
			if (parsed.type !== "register") throw new Error("Local Discord relay requires registration first");
			if (parsed.token !== this.options.token) {
				this.fail(socket, state, "Local Discord relay authentication failed", true);
				return;
			}
			if (parsed.configEpoch > this.options.configEpoch) {
				this.write(state, { type: "replacing", configEpoch: parsed.configEpoch });
				void this.stop().catch(() => {});
				return;
			}
			if (parsed.configEpoch === this.options.configEpoch && parsed.configFingerprint !== this.options.configFingerprint) {
				this.fail(socket, state, "Discord bridge configuration authority reported an epoch collision", true);
				return;
			}
			state.registered = true;
			this.registeredClientCount++;
			if (this.zeroClientTimer) clearTimeout(this.zeroClientTimer);
			this.zeroClientTimer = undefined;
			const prepared = await this.options.core.prepareRegistration(parsed.clientId, parsed.generation, {
				cwd: parsed.cwd,
				projectIdentityResolved: parsed.projectIdentityResolved,
				sessionId: parsed.sessionId,
				sessionName: parsed.sessionName,
				managerWake: parsed.managerWake,
				managerTaskSnapshotTaskId: parsed.managerTaskSnapshotTaskId,
				subscribeOwnerToThread: parsed.subscribeOwnerToThread,
			});
			if (state.closed) {
				this.options.core.unregisterClient(parsed.clientId, parsed.generation);
				return;
			}
			state.clientId = parsed.clientId;
			state.generation = parsed.generation;
			state.sessionId = parsed.sessionId;
			state.managerControls = parsed.managerControls !== undefined;
			state.outboundImages = parsed.outboundImages === true;
			const managerTaskSummaryProducer = isEligibleManagerTaskSummaryProducer(prepared.cwd, parsed);
			state.managerTaskTerminalProducer = managerTaskSummaryProducer;
			const managerPresentation = negotiatedManagerPresentation(prepared.cwd, parsed);
			state.managerPresentation = managerPresentation !== undefined;
			if (!this.write(state, {
				type: "registered",
				channelId: prepared.channelId,
				threadId: prepared.threadId,
				leaderPid: this.options.lease.pid,
				leaderNonce: this.options.lease.nonce,
				lifecycleReactions: true,
				...(managerTaskSummaryProducer ? { projectSummaries: true as const } : {}),
				sessionControls: true,
				managerControls: true,
				...(managerPresentation ? { managerPresentation } : {}),
				inboundImages: true,
				...(state.outboundImages ? { outboundImages: true as const } : {}),
			})) throw new Error("Local Discord relay response queue is full");
			await this.options.core.activateRegistration(
				parsed.clientId,
				parsed.generation,
				parsed.sessionId,
				(message) => this.write(state, {
					type: "inbound",
					messageId: message.id,
					text: message.content,
					...(message.images?.length ? { images: message.images } : {}),
				}),
				parsed.sessionControls ? {
					modelCatalogue: parsed.sessionControls.modelCatalogue,
					execute: (request) => this.requestControl(state, request),
				} : undefined,
				parsed.inboundImages === true,
				parsed.managerControls ? {
					taskCatalogue: parsed.managerControls.taskCatalogue,
					projectCatalogue: parsed.managerControls.projectCatalogue,
					execute: (request) => this.requestManagerControl(state, request),
				} : undefined,
				managerTaskSummaryProducer,
				managerPresentation ? {
					controlIds: managerPresentation.controlIds,
					execute: (request) => this.requestPresentationControl(state, request),
				} : undefined,
				parsed.managerTaskSnapshotTaskId,
				state.managerTaskTerminalProducer,
				prepared.outputRoot,
			);
			if (state.closed) {
				this.options.core.unregisterClient(parsed.clientId, parsed.generation);
				return;
			}
			return;
		}

		const clientId = state.clientId;
		const generation = state.generation!;
		const sessionId = state.sessionId!;
		if (parsed.type === "register") throw new Error("Local Discord relay client is already registered");
		if (parsed.type === "control_result" || parsed.type === "manager_control_result" ||
			parsed.type === "manager_presentation_control_result") {
			const pending = state.pendingControls.get(parsed.requestId);
			if (!pending || pending.resultType !== parsed.type) return;
			clearTimeout(pending.timer);
			state.pendingControls.delete(parsed.requestId);
			pending.resolve({ ok: parsed.ok, message: parsed.message });
			return;
		}
		if (parsed.type === "manager_presentation") {
			if (!state.managerPresentation) throw new Error("Local client did not negotiate manager presentation support");
			try {
				await this.options.core.queueManagerPresentation(clientId, generation, sessionId, parsed.presentation);
			} catch (error) {
				this.fail(socket, state, error instanceof Error ? error.message : String(error), false, parsed.requestId);
				return;
			}
			this.write(state, { type: "manager_presentation_queued", requestId: parsed.requestId });
			return;
		}
		if (parsed.type === "manager_task_snapshot") {
			try {
				await this.options.core.queueManagerTaskSnapshot(clientId, generation, sessionId, parsed.snapshot);
			} catch (error) {
				this.fail(socket, state, error instanceof Error ? error.message : String(error), false, parsed.requestId);
				return;
			}
			this.write(state, { type: "manager_task_snapshot_queued", requestId: parsed.requestId });
			return;
		}
		if (parsed.type === "manager_task_terminal") {
			if (!state.managerTaskTerminalProducer) {
				this.fail(socket, state, "Local client is not registered as a manager task-terminal producer", false, parsed.requestId);
				return;
			}
			try {
				await this.options.core.queueManagerTaskTerminal(clientId, generation, sessionId, parsed.terminal);
			} catch (error) {
				this.fail(socket, state, error instanceof Error ? error.message : String(error), false, parsed.requestId);
				return;
			}
			this.write(state, { type: "manager_task_terminal_queued", requestId: parsed.requestId });
			return;
		}
		if (parsed.type === "manager_catalogue") {
			if (!state.managerControls) throw new Error("Local client is not registered for manager controls");
			try {
				this.options.core.updateManagerCatalogues(
					clientId,
					generation,
					sessionId,
					parsed.taskCatalogue,
					parsed.projectCatalogue,
				);
			} catch (error) {
				this.fail(socket, state, error instanceof Error ? error.message : String(error), false, parsed.requestId);
				return;
			}
			this.write(state, { type: "manager_catalogue_updated", requestId: parsed.requestId });
			return;
		}
		if (parsed.type === "ack_inbound") {
			try {
				await this.options.core.acknowledge(clientId, generation, sessionId, parsed.messageId);
			} catch (error) {
				this.fail(socket, state, error instanceof Error ? error.message : String(error), false, parsed.requestId);
				return;
			}
			this.write(state, { type: "inbound_acked", requestId: parsed.requestId, messageId: parsed.messageId });
			return;
		}
		if (parsed.type === "release_inbound_images") {
			try {
				await this.options.core.releaseInboundImages(clientId, generation, sessionId, parsed.messageId);
			} catch (error) {
				this.fail(socket, state, error instanceof Error ? error.message : String(error), false, parsed.requestId);
				return;
			}
			this.write(state, { type: "inbound_images_released", requestId: parsed.requestId, messageId: parsed.messageId });
			return;
		}
		if (parsed.type === "lifecycle") {
			await this.options.core.queueLifecycleUpdate(clientId, generation, sessionId, parsed.messageId, parsed.status);
			return;
		}
		if (parsed.type === "project_summary") {
			try {
				await this.options.core.queueProjectSummary(clientId, generation, sessionId, parsed.text);
			} catch (error) {
				this.fail(socket, state, error instanceof Error ? error.message : String(error), false, parsed.requestId);
				return;
			}
			this.write(state, { type: "project_summary_queued", requestId: parsed.requestId });
			return;
		}
		if (parsed.type === "working") {
			try {
				await this.options.core.queueWorking(clientId, generation, sessionId, parsed.messageId);
			} catch (error) {
				this.fail(socket, state, error instanceof Error ? error.message : String(error), false, parsed.requestId);
				return;
			}
			this.write(state, { type: "working_queued", requestId: parsed.requestId, messageId: parsed.messageId });
			return;
		}
		if (parsed.type === "outbound") {
			if (parsed.imagePaths?.length && !state.outboundImages) {
				this.fail(socket, state, "Local client did not negotiate Discord outbound image support", false, parsed.requestId);
				return;
			}
			try {
				await this.options.core.queueOutbound(
					clientId, generation, sessionId, parsed.messageId, parsed.kind, parsed.text, parsed.responseTo, parsed.imagePaths,
				);
			} catch (error) {
				this.fail(socket, state, error instanceof Error ? error.message : String(error), false, parsed.requestId);
				return;
			}
			this.write(state, { type: "outbound_queued", requestId: parsed.requestId, messageId: parsed.messageId });
			return;
		}
		if (parsed.type === "ping") {
			this.write(state, { type: "pong" });
			return;
		}
		if (parsed.type === "unregister") socket.end();
	}

	private requestPresentationControl(
		state: SocketState,
		request: Omit<Extract<ServerFrame, { type: "manager_presentation_control" }>, "type">,
	): Promise<PiSessionControlResult> {
		return this.requestClientControl(state, { type: "manager_presentation_control", ...request }, MANAGER_CONTROL_IPC_TIMEOUT_MS);
	}

	private requestManagerControl(state: SocketState, request: PiManagerControlRequest): Promise<PiSessionControlResult> {
		const frame: Extract<ServerFrame, { type: "manager_control" }> = request.action === "ask"
			? { type: "manager_control", requestId: request.requestId, action: "ask", target: request.target, request: request.request }
			: request.action === "reconcile-pr"
				? { type: "manager_control", requestId: request.requestId, action: "reconcile-pr", ...(request.taskId ? { taskId: request.taskId } : {}) }
				: { type: "manager_control", requestId: request.requestId, action: request.action, taskId: request.taskId };
		return this.requestClientControl(state, frame, MANAGER_CONTROL_IPC_TIMEOUT_MS);
	}

	private requestControl(state: SocketState, request: PiSessionControlRequest): Promise<PiSessionControlResult> {
		return this.requestClientControl(
			state,
			{ type: "control", requestId: request.requestId, action: request.action },
			SESSION_CONTROL_TIMEOUT_MS,
		);
	}

	private requestClientControl(
		state: SocketState,
		frame: ServerFrame & { requestId: string },
		timeoutMs: number,
	): Promise<PiSessionControlResult> {
		if (state.closed) return Promise.reject(new Error("Pi session is disconnected"));
		if (state.pendingControls.size >= MAX_SESSION_CONTROL_QUEUE) {
			return Promise.reject(new Error("Pi session control IPC queue is full"));
		}
		const existing = state.pendingControls.get(frame.requestId);
		if (existing) return Promise.reject(new Error("Pi session control request is already pending"));
		const resultType = frame.type === "manager_control" ? "manager_control_result"
			: frame.type === "manager_presentation_control" ? "manager_presentation_control_result" : "control_result";
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				state.pendingControls.delete(frame.requestId);
				reject(new Error(`Pi session control timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref();
			state.pendingControls.set(frame.requestId, { resolve, reject, timer, resultType });
			if (!this.write(state, frame)) {
				clearTimeout(timer);
				state.pendingControls.delete(frame.requestId);
				reject(new Error("Local Discord relay response queue is full"));
			}
		});
	}

	private scheduleZeroClientStop(): void {
		if (this.stopped || this.registeredClientCount > 0 || this.zeroClientTimer) return;
		this.zeroClientTimer = setTimeout(() => {
			this.zeroClientTimer = undefined;
			if (this.registeredClientCount === 0) void this.stop();
		}, ZERO_CLIENT_GRACE_MS);
		this.zeroClientTimer.unref();
	}

	private write(state: SocketState, frame: ServerFrame): boolean {
		return state.writer.write(encodeFrame(frame));
	}

	private fail(socket: Socket, state: SocketState, message: string, fatal: boolean, requestId?: string): void {
		this.write(state, { type: "error", message, fatal, ...(requestId ? { requestId } : {}) });
		if (fatal) socket.end();
	}
}
