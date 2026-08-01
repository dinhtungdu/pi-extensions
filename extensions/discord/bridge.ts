import type { DiscordBridgeConfig } from "./config.js";
import { DiscordStateStore } from "./state.js";
import { assistantText, normalizeCwd, projectChannelName, sessionThreadName, splitDiscordText } from "./text.js";
import type { DiscordInboundMessage, DiscordTransport } from "./transport.js";

export interface BridgeSession {
	cwd: string;
	sessionId: string;
	sessionName?: string;
}

export interface BridgeCallbacks {
	onUserText(text: string): void;
	onError(error: Error): void;
}

export interface BridgeStatus {
	connected: boolean;
	channelId?: string;
	threadId?: string;
}

export class DiscordBridge {
	private channelId: string | undefined;
	private threadId: string | undefined;
	private unsubscribe: (() => void) | undefined;
	private finalAssistantText: string | undefined;
	private stopped = true;
	private sendQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly config: DiscordBridgeConfig,
		private readonly session: BridgeSession,
		private readonly state: DiscordStateStore,
		private readonly transport: DiscordTransport,
		private readonly callbacks: BridgeCallbacks,
	) {}

	async start(): Promise<BridgeStatus> {
		if (!this.stopped) return this.status();
		this.stopped = false;
		const cwd = normalizeCwd(this.session.cwd);
		try {
			await this.transport.connect(this.config);
			this.channelId = await this.state.resolveProjectChannel(cwd, (mappedChannelId) => {
				return this.transport.ensureProjectChannel({
					guildId: this.config.guildId,
					categoryId: this.config.categoryId,
					mappedChannelId,
					name: projectChannelName(cwd),
				});
			});
			this.threadId = await this.state.resolveSessionThread(
				this.session.sessionId,
				cwd,
				this.channelId,
				(mappedThreadId) => this.transport.ensureSessionThread({
					channelId: this.channelId!,
					mappedThreadId,
					name: sessionThreadName(this.session.sessionId, this.session.sessionName),
				}),
			);
			this.unsubscribe = this.transport.onMessage((message) => {
				return this.receive(message).catch((error) => this.callbacks.onError(asError(error)));
			});
			return this.status();
		} catch (error) {
			await this.transport.disconnect().catch(() => {});
			this.stopped = true;
			this.channelId = undefined;
			this.threadId = undefined;
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		await this.sendQueue.catch(() => {});
		await this.transport.disconnect();
		this.channelId = undefined;
		this.threadId = undefined;
		this.finalAssistantText = undefined;
	}

	status(): BridgeStatus {
		return {
			connected: !this.stopped && Boolean(this.channelId && this.threadId),
			channelId: this.channelId,
			threadId: this.threadId,
		};
	}

	async mirrorUserText(text: string): Promise<void> {
		if (!text.trim()) return;
		await this.send(text);
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
		if (text) await this.send(text);
	}

	private async receive(message: DiscordInboundMessage): Promise<void> {
		if (this.stopped || message.authorBot || message.channelId !== this.threadId || !message.content.trim()) return;
		if (!(await this.state.markMessageSeen(message.id))) return;
		this.callbacks.onUserText(message.content);
	}

	private async send(text: string): Promise<void> {
		const threadId = this.threadId;
		if (this.stopped || !threadId) throw new Error("Discord bridge is not connected to a session thread");
		const chunks = splitDiscordText(text);
		const operation = this.sendQueue.then(async () => {
			for (const chunk of chunks) await this.transport.sendText(threadId, chunk);
		});
		this.sendQueue = operation.catch(() => {});
		await operation;
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
