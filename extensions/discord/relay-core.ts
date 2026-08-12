import { createHash, randomBytes } from "node:crypto";
import type { DiscordBridgeConfig } from "./config.js";
import {
	DiscordStateStore,
	type DiscordLifecycleMessage,
	type OutboundMessage,
	type ProjectSummaryState,
	type QueuedDiscordMessage,
	type SessionThreadMapping,
} from "./state.js";
import { lifecycleReaction, type DiscordLifecycleStatus } from "./reactions.js";
import { resolveProjectIdentity } from "./project-identity.js";
import { normalizeCwd, sessionThreadName, splitDiscordText } from "./text.js";
import type {
	DiscordInboundMessage,
	DiscordPresentationControlRequest,
	DiscordTransport,
} from "./transport.js";
import {
	appendInboundImageContext,
	InboundImageStore,
	TransientInboundImageError,
} from "./inbound-images.js";
import {
	boundedControlResult,
	isPiThinkingLevel,
	isActiveManagerTask,
	isPiManagerControlRequest,
	managerTargetAutocompleteChoices,
	managerTaskAutocompleteChoices,
	MAX_RECENT_SESSION_CONTROLS,
	MAX_SESSION_CONTROL_QUEUE,
	MAX_SESSION_CONTROL_TEXT_LENGTH,
	modelAutocompleteChoices,
	modelChoiceValue,
	type DiscordManagerControlRequest,
	type DiscordModelChoice,
	type DiscordSessionControlRequest,
	type ManagerProjectCatalogueEntry,
	type ManagerTaskCatalogueEntry,
	type PiManagerControlRequest,
	type PiModelCatalogueEntry,
	type PiSessionControlRequest,
	type PiSessionControlResult,
} from "./controls.js";
import { wakeManagerSession, type ManagerWakeDescriptor } from "./manager-wake.js";
import { isManagerTaskSnapshot, type ManagerTaskSnapshot } from "./manager-task-snapshot.js";
import { isManagerTaskTerminal, type ManagerTaskTerminal } from "./manager-task-terminal.js";
import {
	isSupportedManagerPresentationControl,
	SUPPORTED_MANAGER_PRESENTATION_CONTROLS,
	type ManagerPresentation,
} from "./manager-presentation.js";
import { paginateManagerPresentation } from "./manager-summary-pages.js";

export interface RelaySessionRegistration {
	cwd: string;
	projectIdentityResolved?: boolean;
	sessionId: string;
	sessionName?: string;
	managerTaskSummaryProducer?: true;
	managerWake?: ManagerWakeDescriptor | null;
	managerTaskSnapshotTaskId?: string;
	subscribeOwnerToThread?: true;
}

export interface PreparedRegistration {
	channelId: string;
	threadId: string;
	cwd: string;
}

interface ActiveSession {
	clientId: string;
	sessionId: string;
	generation: string;
	cwd: string;
	threadId: string;
	managerTaskSummaryProducer: boolean;
	managerTaskTerminalProducer: boolean;
	managerTaskSnapshotTaskId?: string;
	managerPresentationControlIds: string[]; managerPresentation?: ManagerPresentation;
	summaryProducerOrder: number;
	deliver(message: QueuedDiscordMessage): boolean;
	deliveredIds: Set<string>;
	acceptingInboundId?: string;
	modelCatalogue: PiModelCatalogueEntry[];
	executeControl?: (request: PiSessionControlRequest) => Promise<PiSessionControlResult>;
	managerTaskCatalogue: ManagerTaskCatalogueEntry[];
	managerProjectCatalogue: ManagerProjectCatalogueEntry[];
	managerAsk: boolean;
	executeManagerControl?: (request: PiManagerControlRequest) => Promise<PiSessionControlResult>;
	executePresentationControl?: (request: { requestId: string; revision: string; controlId: string; command: string }) => Promise<PiSessionControlResult>;
	inboundImages: boolean;
}

interface SummaryAuthorization {
	owner: ActiveSession;
	revision: number;
}

const OUTBOUND_RETRY_MIN_MS = 100;
const OUTBOUND_RETRY_MAX_MS = 5_000;
const REACTION_TIMEOUT_MS = 2_000;
const MAX_PENDING_LIFECYCLE_UPDATES = 256;
const MAX_DESIRED_REACTIONS = 2_000;
const SUMMARY_RETRY_MIN_MS = 250;
const SUMMARY_RETRY_MAX_MS = 30_000;
const TASK_SNAPSHOT_RETRY_MIN_MS = 250;
const TASK_SNAPSHOT_RETRY_MAX_MS = 30_000;
const TASK_TERMINAL_RETRY_MIN_MS = 250;
const TASK_TERMINAL_RETRY_MAX_MS = 30_000;
const INBOUND_RETRY_MIN_MS = 1_000;
const INBOUND_RETRY_MAX_MS = 30_000;
export const DISCORD_STATE_COMPACTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface DiscordRelayCoreDependencies {
	scheduleStateCompaction(run: () => Promise<void>): () => void;
	wakeManagerSession?(descriptor: ManagerWakeDescriptor, sessionId: string, messageId: string): Promise<void>;
}

