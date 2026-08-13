import type { DiscordBridgeConfig } from "./config.js";
import { LocalRelayClient, type RelayClientDependencies, type RelayClientStatus } from "./relay-client.js";
import type {
	ManagerProjectCatalogueEntry,
	ManagerTaskCatalogueEntry,
	PiManagerControlRequest,
	PiModelCatalogueEntry,
	PiSessionControlRequest,
	PiSessionControlResult,
} from "./controls.js";
import {
	appendImageCapabilityWarning,
	loadInboundImages,
	type NativeInboundImage,
	type QueuedInboundImage,
} from "./inbound-images.js";
import type { ManagerPresentation, ManagerPresentationActionControl } from "./manager-presentation.js";
import type { ManagerWakeDescriptor } from "./manager-wake.js";
import type { ManagerTaskSnapshot } from "./manager-task-snapshot.js";
import type { ManagerTaskTerminal } from "./manager-task-terminal.js";
import type { NativeOutboundImage } from "./outbound-images.js";

const MARKER_BOUNDARY = "\u2063";
const ZERO = "\u200b";
const ONE = "\u200c";
const ASSISTANT_DRAIN_TIMEOUT_MS = 2_000;

export interface BridgeSession {
	cwd: string;
	projectIdentityResolved?: boolean;
	sessionId: string;
	sessionName?: string;
	managerTaskSummaryProducer?: true;
	managerWake?: ManagerWakeDescriptor | null;
	managerTaskSnapshotTaskId?: string;
	subscribeOwnerToThread?: true;
}

export interface BridgeCallbacks {
	onUserMessage(content: string | ({ type: "text"; text: string } | NativeInboundImage)[]): void;
	onError(error: Error): void;
	onStatus(status: BridgeStatus): void;
	supportsImageInput?(): boolean;
	modelCatalogue?(): PiModelCatalogueEntry[];
	onControl?(request: PiSessionControlRequest): Promise<PiSessionControlResult>;
	managerTaskCatalogue?(): ManagerTaskCatalogueEntry[];
	managerProjectCatalogue?(): ManagerProjectCatalogueEntry[];
	onManagerControl?(request: PiManagerControlRequest): Promise<PiSessionControlResult>;
	onManagerPresentationControl?(
		request: { requestId: string; revision: string; controlId: string; command: string;
			actionControl?: ManagerPresentationActionControl },
		signal: AbortSignal,
	): Promise<PiSessionControlResult>;
}

export interface BridgeStatus extends RelayClientStatus {}

function markerFor(messageId: string): string {
	const bytes = Buffer.from(messageId, "utf8");
	let bits = "";
	for (const byte of bytes) bits += byte.toString(2).padStart(8, "0").replaceAll("0", ZERO).replaceAll("1", ONE);
	return `${MARKER_BOUNDARY}${bits}${MARKER_BOUNDARY}`;
}

export function inboundMessageId(text: string): string | undefined {
	if (!text.startsWith(MARKER_BOUNDARY)) return undefined;
	const end = text.indexOf(MARKER_BOUNDARY, 1);
	if (end < 0) return undefined;
	const bits = text.slice(1, end);
	if (!bits || [...bits].some((bit) => bit !== ZERO && bit !== ONE) || bits.length % 8 !== 0) return undefined;
	const bytes = Buffer.alloc(bits.length / 8);
	for (let offset = 0; offset < bits.length; offset += 8) {
		bytes[offset / 8] = Number.parseInt(bits.slice(offset, offset + 8).replaceAll(ZERO, "0").replaceAll(ONE, "1"), 2);
	}
	return bytes.toString("utf8");
}

export function stripInboundMarker(text: string): string {
	const id = inboundMessageId(text);
	return id ? text.slice(markerFor(id).length) : text;
}

export class DiscordBridge {
	private readonly relay: LocalRelayClient;
	private assistantPersistence = Promise.resolve();
	private assistantPersistenceFailure: Error | undefined;
	private acceptingAssistantMessages = false;
	private readonly submittedInboundIds = new Set<string>();
	private readonly acceptedInboundIds = new Set<string>();
	private readonly restoredImageInboundIds = new Set<string>();
	private readonly runInboundIds = new Set<string>();
	private readonly imageInboundIds = new Set<string>();
	private initialInboundId: string | undefined;
	private activeInboundId: string | undefined;
	private terminalRunFailed = false;

