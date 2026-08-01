import type { DiscordBridgeConfig } from "./config.js";
import { DiscordStateStore, type QueuedDiscordMessage, type SessionThreadMapping } from "./state.js";
import { normalizeCwd, projectChannelName, sessionThreadName, splitDiscordText } from "./text.js";
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
	deliver(message: QueuedDiscordMessage): void;
	deliveredIds: Set<string>;
}

export class DiscordRelayCore {
	private readonly activeSessions = new Map<string, ActiveSession>();
	private readonly reservedSessions = new Map<string, string>();
	private readonly clientSessions = new Map<string, Set<string>>();
	private unsubscribe: (() => void) | undefined;
	private inboundQueue: Promise<void> = Promise.resolve();
	private started = false;

	constructor(
		private readonly config: DiscordBridgeConfig,
		private readonly state: DiscordStateStore,
		private readonly transport: DiscordTransport,
	) {}

	async start(): Promise<void> {
		if (this.started) return;
		await this.transport.connect(this.config);
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
		await this.inboundQueue;
		this.activeSessions.clear();
		this.reservedSessions.clear();
		this.clientSessions.clear();
		await this.transport.disconnect();
	}

	async prepareRegistration(clientId: string, registration: RelaySessionRegistration): Promise<PreparedRegistration> {
		this.assertStarted();
		const owner = this.activeSessions.get(registration.sessionId)?.clientId ?? this.reservedSessions.get(registration.sessionId);
		if (owner && owner !== clientId) {
			throw new Error(`Pi session ${registration.sessionId} is already registered by another local client`);
		}
		this.reservedSessions.set(registration.sessionId, clientId);
		try {
			const cwd = normalizeCwd(registration.cwd);
			const channelId = await this.state.resolveProjectChannel(cwd, (mappedChannelId) => {
				return this.transport.ensureProjectChannel({
					guildId: this.config.guildId,
					categoryId: this.config.categoryId,
					mappedChannelId,
					name: projectChannelName(cwd),
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
			await this.catchUp(registration.sessionId, mapping);
			return { channelId, threadId: mapping.threadId };
		} catch (error) {
			if (this.reservedSessions.get(registration.sessionId) === clientId) {
				this.reservedSessions.delete(registration.sessionId);
			}
			throw error;
		}
	}

	async activateRegistration(
		clientId: string,
		sessionId: string,
		deliver: (message: QueuedDiscordMessage) => void,
	): Promise<void> {
		if (this.reservedSessions.get(sessionId) !== clientId) {
			throw new Error(`Pi session ${sessionId} was not reserved by client ${clientId}`);
		}
		const pending = await this.state.pendingMessages(sessionId);
		this.reservedSessions.delete(sessionId);
		const active: ActiveSession = { clientId, deliver, deliveredIds: new Set() };
		this.activeSessions.set(sessionId, active);
		const sessions = this.clientSessions.get(clientId) ?? new Set<string>();
		sessions.add(sessionId);
		this.clientSessions.set(clientId, sessions);
		for (const message of pending) this.deliverMessage(active, message);
	}

	unregisterClient(clientId: string): void {
		for (const [sessionId, owner] of this.reservedSessions) {
			if (owner === clientId) this.reservedSessions.delete(sessionId);
		}
		for (const sessionId of this.clientSessions.get(clientId) ?? []) {
			if (this.activeSessions.get(sessionId)?.clientId === clientId) this.activeSessions.delete(sessionId);
		}
		this.clientSessions.delete(clientId);
	}

	async acknowledge(clientId: string, sessionId: string, messageId: string): Promise<void> {
		this.assertClientSession(clientId, sessionId);
		await this.state.acknowledgeMessage(sessionId, messageId);
	}

	async sendClientText(clientId: string, sessionId: string, text: string): Promise<void> {
		this.assertClientSession(clientId, sessionId);
		if (!text.trim()) return;
		const mapping = await this.state.getSession(sessionId);
		if (!mapping) throw new Error(`Pi session ${sessionId} has no Discord thread mapping`);
		for (const chunk of splitDiscordText(text)) await this.transport.sendText(mapping.threadId, chunk);
	}

	private async catchUp(sessionId: string, mapping: SessionThreadMapping): Promise<void> {
		const missed = await this.transport.fetchMessagesAfter(mapping.threadId, mapping.lastMessageId);
		for (const message of missed) await this.recordMessage(sessionId, message, false);
	}

	private async receiveDiscordMessage(message: DiscordInboundMessage): Promise<void> {
		const matched = await this.state.findSessionByThread(message.channelId);
		if (!matched) return;
		await this.recordMessage(matched.sessionId, message, true);
	}

	private async recordMessage(sessionId: string, message: DiscordInboundMessage, deliver: boolean): Promise<void> {
		const result = await this.state.recordDiscordMessage(sessionId, message);
		if (!result.queued || !result.message || !deliver) return;
		const active = this.activeSessions.get(sessionId);
		if (active) this.deliverMessage(active, result.message);
	}

	private deliverMessage(active: ActiveSession, message: QueuedDiscordMessage): void {
		if (active.deliveredIds.has(message.id)) return;
		active.deliveredIds.add(message.id);
		active.deliver(message);
	}

	private assertClientSession(clientId: string, sessionId: string): void {
		if (this.activeSessions.get(sessionId)?.clientId !== clientId) {
			throw new Error(`Local client ${clientId} is not registered for Pi session ${sessionId}`);
		}
	}

	private assertStarted(): void {
		if (!this.started) throw new Error("Discord relay is not started");
	}
}
