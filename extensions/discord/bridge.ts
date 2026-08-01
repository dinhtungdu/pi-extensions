import type { DiscordBridgeConfig } from "./config.js";
import { LocalRelayClient, type RelayClientDependencies, type RelayClientStatus } from "./relay-client.js";
import { assistantText } from "./text.js";

const MARKER_BOUNDARY = "\u2063";
const ZERO = "\u200b";
const ONE = "\u200c";

export interface BridgeSession {
	cwd: string;
	sessionId: string;
	sessionName?: string;
}

export interface BridgeCallbacks {
	onUserText(text: string): void;
	onError(error: Error): void;
	onStatus(status: BridgeStatus): void;
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

	constructor(
		config: DiscordBridgeConfig,
		session: BridgeSession,
		private readonly callbacks: BridgeCallbacks,
		dependencies: RelayClientDependencies,
	) {
		this.relay = new LocalRelayClient(
			config,
			session,
			{
				onInbound: (messageId, text) => this.receiveInbound(messageId, text),
				onError: callbacks.onError,
				onStatus: callbacks.onStatus,
			},
			dependencies,
		);
	}

	async start(): Promise<BridgeStatus> {
		await this.relay.start();
		return this.status();
	}

	async stop(): Promise<void> {
		this.finalAssistantText = undefined;
		await this.relay.stop();
	}

	status(): BridgeStatus {
		return this.relay.status();
	}

	async mirrorUserText(text: string): Promise<void> {
		await this.relay.sendUserText(text);
	}

	restoreAcceptedInbound(messageIds: Iterable<string>): void {
		for (const id of messageIds) this.acceptedInboundIds.add(id);
	}

	async confirmInboundAccepted(messageId: string): Promise<void> {
		this.acceptedInboundIds.add(messageId);
		this.submittedInboundIds.delete(messageId);
		await this.relay.acknowledgeInbound(messageId);
	}

	beginAgentRun(): void {
		this.finalAssistantText = undefined;
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

	private async receiveInbound(messageId: string, text: string): Promise<void> {
		if (this.acceptedInboundIds.has(messageId)) {
			await this.relay.acknowledgeInbound(messageId);
			return;
		}
		if (this.submittedInboundIds.has(messageId)) return;
		this.submittedInboundIds.add(messageId);
		try {
			this.callbacks.onUserText(`${markerFor(messageId)}${text}`);
		} catch (error) {
			this.submittedInboundIds.delete(messageId);
			throw error;
		}
	}
}
