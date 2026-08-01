import {
	ChannelType,
	Client,
	Events,
	GatewayIntentBits,
	ThreadAutoArchiveDuration,
	type Guild,
	type TextChannel,
} from "discord.js";
import type { DiscordBridgeConfig } from "./config.js";
import { DISCORD_LIFECYCLE_REACTIONS, type DiscordLifecycleReaction } from "./reactions.js";

const READY_TIMEOUT_MS = 30_000;

export interface DiscordInboundMessage {
	id: string;
	channelId: string;
	content: string;
	authorBot: boolean;
}

export interface ProjectChannelRequest {
	guildId: string;
	categoryId?: string;
	mappedChannelId?: string;
	name: string;
}

export interface SessionThreadRequest {
	channelId: string;
	mappedThreadId?: string;
	name: string;
}

export interface DiscordTransport {
	connect(config: DiscordBridgeConfig): Promise<void>;
	disconnect(): Promise<void>;
	onMessage(listener: (message: DiscordInboundMessage) => void): () => void;
	ensureProjectChannel(request: ProjectChannelRequest): Promise<string>;
	ensureSessionThread(request: SessionThreadRequest): Promise<string>;
	fetchMessagesAfter(channelId: string, afterId?: string): Promise<DiscordInboundMessage[]>;
	sendText(channelId: string, text: string, nonce: string): Promise<string>;
	setLifecycleReaction(channelId: string, messageId: string, reaction: DiscordLifecycleReaction): Promise<void>;
	onTerminalError(listener: (error: Error) => void): () => void;
}

interface LifecycleReactionState {
	emoji: { name: string | null };
	me: boolean;
	users: { remove(userId: string): Promise<unknown> };
}

export async function replaceOwnLifecycleReaction(
	reactions: Iterable<LifecycleReactionState>,
	botUserId: string,
	next: DiscordLifecycleReaction,
	add: (reaction: DiscordLifecycleReaction) => Promise<unknown>,
): Promise<void> {
	let hasNext = false;
	for (const reaction of reactions) {
		if (reaction.emoji.name === next) {
			hasNext ||= reaction.me;
			continue;
		}
		if (reaction.me && DISCORD_LIFECYCLE_REACTIONS.includes(reaction.emoji.name as DiscordLifecycleReaction)) {
			await reaction.users.remove(botUserId);
		}
	}
	if (!hasNext) await add(next);
}

export function assertConfiguredCategory(
	category: { type: ChannelType; guildId?: string } | null,
	categoryId: string,
	guildId: string,
): void {
	if (!category || category.type !== ChannelType.GuildCategory || category.guildId !== guildId) {
		throw new Error(
			`Configured Discord category ${categoryId} does not exist in guild ${guildId} or is not a category`,
		);
	}
}

export async function reuseSessionThread(
	thread: {
		id: string;
		parentId: string | null;
		archived: boolean | null;
		isThread(): boolean;
		setArchived(archived: boolean, reason?: string): Promise<unknown>;
	} | null,
	channelId: string,
): Promise<string | undefined> {
	if (!thread?.isThread() || thread.parentId !== channelId) return undefined;
	if (thread.archived) await thread.setArchived(false, "Pi session resumed");
	return thread.id;
}

function compareIds(left: string, right: string): number {
	try {
		return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
	} catch {
		return left.localeCompare(right);
	}
}

export async function collectChronologicalMessages(
	fetchPage: (options: { after?: string; before?: string; limit: 100 }) => Promise<DiscordInboundMessage[]>,
	afterId?: string,
): Promise<DiscordInboundMessage[]> {
	let page = await fetchPage({ ...(afterId ? { after: afterId } : {}), limit: 100 });
	const collected = new Map(page.map((message) => [message.id, message]));
	if (!afterId) return [...collected.values()].sort((left, right) => compareIds(left.id, right.id));
	for (let pages = 1; page.length === 100; pages++) {
		if (pages >= 1_000) throw new Error("Discord catch-up exceeded 100,000 messages; cursor was not advanced");
		const oldest = [...page].sort((left, right) => compareIds(left.id, right.id))[0]!.id;
		const older = await fetchPage({ before: oldest, limit: 100 });
		const eligible = older.filter((message) => compareIds(message.id, afterId) > 0);
		for (const message of eligible) collected.set(message.id, message);
		if (older.length < 100 || eligible.length < older.length) break;
		page = older;
	}
	return [...collected.values()].sort((left, right) => compareIds(left.id, right.id));
}

export class DiscordJsTransport implements DiscordTransport {
	private client: Client | undefined;
	private readonly listeners = new Set<(message: DiscordInboundMessage) => void>();
	private readonly terminalListeners = new Set<(error: Error) => void>();

