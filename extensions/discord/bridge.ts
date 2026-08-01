import { LocalRelayClient, type RelayClientDependencies, type RelayClientStatus } from "./relay-client.js";
import type { DiscordBridgeConfig } from "./config.js";
import { assistantText } from "./text.js";

export interface BridgeSession {
	cwd: string;
	sessionId: string;
	sessionName?: string;
}

export interface BridgeCallbacks {
	onUserText(text: string): void | Promise<void>;
	onError(error: Error): void;
	onStatus(status: BridgeStatus): void;
}

export interface BridgeStatus extends RelayClientStatus {}

export class DiscordBridge {
	private readonly relay: LocalRelayClient;
	private finalAssistantText: string | undefined;

	constructor(
		config: DiscordBridgeConfig,
		session: BridgeSession,
		callbacks: BridgeCallbacks,
		dependencies: RelayClientDependencies,
	) {
		this.relay = new LocalRelayClient(
			config,
			session,
			{
				onInbound: callbacks.onUserText,
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

	beginAgentRun(): void {
		this.finalAssistantText = undefined;
	}

	captureAssistantMessage(message: { role?: string; content?: unknown; stopReason?: string }): void {
		if (message.role !== "assistant") return;
		this.finalAssistantText = assistantText(message);
	}

	async flushSettledAssistant(): Promise<void> {
		const text = this.finalAssistantText;
		this.finalAssistantText = undefined;
		if (text) await this.relay.sendAssistantText(text);
	}
}
