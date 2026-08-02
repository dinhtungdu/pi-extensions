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
import { resolveProjectIdentity } from "./project-identity.js";
import { normalizeCwd, sessionThreadName, splitDiscordText } from "./text.js";
import type { DiscordInboundMessage, DiscordTransport } from "./transport.js";
import {
	boundedControlResult,
	isPiThinkingLevel,
	MAX_RECENT_SESSION_CONTROLS,
	MAX_SESSION_CONTROL_QUEUE,
	MAX_SESSION_CONTROL_TEXT_LENGTH,
	modelAutocompleteChoices,
	modelChoiceValue,
	type DiscordModelChoice,
	type DiscordSessionControlRequest,
	type PiModelCatalogueEntry,
	type PiSessionControlRequest,
	type PiSessionControlResult,
} from "./controls.js";

export interface RelaySessionRegistration {
	cwd: string;
	projectIdentityResolved?: boolean;
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
	threadId: string;
	deliver(message: QueuedDiscordMessage): boolean;
	deliveredIds: Set<string>;
	modelCatalogue: PiModelCatalogueEntry[];
	executeControl?: (request: PiSessionControlRequest) => Promise<PiSessionControlResult>;
}

const OUTBOUND_RETRY_MIN_MS = 100;
const OUTBOUND_RETRY_MAX_MS = 5_000;
const REACTION_TIMEOUT_MS = 2_000;
const MAX_PENDING_LIFECYCLE_UPDATES = 256;
const MAX_DESIRED_REACTIONS = 2_000;
const SUMMARY_RETRY_MIN_MS = 250;
const SUMMARY_RETRY_MAX_MS = 30_000;

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
	private readonly activeThreadSessions = new Map<string, string>();
	private readonly catchingUpSessions = new Set<string>();
	private unsubscribe: (() => void) | undefined;
	private unsubscribeControls: (() => void) | undefined;
	private unsubscribeAutocomplete: (() => void) | undefined;
	private unsubscribeTerminal: (() => void) | undefined;
	private readonly controlQueues = new Map<string, Promise<void>>();
	private readonly controlQueueDepths = new Map<string, number>();
	private readonly inFlightControls = new Map<string, Promise<PiSessionControlResult>>();
	private readonly completedControls = new Map<string, PiSessionControlResult>();
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
	private readonly summaryReconciliations = new Map<string, Promise<void>>();
	private readonly summaryReconcileRequested = new Set<string>();
	private readonly summaryRetryAttempts = new Map<string, number>();
	private readonly summaryRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
		this.unsubscribeControls = this.transport.onSessionControl((request) => this.executeDiscordControl(request));
		this.unsubscribeAutocomplete = this.transport.onModelAutocomplete((channelId, prefix) => {
			return this.modelAutocomplete(channelId, prefix);
		});
		this.started = true;
		for (const { cwd } of await this.state.projectSummaries()) this.scheduleProjectSummaryReconciliation(cwd);
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.unsubscribeControls?.();
		this.unsubscribeControls = undefined;
		this.unsubscribeAutocomplete?.();
		this.unsubscribeAutocomplete = undefined;
		this.unsubscribeTerminal?.();
		this.unsubscribeTerminal = undefined;
		await this.inboundQueue;
		this.activeSessions.clear();
		this.activeThreadSessions.clear();
		this.reservedSessions.clear();
		this.clientSessions.clear();
		this.controlQueues.clear();
		this.controlQueueDepths.clear();
		this.inFlightControls.clear();
		this.completedControls.clear();
		for (const timer of this.outboundRetryTimers.values()) clearTimeout(timer);
		this.outboundRetryTimers.clear();
		this.outboundRetryAttempts.clear();
		this.pendingLifecycleUpdates.length = 0;
		this.reactionQueues.clear();
		this.queuedReactionStatuses.clear();
		this.desiredReactions.clear();
		for (const timer of this.summaryRetryTimers.values()) clearTimeout(timer);
		this.summaryRetryTimers.clear();
		this.summaryRetryAttempts.clear();
		this.summaryReconcileRequested.clear();
		await Promise.allSettled(this.summaryReconciliations.values());
		this.summaryReconciliations.clear();
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
			const cwd = registration.projectIdentityResolved
				? normalizeCwd(registration.cwd)
				: await resolveProjectIdentity(registration.cwd);
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
		controls?: {
			modelCatalogue: PiModelCatalogueEntry[];
			execute(request: PiSessionControlRequest): Promise<PiSessionControlResult>;
		},
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
		const active: ActiveSession = {
			clientId,
			generation,
			threadId: mapping!.threadId,
			deliver,
			deliveredIds: new Set(),
			modelCatalogue: controls?.modelCatalogue.map((model) => ({ ...model })) ?? [],
			...(controls ? { executeControl: controls.execute } : {}),
		};
		const replaced = this.activeSessions.get(sessionId);
		if (replaced && this.activeThreadSessions.get(replaced.threadId) === sessionId) this.activeThreadSessions.delete(replaced.threadId);
		this.activeSessions.set(sessionId, active);
		this.activeThreadSessions.set(active.threadId, sessionId);
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
				if (this.activeThreadSessions.get(active.threadId) === sessionId) this.activeThreadSessions.delete(active.threadId);
				this.clearOutboundRetry(sessionId);
			}
		}
		if (![...this.activeSessions.values()].some((active) => active.clientId === clientId)) this.clientSessions.delete(clientId);
	}

	modelAutocomplete(channelId: string, prefix: string): DiscordModelChoice[] {
		const sessionId = this.activeThreadSessions.get(channelId);
		const active = sessionId ? this.activeSessions.get(sessionId) : undefined;
		return active?.executeControl ? modelAutocompleteChoices(active.modelCatalogue, prefix) : [];
	}

	async executeDiscordControl(request: DiscordSessionControlRequest): Promise<PiSessionControlResult> {
		const sessionId = this.activeThreadSessions.get(request.channelId);
		if (!sessionId) {
			const mapped = await this.state.findSessionByThread(request.channelId);
			return mapped
				? { ok: false, message: "The Pi session mapped to this thread is offline." }
				: { ok: false, message: "This Discord thread is not mapped to a Pi session." };
		}
		const active = this.activeSessions.get(sessionId);
		if (!active?.executeControl) return { ok: false, message: "The live Pi client does not support session controls; reconnect or reload it." };

		let action: PiSessionControlRequest["action"];
		if (request.action.type === "model") {
			const requestedModel = request.action.value;
			const model = active.modelCatalogue.find((candidate) => modelChoiceValue(candidate) === requestedModel);
			if (!model) return { ok: false, message: "Select a model from this session's current autocomplete catalogue." };
			action = { type: "model", provider: model.provider, modelId: model.id };
		} else if (request.action.type === "thinking") {
			if (!isPiThinkingLevel(request.action.level)) return { ok: false, message: "Invalid Pi thinking level." };
			action = { type: "thinking", level: request.action.level };
		} else if (request.action.type === "steer" || request.action.type === "followup") {
			if (!request.action.text || request.action.text.length > MAX_SESSION_CONTROL_TEXT_LENGTH) {
				return { ok: false, message: "Pi session control messages must contain 1-2000 characters." };
			}
			action = request.action;
		} else action = request.action;

		const control = { requestId: request.requestId, action };
		const mutating = action.type !== "status";
		if (mutating) {
			const completed = this.completedControls.get(request.requestId);
			if (completed) return { ...completed };
			const inFlight = this.inFlightControls.get(request.requestId);
			if (inFlight) return inFlight;
		}
		const depth = this.controlQueueDepths.get(sessionId) ?? 0;
		if (depth >= MAX_SESSION_CONTROL_QUEUE) return { ok: false, message: "Pi session control queue is full; retry later." };
		this.controlQueueDepths.set(sessionId, depth + 1);
		const previous = this.controlQueues.get(sessionId) ?? Promise.resolve();
		const execution = previous.catch(() => {}).then(async () => {
			if (this.activeSessions.get(sessionId) !== active || !active.executeControl) {
				return { ok: false, message: "The Pi session disconnected before this control executed." };
			}
			try {
				return boundedControlResult(await active.executeControl(control));
			} catch (error) {
				return boundedControlResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
			}
		});
		const tail = execution.then(() => {});
		this.controlQueues.set(sessionId, tail);
		if (mutating) this.inFlightControls.set(request.requestId, execution);
		return execution.then((result) => {
			if (mutating) {
				this.completedControls.set(request.requestId, result);
				while (this.completedControls.size > MAX_RECENT_SESSION_CONTROLS) {
					this.completedControls.delete(this.completedControls.keys().next().value!);
				}
			}
			return result;
		}).finally(() => {
			this.controlQueueDepths.set(sessionId, Math.max(0, (this.controlQueueDepths.get(sessionId) ?? 1) - 1));
			if (this.controlQueueDepths.get(sessionId) === 0) this.controlQueueDepths.delete(sessionId);
			if (this.controlQueues.get(sessionId) === tail) this.controlQueues.delete(sessionId);
			if (mutating && this.inFlightControls.get(request.requestId) === execution) this.inFlightControls.delete(request.requestId);
		});
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

	async queueProjectSummary(
		clientId: string,
		generation: string,
		sessionId: string,
		text: string,
	): Promise<void> {
		this.assertClientSession(clientId, generation, sessionId);
		if (!text || text.length > 2_000) throw new Error("Discord project summary must contain 1-2000 characters");
		const cwd = await this.state.setProjectSummaryDesired(sessionId, text);
		this.scheduleProjectSummaryReconciliation(cwd);
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

	private scheduleProjectSummaryReconciliation(cwd: string): void {
		if (!this.started) return;
		if (this.summaryReconciliations.has(cwd)) {
			this.summaryReconcileRequested.add(cwd);
			return;
		}
		if (this.summaryRetryTimers.has(cwd)) return;
		const reconciliation = this.reconcileProjectSummary(cwd)
			.catch(() => this.scheduleProjectSummaryRetry(cwd))
			.finally(() => {
				this.summaryReconciliations.delete(cwd);
				const requested = this.summaryReconcileRequested.delete(cwd);
				if (requested && !this.summaryRetryTimers.has(cwd)) this.scheduleProjectSummaryReconciliation(cwd);
			});
		this.summaryReconciliations.set(cwd, reconciliation);
	}

	private async reconcileProjectSummary(cwd: string): Promise<void> {
		for (let step = 0; step < 16 && this.started; step++) {
			const project = (await this.state.projectSummaries()).find((candidate) => candidate.cwd === cwd);
			if (!project) return;
			const { mapping, summary } = project;
			if (summary.pendingSend) {
				const pending = await this.state.prepareProjectSummarySend(cwd);
				if (!pending) continue;
				const messageId = await this.transport.sendText(mapping.channelId, pending.content, pending.nonce);
				await this.state.recordProjectSummarySent(cwd, pending.nonce, messageId);
				continue;
			}
			if (!summary.delivery) {
				await this.state.prepareProjectSummarySend(cwd);
				continue;
			}
			const latestMessageId = await this.transport.latestMessageId(mapping.channelId);
			if (latestMessageId === summary.delivery.messageId) {
				if (summary.delivery.content === summary.desiredText) {
					this.clearProjectSummaryRetry(cwd);
					return;
				}
				await this.transport.editOwnText(mapping.channelId, summary.delivery.messageId, summary.desiredText);
				await this.state.recordProjectSummaryEdited(cwd, summary.delivery.messageId, summary.desiredText);
				continue;
			}
			// Deletion must complete before replacement send. This intentionally leaves no summary
			// during a failed replacement rather than creating a duplicate.
			await this.transport.deleteOwnText(mapping.channelId, summary.delivery.messageId);
			await this.state.recordProjectSummaryDeleted(cwd, summary.delivery.messageId);
		}
		if (this.started) this.scheduleProjectSummaryRetry(cwd);
	}

	private scheduleProjectSummaryRetry(cwd: string): void {
		if (!this.started || this.summaryRetryTimers.has(cwd)) return;
		const attempt = (this.summaryRetryAttempts.get(cwd) ?? 0) + 1;
		this.summaryRetryAttempts.set(cwd, attempt);
		const delay = Math.min(SUMMARY_RETRY_MIN_MS * 2 ** Math.min(attempt - 1, 7), SUMMARY_RETRY_MAX_MS);
		const timer = setTimeout(() => {
			this.summaryRetryTimers.delete(cwd);
			this.scheduleProjectSummaryReconciliation(cwd);
		}, delay);
		timer.unref();
		this.summaryRetryTimers.set(cwd, timer);
	}

	private clearProjectSummaryRetry(cwd: string): void {
		const timer = this.summaryRetryTimers.get(cwd);
		if (timer) clearTimeout(timer);
		this.summaryRetryTimers.delete(cwd);
		this.summaryRetryAttempts.delete(cwd);
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
		if (matched) {
			await this.recordMessage(matched.sessionId, message, true);
			return;
		}
		const projectCwd = await this.state.findProjectByChannel(message.channelId);
		if (projectCwd) this.scheduleProjectSummaryReconciliation(projectCwd);
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