	async connect(config: DiscordBridgeConfig): Promise<void> {
		if (this.client) throw new Error("Discord transport is already connected");
		const client = new Client({
			intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
		});
		this.client = client;
		client.on(Events.Error, (error) => {
			console.error("[discord-bridge] Discord client error:", error);
		});
		client.on(Events.Invalidated, () => {
			const error = new Error("Discord gateway session was invalidated");
			for (const listener of this.terminalListeners) listener(error);
		});
		client.on(Events.ShardDisconnect, (event) => {
			if (![4_004, 4_010, 4_011, 4_013, 4_014].includes(event.code)) return;
			const error = new Error(`Discord gateway closed terminally with code ${event.code}`);
			for (const listener of this.terminalListeners) listener(error);
		});
		client.on(Events.MessageCreate, (message) => {
			const normalized: DiscordInboundMessage = {
				id: message.id,
				channelId: message.channelId,
				content: message.content,
				authorBot: message.author.bot,
			};
			for (const listener of this.listeners) listener(normalized);
		});

		let timer: ReturnType<typeof setTimeout> | undefined;
		const ready = new Promise<void>((resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`Discord client did not become ready within ${READY_TIMEOUT_MS}ms`)), READY_TIMEOUT_MS);
			client.once(Events.ClientReady, () => resolve());
		});
		try {
			await client.login(config.token);
			await ready;
		} catch (error) {
			client.destroy();
			this.client = undefined;
			throw new Error(`Discord login failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async disconnect(): Promise<void> {
		this.client?.destroy();
		this.client = undefined;
	}

	onMessage(listener: (message: DiscordInboundMessage) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async ensureProjectChannel(request: ProjectChannelRequest): Promise<string> {
		const guild = await this.guild(request.guildId);
		await this.validateCategory(guild, request.categoryId);

		if (request.mappedChannelId) {
			const mapped = await guild.channels.fetch(request.mappedChannelId).catch(() => null);
			if (mapped?.type === ChannelType.GuildText && mapped.guildId === guild.id) return mapped.id;
		}

		const channel = await guild.channels.create({
			name: request.name,
			type: ChannelType.GuildText,
			...(request.categoryId ? { parent: request.categoryId } : {}),
			topic: "Pi project bridge",
			reason: "Pi Discord bridge project channel",
		});
		return channel.id;
	}

	async ensureSessionThread(request: SessionThreadRequest): Promise<string> {
		const client = this.readyClient();
		if (request.mappedThreadId) {
			const mapped = await client.channels.fetch(request.mappedThreadId).catch(() => null);
			const reused = await reuseSessionThread(mapped?.isThread() ? mapped : null, request.channelId);
			if (reused) return reused;
		}

		const parent = await client.channels.fetch(request.channelId).catch(() => null);
		if (parent?.type !== ChannelType.GuildText) {
			throw new Error(`Discord project channel ${request.channelId} is missing or is not a text channel`);
		}
		const thread = await (parent as TextChannel).threads.create({
			name: request.name,
			autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
			type: ChannelType.PublicThread,
			reason: "Pi Discord bridge session thread",
		});
		return thread.id;
	}

	async fetchMessagesAfter(channelId: string, afterId?: string): Promise<DiscordInboundMessage[]> {
		const channel = await this.readyClient().channels.fetch(channelId).catch(() => null);
		if (!channel?.isTextBased() || channel.isDMBased()) {
			throw new Error(`Discord thread ${channelId} is missing or cannot fetch messages`);
		}
		return collectChronologicalMessages(async (options) => {
			const messages = await channel.messages.fetch(options);
			return [...messages.values()].map((message) => ({
				id: message.id,
				channelId: message.channelId,
				content: message.content,
				authorBot: message.author.bot,
			}));
		}, afterId);
	}

	async sendText(channelId: string, text: string, nonce: string): Promise<string> {
		const channel = await this.readyClient().channels.fetch(channelId).catch(() => null);
		if (!channel?.isTextBased() || channel.isDMBased()) {
			throw new Error(`Discord thread ${channelId} is missing or cannot receive messages`);
		}
		const message = await channel.send({
			content: text,
			nonce,
			enforceNonce: true,
			allowedMentions: { parse: [] },
		});
		return message.id;
	}

	async setLifecycleReaction(channelId: string, messageId: string, reaction: DiscordLifecycleReaction): Promise<void> {
		const client = this.readyClient();
		const channel = await client.channels.fetch(channelId).catch(() => null);
		if (!channel?.isTextBased() || channel.isDMBased()) {
			throw new Error(`Discord thread ${channelId} is missing or cannot manage reactions`);
		}
		const message = await channel.messages.fetch(messageId);
		await replaceOwnLifecycleReaction(
			message.reactions.cache.values(),
			client.user.id,
			reaction,
			(next) => message.react(next),
		);
	}

	onTerminalError(listener: (error: Error) => void): () => void {
		this.terminalListeners.add(listener);
		return () => this.terminalListeners.delete(listener);
	}

	private readyClient(): Client<true> {
		if (!this.client?.isReady()) throw new Error("Discord transport is not connected");
		return this.client;
	}

	private async guild(guildId: string): Promise<Guild> {
		try {
			return await this.readyClient().guilds.fetch(guildId);
		} catch (error) {
			throw new Error(`Cannot access configured Discord guild ${guildId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async validateCategory(guild: Guild, categoryId?: string): Promise<void> {
		if (!categoryId) return;
		const category = await guild.channels.fetch(categoryId).catch(() => null);
		assertConfiguredCategory(category, categoryId, guild.id);
	}
}