	constructor(
		config: DiscordBridgeConfig,
		session: BridgeSession,
		private readonly callbacks: BridgeCallbacks,
		private readonly dependencies: RelayClientDependencies,
	) {
		this.relay = new LocalRelayClient(
			config,
			session,
			{
				onInbound: (messageId, text, images) => this.receiveInbound(messageId, text, images),
				onError: callbacks.onError,
				onStatus: callbacks.onStatus,
				...(callbacks.modelCatalogue ? { modelCatalogue: callbacks.modelCatalogue } : {}),
				...(callbacks.onControl ? { onControl: callbacks.onControl } : {}),
				...(callbacks.managerTaskCatalogue ? { managerTaskCatalogue: callbacks.managerTaskCatalogue } : {}),
				...(callbacks.managerProjectCatalogue ? { managerProjectCatalogue: callbacks.managerProjectCatalogue } : {}),
				...(callbacks.onManagerControl ? { onManagerControl: callbacks.onManagerControl } : {}),
				...(callbacks.onManagerPresentationControl ? { onManagerPresentationControl: callbacks.onManagerPresentationControl } : {}),
			},
			dependencies,
		);
	}

	async start(): Promise<BridgeStatus> {
		await this.relay.start();
		for (const messageId of this.restoredImageInboundIds) {
			await this.acknowledgeAndRelease(messageId, true);
		}
		this.restoredImageInboundIds.clear();
		this.assistantPersistenceFailure = undefined;
		this.acceptingAssistantMessages = true;
		return this.status();
	}