function scheduleStateCompaction(run: () => Promise<void>): () => void {
	const timer = setInterval(() => void run(), DISCORD_STATE_COMPACTION_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}

function samePresentation(left: ManagerPresentation | undefined, right: ManagerPresentation | undefined): boolean {
	return left === undefined ? right === undefined : right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

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
	private readonly inboundCursorBlockedSessions = new Set<string>();
	private unsubscribe: (() => void) | undefined;
	private unsubscribeControls: (() => void) | undefined;
	private unsubscribeAutocomplete: (() => void) | undefined;
	private unsubscribeManagerControls: (() => void) | undefined;
	private unsubscribeManagerAutocomplete: (() => void) | undefined;
	private unsubscribePresentationControls: (() => void) | undefined;
	private unsubscribeTerminal: (() => void) | undefined;
	private readonly controlQueues = new Map<string, Promise<void>>();
	private readonly controlQueueDepths = new Map<string, number>();
	private readonly inFlightControls = new Map<string, Promise<PiSessionControlResult>>();
	private readonly completedControls = new Map<string, PiSessionControlResult>();
	private readonly managerControlQueues = new Map<string, Promise<void>>();
	private readonly managerControlQueueDepths = new Map<string, number>();
	private readonly inFlightManagerControls = new Map<string, Promise<PiSessionControlResult>>();
	private readonly completedManagerControls = new Map<string, PiSessionControlResult>();
	private readonly inFlightPresentationControls = new Map<string, { requestId: string; result: Promise<PiSessionControlResult> }>();
	private readonly completedPresentationControls = new Map<string, PiSessionControlResult>();
	private inboundQueue: Promise<void> = Promise.resolve();
	private drainingOutbound = false;
	private outboundDrainRequested = false;
	private readonly outboundRetryAttempts = new Map<string, number>();
	private readonly outboundRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly inboundRetryAttempts = new Map<string, number>();
	private readonly inboundRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly pendingLifecycleUpdates: Array<{ sessionId: string; messageId: string; status: DiscordLifecycleStatus }> = [];
	private readonly reactionQueues = new Map<string, Promise<void>>();
	private readonly queuedReactionStatuses = new Map<string, DiscordLifecycleStatus>();
	private readonly desiredReactions = new Map<string, DiscordLifecycleMessage>();
	private drainingLifecycleUpdates = false;
	private readonly summaryReconciliations = new Map<string, Promise<void>>();
	private readonly summaryReconcileRequested = new Set<string>();
	private readonly summaryRetryAttempts = new Map<string, number>();
	private readonly summaryRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly summaryAuthorizations = new Map<string, SummaryAuthorization>();
	private readonly summaryRevisions = new Map<string, number>();
	private readonly summaryOwners = new Map<string, ActiveSession>();
	private readonly summaryOwnerRetirements = new Map<string, Promise<void>>();
	private readonly taskSnapshotReconciliations = new Map<string, Promise<void>>();
	private readonly taskSnapshotReconcileRequested = new Set<string>();
	private readonly taskSnapshotRevisions = new Map<string, string>();
	private readonly taskSnapshotRetryAttempts = new Map<string, number>();
	private readonly taskSnapshotRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly taskTerminalReconciliations = new Map<string, Promise<void>>();
	private readonly taskTerminalReconcileRequested = new Set<string>();
	private readonly taskTerminalRevisions = new Map<string, string>();
	private readonly taskTerminalRetryAttempts = new Map<string, number>();
	private readonly taskTerminalRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly recentlyDisconnectedSessions = new Set<string>();
	private readonly wakeEpisodes = new Map<string, string>();
	private nextSummaryProducerOrder = 0;
	private cancelStateCompaction: (() => void) | undefined;
	private stateCompaction: Promise<void> | undefined;
	private started = false;

	constructor(
		private readonly config: DiscordBridgeConfig,
		private readonly state: DiscordStateStore,
		private readonly transport: DiscordTransport,
		private readonly onTerminalError: (error: Error) => void = () => {},
		private readonly imageStore?: InboundImageStore,
		private readonly dependencies: DiscordRelayCoreDependencies = { scheduleStateCompaction },
	) {}

	async start(): Promise<void> {
		if (this.started) return;
		if (this.imageStore) await this.imageStore.initialize(await this.state.pendingImagePaths());
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
		this.unsubscribeManagerControls = this.transport.onManagerControl((request) => this.executeDiscordManagerControl(request));
		this.unsubscribeManagerAutocomplete = this.transport.onManagerAutocomplete((channelId, prefix, kind) => {
			return this.managerAutocomplete(channelId, prefix, kind);
		});
		this.unsubscribePresentationControls = this.transport.onPresentationControl((request) => {
			return this.executeDiscordPresentationControl(request);
		});
		for (const { cwd, summary } of await this.state.projectSummaries()) {
			this.summaryRevisions.set(cwd, summary.revision);
		}
		for (const { sessionId, terminal } of await this.state.managerTaskTerminals()) {
			if (!terminal.archived) this.taskTerminalRevisions.set(sessionId, terminal.desired.revision);
		}
		this.started = true;
		if (this.taskTerminalRevisions.size > 0) {
			void this.drainOutbound().catch(this.onTerminalError);
			for (const sessionId of this.taskTerminalRevisions.keys()) this.scheduleManagerTaskTerminalReconciliation(sessionId);
		}
		this.cancelStateCompaction = this.dependencies.scheduleStateCompaction(() => this.compactInactiveState().catch((error) => {
			this.onTerminalError(error instanceof Error ? error : new Error(String(error)));
		}));
	}

	private protectedSessionIds(): ReadonlySet<string> {
		return new Set([
			...this.activeSessions.keys(),
			...this.reservedSessions.keys(),
			...this.catchingUpSessions,
			...this.recentlyDisconnectedSessions,
		]);
	}

	private compactInactiveState(): Promise<void> {
		if (!this.started) return Promise.resolve();
		if (this.stateCompaction) return this.stateCompaction;
		const operation = this.state.compact(() => this.protectedSessionIds()).then((protectedIds) => {
			for (const sessionId of protectedIds) this.recentlyDisconnectedSessions.delete(sessionId);
		});
		let tracked: Promise<void>;
		tracked = operation.finally(() => {
			if (this.stateCompaction === tracked) this.stateCompaction = undefined;
		});
		this.stateCompaction = tracked;
		return tracked;
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		this.cancelStateCompaction?.();
		this.cancelStateCompaction = undefined;
		let compactionError: unknown;
		try {
			await this.stateCompaction;
		} catch (error) {
			compactionError = error;
		}
		try {
			await this.state.compact(() => this.protectedSessionIds());
		} catch (error) {
			compactionError ??= error;
		}
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.unsubscribeControls?.();
		this.unsubscribeControls = undefined;
		this.unsubscribeAutocomplete?.();
		this.unsubscribeAutocomplete = undefined;
		this.unsubscribeManagerControls?.();
		this.unsubscribeManagerControls = undefined;
		this.unsubscribeManagerAutocomplete?.();
		this.unsubscribeManagerAutocomplete = undefined;
		this.unsubscribePresentationControls?.();
		this.unsubscribePresentationControls = undefined;
		this.unsubscribeTerminal?.();
		this.unsubscribeTerminal = undefined;
		await this.inboundQueue;
		this.activeSessions.clear();
		this.activeThreadSessions.clear();
		this.inboundCursorBlockedSessions.clear();
		this.reservedSessions.clear();
		this.catchingUpSessions.clear();
		this.recentlyDisconnectedSessions.clear();
		this.wakeEpisodes.clear();
		this.clientSessions.clear();
		this.controlQueues.clear();
		this.controlQueueDepths.clear();
		this.inFlightControls.clear();
		this.completedControls.clear();
		this.managerControlQueues.clear();
		this.managerControlQueueDepths.clear();
		this.inFlightManagerControls.clear();
		this.completedManagerControls.clear();
		this.inFlightPresentationControls.clear();
		this.completedPresentationControls.clear();
		for (const timer of this.outboundRetryTimers.values()) clearTimeout(timer);
		this.outboundRetryTimers.clear();
		this.outboundRetryAttempts.clear();
		for (const timer of this.inboundRetryTimers.values()) clearTimeout(timer);
		this.inboundRetryTimers.clear();
		this.inboundRetryAttempts.clear();
		this.pendingLifecycleUpdates.length = 0;
		this.reactionQueues.clear();
		this.queuedReactionStatuses.clear();
		this.desiredReactions.clear();
		for (const timer of this.summaryRetryTimers.values()) clearTimeout(timer);
		this.summaryRetryTimers.clear();
		this.summaryRetryAttempts.clear();
		this.summaryReconcileRequested.clear();
		this.summaryAuthorizations.clear();
		this.summaryRevisions.clear();
		await Promise.allSettled(this.summaryReconciliations.values());
		await Promise.allSettled(this.summaryOwnerRetirements.values());
		this.summaryReconciliations.clear();
		this.summaryOwners.clear();
		this.summaryOwnerRetirements.clear();
		for (const timer of this.taskSnapshotRetryTimers.values()) clearTimeout(timer);
		this.taskSnapshotRetryTimers.clear();
		this.taskSnapshotRetryAttempts.clear();
		this.taskSnapshotReconcileRequested.clear();
		this.taskSnapshotRevisions.clear();
		await Promise.allSettled(this.taskSnapshotReconciliations.values());
		this.taskSnapshotReconciliations.clear();
		for (const timer of this.taskTerminalRetryTimers.values()) clearTimeout(timer);
		this.taskTerminalRetryTimers.clear();
		this.taskTerminalRetryAttempts.clear();
		this.taskTerminalReconcileRequested.clear();
		this.taskTerminalRevisions.clear();
		await Promise.allSettled(this.taskTerminalReconciliations.values());
		this.taskTerminalReconciliations.clear();
		await this.transport.disconnect();
		if (compactionError) throw compactionError;
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
					...(registration.subscribeOwnerToThread ? { subscribeOwner: true as const } : {}),
				}),
				registration.managerWake,
				registration.managerTaskSnapshotTaskId,
			);
			const catchUp = this.inboundQueue.then(() => this.catchUp(registration.sessionId, mapping));
			this.inboundQueue = catchUp.catch(() => {});
			await catchUp;
			this.catchingUpSessions.delete(registration.sessionId);
			return { channelId, threadId: mapping.threadId, cwd: mapping.cwd };
		} catch (error) {
			this.catchingUpSessions.delete(registration.sessionId);
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
		inboundImages = false,
		managerControls?: {
			taskCatalogue: ManagerTaskCatalogueEntry[];
			projectCatalogue?: ManagerProjectCatalogueEntry[];
			execute(request: PiManagerControlRequest): Promise<PiSessionControlResult>;
		},
		managerTaskSummaryProducer = false,
		managerPresentation?: {
			controlIds: string[];
			execute(request: { requestId: string; revision: string; controlId: string; command: string }): Promise<PiSessionControlResult>;
		},
		managerTaskSnapshotTaskId?: string,
		managerTaskTerminalProducer = false,
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
			sessionId,
			generation,
			cwd: mapping!.cwd,
			threadId: mapping!.threadId,
			managerTaskSummaryProducer,
			managerTaskTerminalProducer,
			...(managerTaskSnapshotTaskId ? { managerTaskSnapshotTaskId } : {}),
			managerPresentationControlIds: managerPresentation?.controlIds.slice() ?? [],
			summaryProducerOrder: this.nextSummaryProducerOrder++,
			deliver,
			deliveredIds: new Set(),
			modelCatalogue: controls?.modelCatalogue.map((model) => ({ ...model })) ?? [],
			...(controls ? { executeControl: controls.execute } : {}),
			managerTaskCatalogue: managerControls?.taskCatalogue.map((task) => ({ ...task })) ?? [],
			managerProjectCatalogue: managerControls?.projectCatalogue?.map((project) => ({ ...project })) ?? [],
			managerAsk: managerControls?.projectCatalogue !== undefined,
			...(managerControls ? { executeManagerControl: managerControls.execute } : {}),
			...(managerPresentation ? { executePresentationControl: managerPresentation.execute } : {}),
			inboundImages,
		};
		const replaced = this.activeSessions.get(sessionId);
		if (replaced && this.activeThreadSessions.get(replaced.threadId) === sessionId) this.activeThreadSessions.delete(replaced.threadId);
		this.activeSessions.set(sessionId, active);
		this.activeThreadSessions.set(active.threadId, sessionId);
		this.wakeEpisodes.delete(sessionId);
		const sessions = this.clientSessions.get(clientId) ?? new Set<string>();
		sessions.add(sessionId);
		this.clientSessions.set(clientId, sessions);
		for (const message of pending) {
			if (!this.deliverMessage(active, message)) break;
		}
		if (this.inboundCursorBlockedSessions.has(sessionId)) this.scheduleInboundRetry(sessionId);
		if (managerTaskSnapshotTaskId && mapping?.managerTaskSnapshot?.desired.taskId === managerTaskSnapshotTaskId) {
			this.taskSnapshotRevisions.set(sessionId, mapping.managerTaskSnapshot.desired.revision);
			this.scheduleManagerTaskSnapshotReconciliation(sessionId);
		}
		if (managerTaskSummaryProducer) {
			const owner = this.summaryOwners.get(active.cwd);
			if (replaced && owner === replaced) this.retireManagerTaskSummaryOwner(active.cwd, replaced);
			else if (owner && !owner.executePresentationControl && active.executePresentationControl) {
				this.retireManagerTaskSummaryOwner(active.cwd, owner);
			} else if (!owner && !this.summaryOwnerRetirements.has(active.cwd)) this.summaryOwners.set(active.cwd, active);
		}
		void this.drainOutbound().catch(this.onTerminalError);
	}

	unregisterClient(clientId: string, generation: string): void {
		for (const [sessionId, owner] of this.reservedSessions) {
			if (owner.clientId === clientId && owner.generation === generation) {
				this.recentlyDisconnectedSessions.add(sessionId);
				this.reservedSessions.delete(sessionId);
			}
		}
		for (const sessionId of this.clientSessions.get(clientId) ?? []) {
			const active = this.activeSessions.get(sessionId);
			if (active?.clientId === clientId && active.generation === generation) {
				this.recentlyDisconnectedSessions.add(sessionId);
				this.activeSessions.delete(sessionId);
				if (this.activeThreadSessions.get(active.threadId) === sessionId) this.activeThreadSessions.delete(active.threadId);
				this.clearOutboundRetry(sessionId);
				this.cancelInboundRetry(sessionId);
				if (this.summaryOwners.get(active.cwd) === active) this.retireManagerTaskSummaryOwner(active.cwd, active);
				this.inboundQueue = this.inboundQueue.then(async () => {
					if (this.activeSessions.has(sessionId)) return;
					const pending = await this.state.pendingMessages(sessionId);
					if (pending[0]) await this.wakeOfflineManager(sessionId, pending[0].id);
				}).catch((error) => this.onTerminalError(error instanceof Error ? error : new Error(String(error))));
			}
		}
		if (![...this.activeSessions.values()].some((active) => active.clientId === clientId)) this.clientSessions.delete(clientId);
	}

	modelAutocomplete(channelId: string, prefix: string): DiscordModelChoice[] {
		const sessionId = this.activeThreadSessions.get(channelId);
		const active = sessionId ? this.activeSessions.get(sessionId) : undefined;
		return active?.executeControl ? modelAutocompleteChoices(active.modelCatalogue, prefix) : [];
	}

	managerAutocomplete(channelId: string, prefix: string, kind: "task" | "target"): DiscordModelChoice[] {
		const sessionId = this.activeThreadSessions.get(channelId);
		const active = sessionId ? this.activeSessions.get(sessionId) : undefined;
		if (!active?.executeManagerControl) return [];
		return kind === "task"
			? managerTaskAutocompleteChoices(active.managerTaskCatalogue, prefix)
			: active.managerAsk ? managerTargetAutocompleteChoices(active.managerProjectCatalogue, active.managerTaskCatalogue, prefix) : [];
	}

	updateManagerCatalogues(
		clientId: string,
		generation: string,
		sessionId: string,
		tasks: readonly ManagerTaskCatalogueEntry[],
		projects?: readonly ManagerProjectCatalogueEntry[],
	): void {
		this.assertClientSession(clientId, generation, sessionId);
		const active = this.activeSessions.get(sessionId)!;
		if (!active.executeManagerControl) throw new Error("Local client is not registered for manager controls");
		active.managerTaskCatalogue = tasks.map((task) => ({ ...task }));
		if (projects) {
			active.managerProjectCatalogue = projects.map((project) => ({ ...project }));
			active.managerAsk = true;
		}
	}

	async executeDiscordManagerControl(request: DiscordManagerControlRequest): Promise<PiSessionControlResult> {
		const sessionId = this.activeThreadSessions.get(request.channelId);
		if (!sessionId) {
			const mapped = await this.state.findSessionByThread(request.channelId);
			return mapped
				? { ok: false, message: "The manager session mapped to this thread is offline." }
				: { ok: false, message: "This Discord thread is not mapped to a Pi session." };
		}
		const active = this.activeSessions.get(sessionId);
		if (!active?.executeManagerControl) {
			return { ok: false, message: "This live Pi session is not a verified the-manager client." };
		}
		if (!isPiManagerControlRequest(request)) return { ok: false, message: "Invalid manager control request." };
		if (request.action === "ask" && !active.managerAsk) {
			return { ok: false, message: "This verified manager client does not support ask; reconnect or reload it." };
		}
		const isCurrent = () => {
			if (request.action === "ask") {
				return request.target.startsWith("project:")
					? active.managerProjectCatalogue.some((project) => `project:${project.projectId}` === request.target)
					: active.managerTaskCatalogue.some((task) => isActiveManagerTask(task) && `task:${task.taskId}` === request.target);
			}
			if (request.action === "reconcile-pr" && request.taskId === undefined) return true;
			return active.managerTaskCatalogue.some((task) => task.taskId === request.taskId);
		};
		if (!isCurrent()) {
			return {
				ok: false,
				message: request.action === "ask"
					? "Select a target from this manager session's current autocomplete catalogue."
					: "Select a task from this manager session's current autocomplete catalogue.",
			};
		}
		const completed = this.completedManagerControls.get(request.requestId);
		if (completed) return { ...completed };
		const inFlight = this.inFlightManagerControls.get(request.requestId);
		if (inFlight) return inFlight;
		const depth = this.managerControlQueueDepths.get(sessionId) ?? 0;
		if (depth >= MAX_SESSION_CONTROL_QUEUE) return { ok: false, message: "Manager control queue is full; retry later." };
		this.managerControlQueueDepths.set(sessionId, depth + 1);
		const previous = this.managerControlQueues.get(sessionId) ?? Promise.resolve();
		const execution = previous.catch(() => {}).then(async () => {
			if (this.activeSessions.get(sessionId) !== active || !active.executeManagerControl) {
				return { ok: false, message: "The manager session disconnected before this control executed." };
			}
			if (!isCurrent()) {
				return { ok: false, message: `The selected ${request.action === "ask" ? "target" : "task"} became stale before this control executed.` };
			}
			try {
				const control: PiManagerControlRequest = request.action === "ask"
					? { requestId: request.requestId, action: "ask", target: request.target, request: request.request }
					: request.action === "reconcile-pr"
						? { requestId: request.requestId, action: "reconcile-pr", ...(request.taskId ? { taskId: request.taskId } : {}) }
						: { requestId: request.requestId, action: request.action, taskId: request.taskId };
				return boundedControlResult(await active.executeManagerControl(control));
			} catch (error) {
				return boundedControlResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
			}
		});
		const tail = execution.then(() => {});
		this.managerControlQueues.set(sessionId, tail);
		this.inFlightManagerControls.set(request.requestId, execution);
		return execution.then((result) => {
			this.completedManagerControls.set(request.requestId, result);
			while (this.completedManagerControls.size > MAX_RECENT_SESSION_CONTROLS) {
				this.completedManagerControls.delete(this.completedManagerControls.keys().next().value!);
			}
			return result;
		}).finally(() => {
			this.managerControlQueueDepths.set(sessionId, Math.max(0, (this.managerControlQueueDepths.get(sessionId) ?? 1) - 1));
			if (this.managerControlQueueDepths.get(sessionId) === 0) this.managerControlQueueDepths.delete(sessionId);
			if (this.managerControlQueues.get(sessionId) === tail) this.managerControlQueues.delete(sessionId);
			if (this.inFlightManagerControls.get(request.requestId) === execution) this.inFlightManagerControls.delete(request.requestId);
		});
	}

	executeDiscordPresentationControl(request: DiscordPresentationControlRequest): Promise<PiSessionControlResult> {
		const completed = this.completedPresentationControls.get(request.requestId);
		if (completed) return Promise.resolve({ ...completed });
		const interactionKey = `interaction:${request.requestId}`;
		const duplicate = this.inFlightPresentationControls.get(interactionKey);
		if (duplicate) return duplicate.result;
		const channelKey = `channel:${request.channelId}`;
		if (this.inFlightPresentationControls.has(channelKey)) {
			return Promise.resolve({ ok: false, message: "A manager presentation control is already running; retry later." });
		}
		let resolveResult!: (result: PiSessionControlResult) => void;
		let rejectResult!: (error: unknown) => void;
		const result = new Promise<PiSessionControlResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
		const reservation = { requestId: request.requestId, result };
		this.inFlightPresentationControls.set(interactionKey, reservation);
		this.inFlightPresentationControls.set(channelKey, reservation);
		void this.executeCurrentPresentationControl(request).then((settled) => {
			this.completedPresentationControls.set(request.requestId, settled);
			while (this.completedPresentationControls.size > MAX_RECENT_SESSION_CONTROLS)
				this.completedPresentationControls.delete(this.completedPresentationControls.keys().next().value!);
			return settled;
		}).then(resolveResult, rejectResult).finally(() => {
			if (this.inFlightPresentationControls.get(interactionKey) === reservation) this.inFlightPresentationControls.delete(interactionKey);
			if (this.inFlightPresentationControls.get(channelKey) === reservation) this.inFlightPresentationControls.delete(channelKey);
		});
		return result;
	}

	private async executeCurrentPresentationControl(request: DiscordPresentationControlRequest): Promise<PiSessionControlResult> {
		if (request.guildId !== this.config.guildId) return { ok: false, message: "This manager control is not authorized." };
		const custom = /^m:([a-f0-9]{64}):([a-z0-9-]+)$/.exec(request.customId);
		if (!custom || !SUPPORTED_MANAGER_PRESENTATION_CONTROLS.includes(custom[2]!)) {
			return { ok: false, message: "This manager control is malformed or unsupported." };
		}
		const project = await this.state.projectSummaryByChannel(request.channelId);
		if (!project) return { ok: false, message: "This manager control is not mapped to a current project summary." };
		const owner = this.summaryOwners.get(project.cwd);
		const authorization = this.summaryAuthorizations.get(project.cwd);
		const desired = project.summary.desiredPresentation;
		const delivered = project.summary.delivery?.presentation;
		const control = desired?.controls.find((candidate) => candidate.id === custom[2]);
		if (!owner?.executePresentationControl || this.activeSessions.get(owner.sessionId) !== owner ||
			!authorization || authorization.owner !== owner || authorization.revision !== project.summary.revision ||
			project.summary.delivery?.messageId !== request.messageId || desired?.revision !== custom[1] ||
			delivered?.revision !== custom[1] || !control || !isSupportedManagerPresentationControl(control.id, control.command)) {
			return { ok: false, message: "This manager control is stale or no longer authorized." };
		}
		const execution = (async () => {
			let result: PiSessionControlResult;
			try {
				result = boundedControlResult(await owner.executePresentationControl!({
					requestId: request.requestId,
					revision: custom[1]!,
					controlId: control.id,
					command: control.command,
				}));
			} catch (error) {
				result = boundedControlResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
			}
			if (this.summaryOwners.get(project.cwd) !== owner || this.activeSessions.get(owner.sessionId) !== owner) {
				return { ok: false, message: "The manager presentation owner disconnected while the control was running." };
			}
			return result;
		})();
		return execution;
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
		if (!active || (await this.state.getSession(sessionId))?.managerTaskTerminal) return;
		for (const message of await this.state.pendingMessages(sessionId)) {
			if (!this.deliverMessage(active, message)) break;
		}
	}

	async acknowledge(clientId: string, generation: string, sessionId: string, messageId: string): Promise<void> {
		this.assertClientSession(clientId, generation, sessionId);
		const active = this.activeSessions.get(sessionId)!;
		if (active.acceptingInboundId !== messageId) return;
		await this.state.acknowledgeMessage(sessionId, messageId);
		active.acceptingInboundId = undefined;
		await this.resumeDelivery(sessionId);
	}

	async releaseInboundImages(clientId: string, generation: string, sessionId: string, messageId: string): Promise<void> {
		this.assertClientSession(clientId, generation, sessionId);
		const paths = await this.state.releaseMessageImages(sessionId, messageId);
		await this.imageStore?.remove(paths).catch(() => {});
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
		const active = this.activeSessions.get(sessionId)!;
		if (!active.managerTaskSummaryProducer) throw new Error("Local client is not registered as a manager task-summary producer");
		await this.queueSummary(active, text);
	}

	async queueManagerPresentation(
		clientId: string,
		generation: string,
		sessionId: string,
		presentation: ManagerPresentation,
	): Promise<void> {
		this.assertClientSession(clientId, generation, sessionId);
		const active = this.activeSessions.get(sessionId)!;
		if (!active.executePresentationControl) throw new Error("Local client did not negotiate manager presentation support");
		if (presentation.controls.some((control) => !active.managerPresentationControlIds.includes(control.id))) {
			throw new Error("Manager presentation contains an unsupported control");
		}
		active.managerPresentation = structuredClone(presentation);
		if (this.summaryOwners.get(active.cwd) === active) await this.queueSummary(active, presentation.content, presentation);
	}

	async queueManagerTaskSnapshot(
		clientId: string,
		generation: string,
		sessionId: string,
		snapshot: ManagerTaskSnapshot,
	): Promise<void> {
		this.assertClientSession(clientId, generation, sessionId);
		if (!isManagerTaskSnapshot(snapshot)) throw new Error("Discord manager task snapshot is invalid");
		const active = this.activeSessions.get(sessionId)!;
		if (!active.managerTaskSnapshotTaskId || active.managerTaskSnapshotTaskId !== snapshot.taskId) {
			throw new Error("Local client is not registered for this manager task snapshot");
		}
		const update = await this.state.setManagerTaskSnapshotDesired(sessionId, snapshot);
		if (!update.accepted) return;
		this.taskSnapshotRevisions.set(sessionId, snapshot.revision);
		this.clearManagerTaskSnapshotRetry(sessionId);
		this.scheduleManagerTaskSnapshotReconciliation(sessionId);
	}

	async queueManagerTaskTerminal(
		clientId: string,
		generation: string,
		sessionId: string,
		terminal: ManagerTaskTerminal,
	): Promise<void> {
		this.assertClientSession(clientId, generation, sessionId);
		if (!isManagerTaskTerminal(terminal)) throw new Error("Discord manager task terminal is invalid");
		const producer = this.activeSessions.get(sessionId)!;
		if (!producer.managerTaskTerminalProducer) {
			throw new Error("Local client is not registered as a manager task-terminal producer");
		}
		const update = await this.state.setManagerTaskTerminalDesired(terminal);
		this.taskTerminalRevisions.set(update.sessionId, update.revision);
		const target = this.activeSessions.get(update.sessionId);
		if (target && this.activeThreadSessions.get(target.threadId) === update.sessionId) {
			this.activeThreadSessions.delete(target.threadId);
		}
		this.wakeEpisodes.delete(update.sessionId);
		this.cancelInboundRetry(update.sessionId);
		this.taskSnapshotRevisions.delete(update.sessionId);
		this.clearManagerTaskSnapshotRetry(update.sessionId);
		this.clearManagerTaskTerminalRetry(update.sessionId);
		void this.drainOutbound().catch(this.onTerminalError);
		this.scheduleManagerTaskTerminalReconciliation(update.sessionId);
	}

	private async queueSummary(active: ActiveSession, text: string, presentation?: ManagerPresentation): Promise<void> {
		await this.summaryOwnerRetirements.get(active.cwd)?.catch(() => {});
		if (this.summaryOwners.get(active.cwd) !== active) return;
		// Order every durable intent after the current owner's Discord mutation settles.
		await this.summaryReconciliations.get(active.cwd)?.catch(() => {});
		if (this.summaryOwners.get(active.cwd) !== active) return;
		let revision = (this.summaryRevisions.get(active.cwd) ?? 0) + 1;
		this.summaryRevisions.set(active.cwd, revision);
		let update = await this.state.setProjectSummaryDesired(active.sessionId, text, revision, presentation);
		if (!update.accepted && update.revision >= revision &&
			this.summaryOwners.get(active.cwd) === active && this.summaryRevisions.get(active.cwd) === revision) {
			revision = update.revision + 1;
			this.summaryRevisions.set(active.cwd, revision);
			update = await this.state.setProjectSummaryDesired(active.sessionId, text, revision, presentation);
		}
		if (!update.accepted || this.summaryOwners.get(active.cwd) !== active || this.summaryRevisions.get(active.cwd) !== revision) return;
		this.summaryAuthorizations.set(active.cwd, { owner: active, revision });
		this.clearProjectSummaryRetry(active.cwd);
		this.scheduleProjectSummaryReconciliation(active.cwd);
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

	private electManagerTaskSummaryOwner(cwd: string): ActiveSession | undefined {
		return [...this.activeSessions.entries()]
			.filter(([, active]) => active.managerTaskSummaryProducer && active.cwd === cwd)
			.sort(([leftId, left], [rightId, right]) =>
				Number(Boolean(right.executePresentationControl)) - Number(Boolean(left.executePresentationControl)) ||
				left.summaryProducerOrder - right.summaryProducerOrder || leftId.localeCompare(rightId))[0]?.[1];
	}

	private retireManagerTaskSummaryOwner(cwd: string, owner: ActiveSession): void {
		if (this.summaryOwners.get(cwd) !== owner || this.summaryOwnerRetirements.has(cwd)) return;
		const authorization = this.summaryAuthorizations.get(cwd);
		// Replace any detached retry timer with an awaited retirement recovery loop;
		// durable pending-send state and its nonce remain untouched.
		this.clearProjectSummaryRetry(cwd);
		const settlement = this.summaryReconciliations.get(cwd) ?? Promise.resolve();
		let retirement: Promise<void>;
		retirement = settlement.catch(() => {}).then(async () => {
			if (authorization?.owner === owner) await this.settleRetiringProjectSummary(cwd, authorization);
			if (this.summaryOwners.get(cwd) !== owner) return;
			const project = (await this.state.projectSummaries()).find((candidate) => candidate.cwd === cwd);
			const desired = project?.summary.desiredPresentation;
			if (project && desired?.controls.length) {
				const revision = Math.max(this.summaryRevisions.get(cwd) ?? 0, project.summary.revision) + 1;
				this.summaryRevisions.set(cwd, revision);
				const stripped: ManagerPresentation = { ...desired, controls: [] };
				const update = await this.state.setProjectSummaryDesired(owner.sessionId, stripped.content, revision, stripped);
				if (update.accepted) {
					const strippedAuthorization = { owner, revision };
					this.summaryAuthorizations.set(cwd, strippedAuthorization);
					await this.settleRetiringProjectSummary(cwd, strippedAuthorization);
				}
			}
			if (this.summaryAuthorizations.get(cwd)?.owner === owner) this.summaryAuthorizations.delete(cwd);
			const next = this.electManagerTaskSummaryOwner(cwd);
			if (next) this.summaryOwners.set(cwd, next);
			else this.summaryOwners.delete(cwd);
		}).finally(() => {
			if (this.summaryOwnerRetirements.get(cwd) !== retirement) return;
			this.summaryOwnerRetirements.delete(cwd); const promoted = this.summaryOwners.get(cwd);
			if (promoted?.managerPresentation)
				void this.queueSummary(promoted, promoted.managerPresentation.content, promoted.managerPresentation).catch(this.onTerminalError);
		});
		this.summaryOwnerRetirements.set(cwd, retirement);
	}

	private async settleRetiringProjectSummary(cwd: string, authorization: SummaryAuthorization): Promise<void> {
		while (this.isCurrentSummaryAuthorization(cwd, authorization)) {
			try {
				await this.reconcileProjectSummary(cwd, authorization);
				const project = (await this.state.projectSummaries()).find((candidate) => candidate.cwd === cwd);
				if (project?.summary.revision === authorization.revision && !project.summary.pendingSend &&
					project.summary.delivery?.content === project.summary.desiredText &&
					samePresentation(project.summary.delivery?.presentation, project.summary.desiredPresentation) &&
					(project.summary.desiredPresentation ||
						await this.transport.latestMessageId(project.mapping.channelId) === project.summary.delivery.messageId)) return;
			} catch {
				// Keep the old owner authoritative until uncertain transport state is durably recovered.
			}
			await new Promise<void>((resolve) => setTimeout(resolve, SUMMARY_RETRY_MIN_MS));
		}
	}

	private isCurrentSummaryAuthorization(cwd: string, authorization: SummaryAuthorization): boolean {
		return this.started && this.summaryAuthorizations.get(cwd) === authorization &&
			this.summaryRevisions.get(cwd) === authorization.revision &&
			this.summaryOwners.get(cwd) === authorization.owner;
	}

	private scheduleProjectSummaryReconciliation(cwd: string): void {
		const authorization = this.summaryAuthorizations.get(cwd);
		if (!authorization || !this.isCurrentSummaryAuthorization(cwd, authorization)) return;
		if (this.summaryReconciliations.has(cwd)) {
			this.summaryReconcileRequested.add(cwd);
			return;
		}
		if (this.summaryRetryTimers.has(cwd)) return;
		const reconciliation = this.reconcileProjectSummary(cwd, authorization)
			.catch(() => this.scheduleProjectSummaryRetry(cwd))
			.finally(() => {
				this.summaryReconciliations.delete(cwd);
				const requested = this.summaryReconcileRequested.delete(cwd);
				if (requested && !this.summaryRetryTimers.has(cwd)) this.scheduleProjectSummaryReconciliation(cwd);
			});
		this.summaryReconciliations.set(cwd, reconciliation);
	}

	private async reconcileProjectSummary(cwd: string, authorization: SummaryAuthorization): Promise<void> {
		for (let step = 0; step < 16 && this.isCurrentSummaryAuthorization(cwd, authorization); step++) {
			const project = (await this.state.projectSummaries()).find((candidate) => candidate.cwd === cwd);
			if (!project || project.summary.revision !== authorization.revision ||
				!this.isCurrentSummaryAuthorization(cwd, authorization)) return;
			const { mapping, summary } = project;
			if (summary.pendingSend) {
				const pending = await this.state.prepareProjectSummarySend(cwd, authorization.revision);
				if (!pending || !this.isCurrentSummaryAuthorization(cwd, authorization)) return;
				const messageId = pending.presentation
					? await this.transport.sendPresentation(mapping.channelId, pending.presentation, pending.nonce)
					: await this.transport.sendText(mapping.channelId, pending.content, pending.nonce);
				await this.state.recordProjectSummarySent(cwd, pending.nonce, messageId, authorization.revision);
				continue;
			}
			if (summary.desiredPresentation) {
				await this.replaceManagerSummaryBatch(cwd, mapping.channelId, summary, authorization);
				this.clearProjectSummaryRetry(cwd);
				return;
			}
			if (!summary.delivery) {
				await this.state.prepareProjectSummarySend(cwd, authorization.revision);
				continue;
			}
			if (!this.isCurrentSummaryAuthorization(cwd, authorization)) return;
			const latestMessageId = await this.transport.latestMessageId(mapping.channelId);
			if (!this.isCurrentSummaryAuthorization(cwd, authorization)) return;
			if (latestMessageId === summary.delivery.messageId) {
				if (summary.delivery.content === summary.desiredText &&
					samePresentation(summary.delivery.presentation, summary.desiredPresentation)) {
					this.clearProjectSummaryRetry(cwd);
					return;
				}
				if (summary.desiredPresentation) {
					await this.transport.editOwnPresentation(mapping.channelId, summary.delivery.messageId, summary.desiredPresentation);
				} else await this.transport.editOwnText(mapping.channelId, summary.delivery.messageId, summary.desiredText);
				await this.state.recordProjectSummaryEdited(
					cwd,
					summary.delivery.messageId,
					summary.desiredText,
					authorization.revision,
					summary.desiredPresentation,
				);
				continue;
			}
			// Deletion must complete before replacement send. This intentionally leaves no summary
			// during a failed replacement rather than creating a duplicate.
			if (!this.isCurrentSummaryAuthorization(cwd, authorization)) return;
			await this.transport.deleteOwnText(mapping.channelId, summary.delivery.messageId);
			await this.state.recordProjectSummaryDeleted(cwd, summary.delivery.messageId, authorization.revision);
		}
		if (this.isCurrentSummaryAuthorization(cwd, authorization)) this.scheduleProjectSummaryRetry(cwd);
	}

	private async replaceManagerSummaryBatch(
		cwd: string,
		channelId: string,
		summary: ProjectSummaryState,
		authorization: SummaryAuthorization,
	): Promise<void> {
		const presentation = summary.desiredPresentation!;
		const pages = paginateManagerPresentation(presentation);
		const batchRevision = pages[0]!.revision;
		let discovered = await this.transport.managerSummaryMessages(channelId);
		if (!this.isCurrentSummaryAuthorization(cwd, authorization)) return;
		const selected = new Map<number, string>();
		for (const message of discovered) {
			if (message.revision === batchRevision && message.total === pages.length && !selected.has(message.page)) {
				selected.set(message.page, message.id);
			}
		}
		const complete = pages.every((page) => selected.has(page.page));
		let newMessageIds = complete ? pages.map((page) => selected.get(page.page)!) : [];
		if (!complete) {
			const sent: string[] = [];
			try {
				for (const page of pages) {
					if (!this.isCurrentSummaryAuthorization(cwd, authorization)) throw new Error("Manager summary owner changed during replacement");
					const nonce = randomBytes(18).toString("base64url");
					const messageId = page.page === page.total
						? await this.transport.sendPresentation(channelId, page.presentation, nonce)
						: await this.transport.sendText(channelId, page.content, nonce);
					sent.push(messageId);
				}
			} catch (error) {
				await Promise.allSettled([...sent].reverse().map((messageId) => this.transport.deleteOwnText(channelId, messageId)));
				throw error;
			}
			newMessageIds = sent;
		}
		const retained = new Set(newMessageIds);
		const stale = new Set(discovered.filter((message) => !retained.has(message.id)).map((message) => message.id));
		if (summary.delivery && !retained.has(summary.delivery.messageId)) stale.add(summary.delivery.messageId);
		for (const messageId of stale) {
			if (!this.isCurrentSummaryAuthorization(cwd, authorization)) return;
			await this.transport.deleteOwnText(channelId, messageId);
		}
		if (!this.isCurrentSummaryAuthorization(cwd, authorization)) return;
		await this.state.recordProjectSummaryBatchSent(cwd, newMessageIds.at(-1)!, authorization.revision);
	}

	private scheduleProjectSummaryRetry(cwd: string): void {
		const authorization = this.summaryAuthorizations.get(cwd);
		if (!authorization || !this.isCurrentSummaryAuthorization(cwd, authorization) ||
			this.summaryOwnerRetirements.has(cwd) || this.summaryRetryTimers.has(cwd)) return;
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

	private scheduleManagerTaskSnapshotReconciliation(sessionId: string): void {
		const revision = this.taskSnapshotRevisions.get(sessionId);
		if (!revision || this.taskSnapshotRetryTimers.has(sessionId)) return;
		if (this.taskSnapshotReconciliations.has(sessionId)) {
			this.taskSnapshotReconcileRequested.add(sessionId);
			return;
		}
		let tracked: Promise<void>;
		tracked = this.reconcileManagerTaskSnapshot(sessionId, revision)
			.catch(() => this.scheduleManagerTaskSnapshotRetry(sessionId, revision))
			.finally(() => {
				if (this.taskSnapshotReconciliations.get(sessionId) !== tracked) return;
				this.taskSnapshotReconciliations.delete(sessionId);
				if (this.taskSnapshotReconcileRequested.delete(sessionId)) {
					this.scheduleManagerTaskSnapshotReconciliation(sessionId);
				}
			});
		this.taskSnapshotReconciliations.set(sessionId, tracked);
	}

	private async reconcileManagerTaskSnapshot(sessionId: string, revision: string): Promise<void> {
		for (let step = 0; step < 4 && this.started && this.taskSnapshotRevisions.get(sessionId) === revision; step++) {
			const mapping = await this.state.getSession(sessionId);
			const state = mapping?.managerTaskSnapshot;
			if (!mapping || !state || state.desired.revision !== revision ||
				this.taskSnapshotRevisions.get(sessionId) !== revision) return;
			if (state.pendingSend) {
				const pending = await this.state.prepareManagerTaskSnapshotSend(sessionId, revision);
				if (!pending || this.taskSnapshotRevisions.get(sessionId) !== revision) return;
				const messageId = await this.transport.sendText(mapping.threadId, pending.snapshot.content, pending.nonce);
				await this.state.recordManagerTaskSnapshotSent(
					sessionId,
					pending.nonce,
					messageId,
					pending.snapshot.revision,
				);
				continue;
			}
			if (!state.delivery) {
				await this.state.prepareManagerTaskSnapshotSend(sessionId, revision);
				continue;
			}
			if (state.delivery.snapshot.revision === state.desired.revision) {
				this.clearManagerTaskSnapshotRetry(sessionId);
				return;
			}
			await this.transport.editOwnText(mapping.threadId, state.delivery.messageId, state.desired.content);
			await this.state.recordManagerTaskSnapshotEdited(
				sessionId,
				state.delivery.messageId,
				state.desired,
				revision,
			);
		}
		if (this.started && this.taskSnapshotRevisions.get(sessionId) === revision) {
			this.scheduleManagerTaskSnapshotRetry(sessionId, revision);
		}
	}

	private scheduleManagerTaskSnapshotRetry(sessionId: string, revision: string): void {
		if (!this.started || this.taskSnapshotRevisions.get(sessionId) !== revision ||
			this.taskSnapshotRetryTimers.has(sessionId)) return;
		const attempt = (this.taskSnapshotRetryAttempts.get(sessionId) ?? 0) + 1;
		this.taskSnapshotRetryAttempts.set(sessionId, attempt);
		const delay = Math.min(TASK_SNAPSHOT_RETRY_MIN_MS * 2 ** Math.min(attempt - 1, 7), TASK_SNAPSHOT_RETRY_MAX_MS);
		const timer = setTimeout(() => {
			this.taskSnapshotRetryTimers.delete(sessionId);
			this.scheduleManagerTaskSnapshotReconciliation(sessionId);
		}, delay);
		timer.unref();
		this.taskSnapshotRetryTimers.set(sessionId, timer);
	}

	private clearManagerTaskSnapshotRetry(sessionId: string): void {
		const timer = this.taskSnapshotRetryTimers.get(sessionId);
		if (timer) clearTimeout(timer);
		this.taskSnapshotRetryTimers.delete(sessionId);
		this.taskSnapshotRetryAttempts.delete(sessionId);
	}

	private scheduleManagerTaskTerminalReconciliation(sessionId: string): void {
		const revision = this.taskTerminalRevisions.get(sessionId);
		if (!revision || this.taskTerminalRetryTimers.has(sessionId)) return;
		if (this.taskTerminalReconciliations.has(sessionId)) {
			this.taskTerminalReconcileRequested.add(sessionId);
			return;
		}
		let tracked: Promise<void>;
		tracked = this.reconcileManagerTaskTerminal(sessionId, revision)
			.catch(() => this.scheduleManagerTaskTerminalRetry(sessionId, revision))
			.finally(() => {
				if (this.taskTerminalReconciliations.get(sessionId) !== tracked) return;
				this.taskTerminalReconciliations.delete(sessionId);
				if (this.taskTerminalReconcileRequested.delete(sessionId)) {
					this.scheduleManagerTaskTerminalReconciliation(sessionId);
				}
			});
		this.taskTerminalReconciliations.set(sessionId, tracked);
	}

	private async reconcileManagerTaskTerminal(sessionId: string, revision: string): Promise<void> {
		await this.taskSnapshotReconciliations.get(sessionId)?.catch(() => {});
		for (let step = 0; step < 8 && this.started && this.taskTerminalRevisions.get(sessionId) === revision; step++) {
			const mapping = await this.state.getSession(sessionId);
			const terminal = mapping?.managerTaskTerminal;
			if (!mapping || !terminal || terminal.desired.revision !== revision) return;
			if (mapping.outboundMessages.length > 0) {
				await this.drainOutbound();
				this.scheduleManagerTaskTerminalRetry(sessionId, revision);
				return;
			}
			if (terminal.pendingSend) {
				const pending = await this.state.prepareManagerTaskTerminalSend(sessionId, revision);
				if (!pending || this.taskTerminalRevisions.get(sessionId) !== revision) return;
				const messageId = await this.transport.sendText(mapping.threadId, pending.terminal.content, pending.nonce);
				await this.state.recordManagerTaskTerminalSent(sessionId, pending.nonce, messageId, revision);
				continue;
			}
			if (!terminal.delivery) {
				await this.state.prepareManagerTaskTerminalSend(sessionId, revision);
				continue;
			}
			if (!terminal.locked) {
				await this.transport.lockThread(mapping.threadId);
				await this.state.recordManagerTaskTerminalLocked(sessionId, revision);
				continue;
			}
			if (!terminal.archived) {
				await this.transport.archiveThread(mapping.threadId);
				await this.state.recordManagerTaskTerminalArchived(sessionId, revision);
				continue;
			}
			this.clearManagerTaskTerminalRetry(sessionId);
			this.taskTerminalRevisions.delete(sessionId);
			return;
		}
		if (this.started && this.taskTerminalRevisions.get(sessionId) === revision) {
			this.scheduleManagerTaskTerminalRetry(sessionId, revision);
		}
	}

	private scheduleManagerTaskTerminalRetry(sessionId: string, revision: string): void {
		if (!this.started || this.taskTerminalRevisions.get(sessionId) !== revision ||
			this.taskTerminalRetryTimers.has(sessionId)) return;
		const attempt = (this.taskTerminalRetryAttempts.get(sessionId) ?? 0) + 1;
		this.taskTerminalRetryAttempts.set(sessionId, attempt);
		const delay = Math.min(TASK_TERMINAL_RETRY_MIN_MS * 2 ** Math.min(attempt - 1, 7), TASK_TERMINAL_RETRY_MAX_MS);
		const timer = setTimeout(() => {
			this.taskTerminalRetryTimers.delete(sessionId);
			this.scheduleManagerTaskTerminalReconciliation(sessionId);
		}, delay);
		timer.unref();
		this.taskTerminalRetryTimers.set(sessionId, timer);
	}

	private clearManagerTaskTerminalRetry(sessionId: string): void {
		const timer = this.taskTerminalRetryTimers.get(sessionId);
		if (timer) clearTimeout(timer);
		this.taskTerminalRetryTimers.delete(sessionId);
		this.taskTerminalRetryAttempts.delete(sessionId);
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
				const eligibleSessions = new Set([...this.activeSessions.keys(), ...this.taskTerminalRevisions.keys()]);
				const next = await this.state.nextOutbound(eligibleSessions, blockedSessions);
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
					if (this.taskTerminalRevisions.has(next.sessionId)) {
						this.scheduleManagerTaskTerminalReconciliation(next.sessionId);
					}
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
		if (this.outboundRetryTimers.has(sessionId) ||
			!this.activeSessions.has(sessionId) && !this.taskTerminalRevisions.has(sessionId)) return;
		const attempt = (this.outboundRetryAttempts.get(sessionId) ?? 0) + 1;
		this.outboundRetryAttempts.set(sessionId, attempt);
		const delay = Math.min(OUTBOUND_RETRY_MIN_MS * 2 ** Math.min(attempt - 1, 6), OUTBOUND_RETRY_MAX_MS);
		const timer = setTimeout(() => {
			this.outboundRetryTimers.delete(sessionId);
			if (this.started && (this.activeSessions.has(sessionId) || this.taskTerminalRevisions.has(sessionId))) {
				void this.drainOutbound().catch(this.onTerminalError);
			}
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

	private scheduleInboundRetry(sessionId: string): void {
		if (!this.started || !this.activeSessions.has(sessionId) || this.inboundRetryTimers.has(sessionId)) return;
		const attempt = (this.inboundRetryAttempts.get(sessionId) ?? 0) + 1;
		this.inboundRetryAttempts.set(sessionId, attempt);
		const delay = Math.min(INBOUND_RETRY_MIN_MS * 2 ** Math.min(attempt - 1, 5), INBOUND_RETRY_MAX_MS);
		const timer = setTimeout(() => {
			this.inboundRetryTimers.delete(sessionId);
			this.inboundQueue = this.inboundQueue
				.then(() => this.retryInbound(sessionId))
				.catch(() => this.scheduleInboundRetry(sessionId));
		}, delay);
		timer.unref();
		this.inboundRetryTimers.set(sessionId, timer);
	}

	private async retryInbound(sessionId: string): Promise<void> {
		if (!this.started || !this.activeSessions.has(sessionId)) return;
		const mapping = await this.state.getSession(sessionId);
		if (!mapping) return;
		await this.catchUp(sessionId, mapping);
		await this.resumeDelivery(sessionId);
		if (this.inboundCursorBlockedSessions.has(sessionId)) this.scheduleInboundRetry(sessionId);
	}

	private cancelInboundRetry(sessionId: string): void {
		const timer = this.inboundRetryTimers.get(sessionId);
		if (timer) clearTimeout(timer);
		this.inboundRetryTimers.delete(sessionId);
		this.inboundRetryAttempts.delete(sessionId);
	}

	private clearInboundRetry(sessionId: string): void {
		this.cancelInboundRetry(sessionId);
		this.inboundCursorBlockedSessions.delete(sessionId);
	}

	private async catchUp(sessionId: string, mapping: SessionThreadMapping): Promise<void> {
		const wasBlocked = this.inboundCursorBlockedSessions.has(sessionId);
		const missed = await this.transport.fetchMessagesAfter(mapping.threadId, mapping.threadCursors[mapping.threadId]);
		let complete = true;
		for (const message of missed) {
			if (!await this.recordMessage(sessionId, message, false, true)) {
				complete = false;
				break;
			}
		}
		if (complete && (!wasBlocked || missed.length > 0)) this.clearInboundRetry(sessionId);
	}

	private async receiveDiscordMessage(message: DiscordInboundMessage): Promise<void> {
		const matched = await this.state.findSessionByThread(message.channelId);
		if (matched) {
			await this.recordMessage(matched.sessionId, message, true);
			return;
		}
		const projectCwd = await this.state.findProjectByChannel(message.channelId);
		if (projectCwd && this.summaryAuthorizations.has(projectCwd)) this.scheduleProjectSummaryReconciliation(projectCwd);
	}

	private async recordMessage(
		sessionId: string,
		message: DiscordInboundMessage,
		deliver: boolean,
		advanceCursor = !this.catchingUpSessions.has(sessionId) && !this.inboundCursorBlockedSessions.has(sessionId),
	): Promise<boolean> {
		if (await this.state.hasRecordedMessage(message.id)) {
			await this.state.recordDiscordMessage(sessionId, message, advanceCursor);
			return true;
		}
		let imagePaths: string[] = [];
		try {
			const preparation = !message.authorBot && message.attachments?.length
				? await this.requireImageStore().prepare(message.attachments)
				: { images: [], warnings: [] };
			imagePaths = preparation.images.map((image) => image.localPath);
			const content = appendInboundImageContext(message.content, preparation.images, preparation.warnings);
			const result = await this.state.recordDiscordMessage(
				sessionId,
				{ ...message, content, ...(preparation.images.length ? { images: preparation.images } : {}) },
				advanceCursor,
			);
			if (!result.queued) await this.imageStore?.remove(imagePaths);
			if (result.lifecycle) this.scheduleReaction(result.lifecycle);
			if (result.queued && result.message && deliver) {
				const active = this.activeSessions.get(sessionId);
				if (active) this.deliverMessage(active, result.message);
				else await this.wakeOfflineManager(sessionId, result.message.id);
			}
			return true;
		} catch (error) {
			await this.imageStore?.remove(imagePaths).catch(() => {});
			if (!(error instanceof TransientInboundImageError)) throw error;
			this.inboundCursorBlockedSessions.add(sessionId);
			this.scheduleInboundRetry(sessionId);
			return false;
		}
	}

	private async wakeOfflineManager(sessionId: string, messageId: string): Promise<void> {
		const mapping = await this.state.getSession(sessionId);
		if (mapping?.managerWake === undefined || this.wakeEpisodes.has(sessionId)) return;
		this.wakeEpisodes.set(sessionId, messageId);
		try {
			if (!mapping.managerWake) throw new Error("Manager wake descriptor is unavailable");
			await (this.dependencies.wakeManagerSession ?? wakeManagerSession)(mapping.managerWake, sessionId, messageId);
		} catch {
			const warning = "⚠️ Message queued, but the mapped Manager session could not be woken automatically. Reconnect it manually; the queued message will deliver afterward.";
			const nonce = `wake-${createHash("sha256").update(messageId).digest("hex").slice(0, 20)}`;
			await this.transport.sendText(mapping.threadId, warning, nonce).catch((error) => {
				this.onTerminalError(error instanceof Error ? error : new Error(String(error)));
			});
		}
	}

	private deliverMessage(active: ActiveSession, message: QueuedDiscordMessage): boolean {
		if (message.images?.length && !active.inboundImages) return false;
		if (active.acceptingInboundId || active.deliveredIds.has(message.id)) return false;
		if (!active.deliver(message)) return false;
		active.deliveredIds.add(message.id);
		active.acceptingInboundId = message.id;
		return true;
	}

	private requireImageStore(): InboundImageStore {
		if (!this.imageStore) throw new Error("Discord relay image storage is unavailable");
		return this.imageStore;
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
