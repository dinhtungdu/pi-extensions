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
	sendText(channelId: string, text: string): Promise<void>;
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

export class DiscordJsTransport implements DiscordTransport {
	private client: Client | undefined;
	private readonly listeners = new Set<(message: DiscordInboundMessage) => void>();

	async connect(config: DiscordBridgeConfig): Promise<void> {
		if (this.client) throw new Error("Discord transport is already connected");
		const client = new Client({
			intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
		});
		this.client = client;
		client.on(Events.Error, (error) => {
			console.error("[discord-bridge] Discord client error:", error);
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
		const result: DiscordInboundMessage[] = [];
		let cursor = afterId;
		for (let page = 0; page < 100; page++) {
			const messages = await channel.messages.fetch({ after: cursor, limit: 100 });
			const ordered = [...messages.values()].sort((left, right) => left.createdTimestamp - right.createdTimestamp);
			if (ordered.length === 0) break;
			for (const message of ordered) {
				result.push({
					id: message.id,
					channelId: message.channelId,
					content: message.content,
					authorBot: message.author.bot,
				});
			}
			cursor = ordered.at(-1)!.id;
			if (ordered.length < 100) break;
		}
		return result;
	}

	async sendText(channelId: string, text: string): Promise<void> {
		const channel = await this.readyClient().channels.fetch(channelId).catch(() => null);
		if (!channel?.isTextBased() || channel.isDMBased()) {
			throw new Error(`Discord thread ${channelId} is missing or cannot receive messages`);
		}
		await channel.send({ content: text, allowedMentions: { parse: [] } });
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