	async stop(): Promise<void> {
		this.acceptingAssistantMessages = false;
		let failure: Error | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.assistantPersistence,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(`Timed out after ${ASSISTANT_DRAIN_TIMEOUT_MS}ms draining Discord assistant messages`)),
						ASSISTANT_DRAIN_TIMEOUT_MS);
				}),
			]);
			failure = this.assistantPersistenceFailure;
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
		} finally {
			if (timer) clearTimeout(timer);
			this.assistantPersistenceFailure = undefined;
			this.resetAgentRun();
			this.imageInboundIds.clear();
			this.restoredImageInboundIds.clear();
			try { await this.relay.stop(); } catch (error) {
				failure ??= error instanceof Error ? error : new Error(String(error));
			}
		}
		if (failure) throw failure;
	}

	status(): BridgeStatus {
		return this.relay.status();
	}

	async restartRelay(): Promise<BridgeStatus> {
		return this.relay.restartRelay();
	}

	async publishProjectSummary(text: string): Promise<boolean> {
		return this.relay.sendProjectSummary(text);
	}

	async publishManagerPresentation(presentation: ManagerPresentation): Promise<boolean> {
		return this.relay.publishManagerPresentation(presentation);
	}

	async publishManagerTaskSnapshot(snapshot: ManagerTaskSnapshot): Promise<void> {
		await this.relay.publishManagerTaskSnapshot(snapshot);
	}

	publishManagerTaskTerminal(terminal: ManagerTaskTerminal): Promise<boolean> {
		return this.relay.publishManagerTaskTerminal(terminal);
	}

	async updateManagerCatalogues(
		tasks: readonly ManagerTaskCatalogueEntry[],
		projects: readonly ManagerProjectCatalogueEntry[],
	): Promise<boolean> {
		return this.relay.updateManagerCatalogues(tasks, projects);
	}

	async mirrorUserText(text: string, interactive = false): Promise<void> {
		if (interactive) await this.relay.sendInteractiveUserText(text);
		else await this.relay.sendUserText(text);
	}

	restoreAcceptedInbound(messages: Iterable<string | { messageId: string; hasImages: boolean }>): void {
		for (const message of messages) {
			const messageId = typeof message === "string" ? message : message.messageId;
			this.acceptedInboundIds.add(messageId);
			if (typeof message !== "string" && message.hasImages) this.restoredImageInboundIds.add(messageId);
		}
	}

	hasInboundImages(messageId: string): boolean {
		return this.imageInboundIds.has(messageId);
	}

	async confirmInboundAccepted(messageId: string): Promise<void> {
		this.acceptedInboundIds.add(messageId);
		this.submittedInboundIds.delete(messageId);
		await this.relay.acknowledgeInbound(messageId);
	}

	beginAgentRun(messageId?: string): void {
		this.resetAgentRun();
		this.initialInboundId = messageId;
		this.activeInboundId = messageId;
	}

	async agentStarted(): Promise<void> {
		if (this.initialInboundId) await this.associateInbound(this.initialInboundId);
	}

	async userMessageStarted(messageId?: string): Promise<void> {
		this.activeInboundId = messageId;
		if (messageId) await this.associateInbound(messageId);
	}

	toolStarted(): void {
		if (this.activeInboundId) this.relay.updateLifecycle(this.activeInboundId, "tool");
	}

	agentEnded(messages: Array<{ role?: string; stopReason?: string }>, aborted = false): void {
		const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
		this.terminalRunFailed = aborted || lastAssistant?.stopReason === "aborted" || lastAssistant?.stopReason === "error";
	}

	async settleAgentRun(): Promise<void> {
		const status = this.terminalRunFailed ? "failed" : "succeeded";
		const messageIds = [...this.runInboundIds];
		for (const messageId of messageIds) this.relay.updateLifecycle(messageId, status);
		this.resetAgentRun();
		await Promise.all(messageIds.filter((messageId) => this.imageInboundIds.has(messageId)).map(async (messageId) => {
			await this.relay.releaseInboundImages(messageId);
			this.imageInboundIds.delete(messageId);
		}));
	}

	assistantResponseIds(): string[] {
		return [...this.runInboundIds];
	}

	async enqueueAssistantMessage(
		messageId: string,
		text: string,
		nativeImages: readonly NativeOutboundImage[] = [],
		responseTo?: readonly string[],
	): Promise<void> {
		if (!this.acceptingAssistantMessages) throw new Error("Discord bridge is not accepting assistant messages");
		const responses = responseTo ?? [...this.runInboundIds];
		const pending = this.assistantPersistence.then(() => this.relay.sendAssistantText(messageId, text, responses, nativeImages));
		this.assistantPersistence = pending.catch((error) => {
			this.assistantPersistenceFailure ??= error instanceof Error ? error : new Error(String(error));
		});
		return pending;
	}

	private async associateInbound(messageId: string): Promise<void> {
		this.activeInboundId = messageId;
		const firstAssociation = !this.runInboundIds.has(messageId);
		this.runInboundIds.add(messageId);
		this.relay.updateLifecycle(messageId, "thinking");
		if (firstAssociation) await this.relay.startWorking(messageId);
	}

	private resetAgentRun(): void {
		this.runInboundIds.clear();
		this.initialInboundId = undefined;
		this.activeInboundId = undefined;
		this.terminalRunFailed = false;
	}

	private async acknowledgeAndRelease(messageId: string, releaseImages: boolean): Promise<void> {
		await this.relay.acknowledgeInbound(messageId);
		if (releaseImages) {
			await this.relay.releaseInboundImages(messageId);
			this.imageInboundIds.delete(messageId);
		}
	}

	private async receiveInbound(
		messageId: string,
		text: string,
		images: readonly QueuedInboundImage[],
	): Promise<void> {
		if (this.acceptedInboundIds.has(messageId)) {
			if (images.length > 0) this.imageInboundIds.add(messageId);
			void this.acknowledgeAndRelease(messageId, images.length > 0).catch(this.callbacks.onError);
			return;
		}
		if (this.submittedInboundIds.has(messageId)) return;
		this.submittedInboundIds.add(messageId);
		if (images.length > 0) this.imageInboundIds.add(messageId);
		try {
			const markedText = `${markerFor(messageId)}${text}`;
			if (images.length === 0) this.callbacks.onUserMessage(markedText);
			else if (this.callbacks.supportsImageInput?.() !== true) {
				this.callbacks.onUserMessage(appendImageCapabilityWarning(markedText));
			} else {
				const nativeImages = await loadInboundImages(this.dependencies.paths.attachments, images);
				this.callbacks.onUserMessage([{ type: "text", text: markedText }, ...nativeImages]);
			}
		} catch (error) {
			this.submittedInboundIds.delete(messageId);
			this.imageInboundIds.delete(messageId);
			throw error;
		}
	}
}
