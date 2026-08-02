import type { DiscordBridgeConfig } from "./config.js";
import { LocalRelayClient, type RelayClientDependencies, type RelayClientStatus } from "./relay-client.js";
import { assistantText } from "./text.js";
import type {
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

const MARKER_BOUNDARY = "\u2063";
const ZERO = "\u200b";
const ONE = "\u200c";

export interface BridgeSession {
	cwd: string;
	projectIdentityResolved?: boolean;
	sessionId: string;
	sessionName?: string;
}

export interface BridgeCallbacks {
	onUserMessage(content: string | ({ type: "text"; text: string } | NativeInboundImage)[]): void;
	onError(error: Error): void;
	onStatus(status: BridgeStatus): void;
	supportsImageInput?(): boolean;
	modelCatalogue?(): PiModelCatalogueEntry[];
	onControl?(request: PiSessionControlRequest): Promise<PiSessionControlResult>;
	managerTaskCatalogue?(): ManagerTaskCatalogueEntry[];
	onManagerControl?(request: PiManagerControlRequest): Promise<PiSessionControlResult>;
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
	private finalAssistantText: string | undefined;
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
				...(callbacks.onManagerControl ? { onManagerControl: callbacks.onManagerControl } : {}),
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
		return this.status();
	}

	async stop(): Promise<void> {
		this.finalAssistantText = undefined;
		this.resetAgentRun();
		this.imageInboundIds.clear();
		this.restoredImageInboundIds.clear();
		await this.relay.stop();
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

	async updateManagerTaskCatalogue(catalogue: readonly ManagerTaskCatalogueEntry[]): Promise<boolean> {
		return this.relay.updateManagerTaskCatalogue(catalogue);
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
		this.finalAssistantText = undefined;
		this.resetAgentRun();
		this.initialInboundId = messageId;
		this.activeInboundId = messageId;
	}

	agentStarted(): void {
		if (!this.initialInboundId) return;
		this.associateInbound(this.initialInboundId);
	}

	userMessageStarted(messageId?: string): void {
		this.activeInboundId = messageId;
		if (messageId) this.associateInbound(messageId);
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

	captureAssistantMessage(message: { role?: string; content?: unknown; stopReason?: string }): void {
		if (message.role !== "assistant") return;
		this.finalAssistantText = assistantText(message);
	}

	async flushSettledAssistant(): Promise<void> {
		const text = this.finalAssistantText;
		if (!text) return;
		await this.relay.sendAssistantText(text);
		if (this.finalAssistantText === text) this.finalAssistantText = undefined;
	}

	private associateInbound(messageId: string): void {
		this.activeInboundId = messageId;
		this.runInboundIds.add(messageId);
		this.relay.updateLifecycle(messageId, "thinking");
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
