import { createHash } from "node:crypto";
import type { DiscordBridgeConfig } from "./config.js";
import {
	DiscordStateStore,
	type DiscordLifecycleMessage,
	type OutboundMessage,
	type QueuedDiscordMessage,
	type SessionThreadMapping,
} from "./state.js";
import { lifecycleReaction, type DiscordLifecycleStatus } from "./reactions.js";
import { normalizeCwd, sessionThreadName, splitDiscordText } from "./text.js";
import type { DiscordInboundMessage, DiscordTransport } from "./transport.js";

export interface RelaySessionRegistration {
	cwd: string;
	sessionId: string;
	sessionName?: string;
}

export interface PreparedRegistration {
	channelId: string;
	threadId: string;
}

interface ActiveSession {
	clientId: string;
	generation: string;
	deliver(message: QueuedDiscordMessage): boolean;
	deliveredIds: Set<string>;
}

const OUTBOUND_RETRY_MIN_MS = 100;
const OUTBOUND_RETRY_MAX_MS = 5_000;
const REACTION_TIMEOUT_MS = 2_000;
const MAX_PENDING_LIFECYCLE_UPDATES = 256;
const MAX_DESIRED_REACTIONS = 2_000;

async function boundedReaction(operation: Promise<void>): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation.then(() => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), REACTION_TIMEOUT_MS);
				timer.unref();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export class DiscordRelayCore {
	private readonly activeSessions = new Map<string, ActiveSession>();
	private readonly reservedSessions = new Map<string, { clientId: string; generation: string }>();
	private readonly clientSessions = new Map<string, Set<string>>();
	private readonly catchingUpSessions = new Set<string>();
	private unsubscribe: (() => void) | undefined;
	private unsubscribeTerminal: (() => void) | undefined;
	private inboundQueue: Promise<void> = Promise.resolve();
	private drainingOutbound = false;
	private outboundDrainRequested = false;
	private readonly outboundRetryAttempts = new Map<string, number>();
	private readonly outboundRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly pendingLifecycleUpdates: Array<{ sessionId: string; messageId: string; status: DiscordLifecycleStatus }> = [];
	private readonly reactionQueues = new Map<string, Promise<void>>();
	private readonly queuedReactionStatuses = new Map<string, DiscordLifecycleStatus>();
	private readonly desiredReactions = new Map<string, DiscordLifecycleMessage>();
	private drainingLifecycleUpdates = false;
	private started = false;

	constructor(
		private readonly config: DiscordBridgeConfig,
		private readonly state: DiscordStateStore,
		private readonly transport: DiscordTransport,
		private readonly onTerminalError: (error: Error) => void = () => {},
	) {}

	async start(): Promise<void> {
		if (this.started) return;
		await this.transport.connect(this.config);
		this.unsubscribeTerminal = this.transport.onTerminalError(this.onTerminalError);
		this.unsubscribe = this.transport.onMessage((message) => {
			this.inboundQueue = this.inboundQueue
				.then(() => this.receiveDiscordMessage(message))
				.catch(() => {});
			return this.inboundQueue;
		});
		this.started = true;
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.unsubscribeTerminal?.();
		this.unsubscribeTerminal = undefined;
		await this.inboundQueue;
		this.activeSessions.clear();
		this.reservedSessions.clear();
		this.clientSessions.clear();
		for (const timer of this.outboundRetryTimers.values()) clearTimeout(timer);
		this.outboundRetryTimers.clear();
		this.outboundRetryAttempts.clear();
		this.pendingLifecycleUpdates.length = 0;
		this.reactionQueues.clear();
		this.queuedReactionStatuses.clear();
		this.desiredReactions.clear();
		await this.transport.disconnect();
	}

	async prepareRegistration(clientId: string, generation: string, registration: RelaySessionRegistration): Promise<PreparedRegistration> {
		this.assertStarted();
		const activeOwner = this.activeSessions.get(registration.sessionId);
		const reservedOwner = this.reservedSessions.get(registration.sessionId);
		const owner = activeOwner ?? reservedOwner;
		if (owner && owner.clientId !== clientId) {
			throw new Error(`Pi session ${registration.sessionId} is already registered by another local client`);
		}
		this.reservedSessions.set(registration.sessionId, { clientId, generation });
		this.catchingUpSessions.add(registration.sessionId);
		try {
			const cwd = normalizeCwd(registration.cwd);
			const channelId = await this.state.resolveProjectChannel(cwd, (project) => {
				return this.transport.ensureProjectChannel({
					guildId: this.config.guildId,
					categoryId: this.config.categoryId,
					mappedChannelId: project.existingChannelId,
					name: project.name,
				});
			});
			const mapping = await this.state.resolveSessionThread(
				registration.sessionId,
				cwd,
				channelId,
				(mappedThreadId) => this.transport.ensureSessionThread({
					channelId,
					mappedThreadId,
					name: sessionThreadName(registration.sessionId, registration.sessionName),
				}),
			);
			const catchUp = this.inboundQueue.then(() => this.catchUp(registration.sessionId, mapping));
			this.inboundQueue = catchUp.catch(() => {});
			await catchUp;
			this.catchingUpSessions.delete(registration.sessionId);
			return { channelId, threadId: mapping.threadId };
		} catch (error) {
			const reserved = this.reservedSessions.get(registration.sessionId);
			if (reserved?.clientId === clientId && reserved.generation === generation) this.reservedSessions.delete(registration.sessionId);
			throw error;
		}
	}

	async activateRegistration(
		clientId: string,
		generation: string,
		sessionId: string,
		deliver: (message: QueuedDiscordMessage) => boolean,
	): Promise<void> {
		const reserved = this.reservedSessions.get(sessionId);
		if (reserved?.clientId !== clientId || reserved.generation !== generation) {
			throw new Error(`Pi session ${sessionId} was not reserved by client ${clientId}`);
		}
		const mapping = await this.state.getSession(sessionId);
		const pending = mapping?.pendingMessages ?? [];
		for (const message of pending) {
			const lifecycle = mapping?.lifecycleMessages.find((candidate) => candidate.messageId === message.id);
			if (lifecycle) this.scheduleReaction(lifecycle);
		}
		this.reservedSessions.delete(sessionId);
		const active: ActiveSession = { clientId, generation, deliver, deliveredIds: new Set() };
		this.activeSessions.set(sessionId, active);
		const sessions = this.clientSessions.get(clientId) ?? new Set<string>();
		sessions.add(sessionId);
		this.clientSessions.set(clientId, sessions);
		for (const message of pending) {
			if (!this.deliverMessage(active, message)) break;
		}
		void this.drainOutbound().catch(this.onTerminalError);
	}

	unregisterClient(clientId: string, generation: string): void {
		for (const [sessionId, owner] of this.reservedSessions) {
			if (owner.clientId === clientId && owner.generation === generation) this.reservedSessions.delete(sessionId);
		}
		for (const sessionId of this.clientSessions.get(clientId) ?? []) {
			const active = this.activeSessions.get(sessionId);
			if (active?.clientId === clientId && active.generation === generation) {
				this.activeSessions.delete(sessionId);
				this.clearOutboundRetry(sessionId);
			}
		}
		if (![...this.activeSessions.values()].some((active) => active.clientId === clientId)) this.clientSessions.delete(clientId);
	}

	async resumeDelivery(sessionId: string): Promise<void> {
		const active = this.activeSessions.get(sessionId);
		if (!active) return;
		for (const message of await this.state.pendingMessages(sessionId)) {
			if (!this.deliverMessage(active, message)) break;
		}
	}

	async acknowledge(clientId: string, generation: string, sessionId: string, messageId: string): Promise<void> {
		this.assertClientSession(clientId, generation, sessionId);
		await this.state.acknowledgeMessage(sessionId, messageId);
	}

	queueLifecycleUpdate(
		clientId: string,
		generation: string,
		sessionId: string,
		messageId: string,
		status: DiscordLifecycleStatus,
	): void {
		this.assertClientSession(clientId, generation, sessionId);
		let pendingStatus: DiscordLifecycleStatus | undefined;
		for (let index = this.pendingLifecycleUpdates.length - 1; index >= 0; index--) {
			const update = this.pendingLifecycleUpdates[index]!;
			if (update.sessionId === sessionId && update.messageId === messageId) {
				pendingStatus = update.status;
				break;
			}
		}
		if (pendingStatus === status || this.pendingLifecycleUpdates.length >= MAX_PENDING_LIFECYCLE_UPDATES) return;
		this.pendingLifecycleUpdates.push({ sessionId, messageId, status });
		void this.drainLifecycleUpdates();
	}

	async queueOutbound(
		clientId: string,
		generation: string,
		sessionId: string,
		messageId: string,
		kind: "user" | "assistant",
		text: string,
	): Promise<void> {
		this.assertClientSession(clientId, generation, sessionId);
		if (!text.trim()) return;
		const mapping = await this.state.getSession(sessionId);
		if (!mapping) throw new Error(`Pi session ${sessionId} has no Discord mapping`);
		const message: OutboundMessage = {
			id: messageId,
			kind,
			threadId: mapping.threadId,
			chunks: splitDiscordText(text).map((content, index) => ({
				index,
				content,
				nonce: createHash("sha256").update(`${messageId}:${index}`).digest("hex").slice(0, 25),
			})),
		};
		await this.state.enqueueOutbound(sessionId, message);
		void this.drainOutbound().catch(this.onTerminalError);
	}

	private async drainLifecycleUpdates(): Promise<void> {
		if (this.drainingLifecycleUpdates || !this.started) return;
		this.drainingLifecycleUpdates = true;
		try {
			while (this.started) {
				const update = this.pendingLifecycleUpdates.shift();
				if (!update) return;
				try {
					const lifecycle = await this.state.updateLifecycleStatus(update.sessionId, update.messageId, update.status);
					if (lifecycle && this.started) this.scheduleReaction(lifecycle);
				} catch {
					// Lifecycle status is best-effort and must not interfere with relay traffic.
				}
			}
		} finally {
			this.drainingLifecycleUpdates = false;
			if (this.started && this.pendingLifecycleUpdates.length > 0) void this.drainLifecycleUpdates();
		}
	}

	private scheduleReaction(message: DiscordLifecycleMessage, force = false): void {
		const key = `${message.channelId}\0${message.messageId}`;
		if (this.desiredReactions.has(key)) this.desiredReactions.delete(key);
		this.desiredReactions.set(key, message);
		while (this.desiredReactions.size > MAX_DESIRED_REACTIONS) {
			this.desiredReactions.delete(this.desiredReactions.keys().next().value!);
		}
		if (!force && this.queuedReactionStatuses.get(key) === message.status) return;
		this.queuedReactionStatuses.set(key, message.status);
		const previous = this.reactionQueues.get(key) ?? Promise.resolve();
		const next = previous
			.catch(() => {})
			.then(async () => {
				if (!this.started) return;
				const operation = this.transport.setLifecycleReaction(
					message.channelId,
					message.messageId,
					lifecycleReaction(message.status),
				);
				if (await boundedReaction(operation)) return;
				void operation.catch(() => {}).finally(() => {
					const desired = this.desiredReactions.get(key);
					if (this.started && desired) this.scheduleReaction(desired, true);
				});
			})
			.catch(() => {});
		this.reactionQueues.set(key, next);
		void next.finally(() => {
			if (this.reactionQueues.get(key) !== next) return;
			this.reactionQueues.delete(key);
			if (this.queuedReactionStatuses.get(key) === message.status) this.queuedReactionStatuses.delete(key);
		});
	}

	private async drainOutbound(): Promise<void> {
		if (!this.started) return;
		if (this.drainingOutbound) {
			this.outboundDrainRequested = true;
			return;
		}
		this.drainingOutbound = true;
		this.outboundDrainRequested = false;
		try {
			const blockedSessions = new Set(this.outboundRetryTimers.keys());
			for (;;) {
				const next = await this.state.nextOutbound(new Set(this.activeSessions.keys()), blockedSessions);
				if (!next) return;
				let deliveryFailed = false;
				for (const chunk of next.message.chunks) {
					if (chunk.discordMessageId) continue;
					let discordMessageId: string;
					try {
						discordMessageId = await this.transport.sendText(next.message.threadId, chunk.content, chunk.nonce);
					} catch {
						blockedSessions.add(next.sessionId);
						this.scheduleOutboundRetry(next.sessionId);
						deliveryFailed = true;
						break;
					}
					await this.state.markOutboundChunkSent(next.sessionId, next.message.id, chunk.index, discordMessageId);
				}
				if (!deliveryFailed) {
					await this.state.completeOutbound(next.sessionId, next.message.id);
					this.clearOutboundRetry(next.sessionId);
				}
			}
		} finally {
			this.drainingOutbound = false;
			if (this.outboundDrainRequested && this.started) {
				this.outboundDrainRequested = false;
				void this.drainOutbound().catch(this.onTerminalError);
			}
		}
	}

	private scheduleOutboundRetry(sessionId: string): void {
		if (this.outboundRetryTimers.has(sessionId) || !this.activeSessions.has(sessionId)) return;
		const attempt = (this.outboundRetryAttempts.get(sessionId) ?? 0) + 1;
		this.outboundRetryAttempts.set(sessionId, attempt);
		const delay = Math.min(OUTBOUND_RETRY_MIN_MS * 2 ** Math.min(attempt - 1, 6), OUTBOUND_RETRY_MAX_MS);
		const timer = setTimeout(() => {
			this.outboundRetryTimers.delete(sessionId);
			if (this.started && this.activeSessions.has(sessionId)) void this.drainOutbound().catch(this.onTerminalError);
		}, delay);
		timer.unref();
		this.outboundRetryTimers.set(sessionId, timer);
	}

	private clearOutboundRetry(sessionId: string): void {
		const timer = this.outboundRetryTimers.get(sessionId);
		if (timer) clearTimeout(timer);
		this.outboundRetryTimers.delete(sessionId);
		this.outboundRetryAttempts.delete(sessionId);
	}

	private async catchUp(sessionId: string, mapping: SessionThreadMapping): Promise<void> {
		const missed = await this.transport.fetchMessagesAfter(mapping.threadId, mapping.threadCursors[mapping.threadId]);
		for (const message of missed) await this.recordMessage(sessionId, message, false, true);
	}

	private async receiveDiscordMessage(message: DiscordInboundMessage): Promise<void> {
		const matched = await this.state.findSessionByThread(message.channelId);
		if (!matched) return;
		await this.recordMessage(matched.sessionId, message, true);
	}

	private async recordMessage(
		sessionId: string,
		message: DiscordInboundMessage,
		deliver: boolean,
		advanceCursor = !this.catchingUpSessions.has(sessionId),
	): Promise<void> {
		const result = await this.state.recordDiscordMessage(sessionId, message, advanceCursor);
		if (result.lifecycle) this.scheduleReaction(result.lifecycle);
		if (!result.queued || !result.message || !deliver) return;
		const active = this.activeSessions.get(sessionId);
		if (active) this.deliverMessage(active, result.message);
	}

	private deliverMessage(active: ActiveSession, message: QueuedDiscordMessage): boolean {
		if (active.deliveredIds.has(message.id)) return true;
		if (!active.deliver(message)) return false;
		active.deliveredIds.add(message.id);
		return true;
	}

	private assertClientSession(clientId: string, generation: string, sessionId: string): void {
		const active = this.activeSessions.get(sessionId);
		if (active?.clientId !== clientId || active.generation !== generation) {
			throw new Error(`Local client ${clientId} is not registered for Pi session ${sessionId}`);
		}
	}

	private assertStarted(): void {
		if (!this.started) throw new Error("Discord relay is not started");
	}
}
