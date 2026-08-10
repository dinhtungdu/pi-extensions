import {
	ActionRowBuilder,
	ApplicationCommandOptionType,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	Client,
	Events,
	GatewayIntentBits,
	MessageFlags,
	ThreadAutoArchiveDuration,
	type ChatInputApplicationCommandData,
	type ChatInputCommandInteraction,
	type Guild,
	type TextChannel,
} from "discord.js";
import type { DiscordBridgeConfig } from "./config.js";
import type { DiscordInboundAttachment } from "./inbound-images.js";
import { DISCORD_LIFECYCLE_REACTIONS, type DiscordLifecycleReaction } from "./reactions.js";
import {
	boundedControlResult,
	MANAGER_CONTROL_ACTIONS,
	MANAGER_TASK_ACTIONS,
	MAX_MANAGER_TARGET_AUTOCOMPLETE_CHOICES,
	MAX_MANAGER_TASK_AUTOCOMPLETE_CHOICES,
	MAX_MODEL_AUTOCOMPLETE_CHOICES,
	MAX_SESSION_CONTROL_TEXT_LENGTH,
	PI_THINKING_LEVELS,
	type DiscordManagerControlRequest,
	type DiscordModelChoice,
	type DiscordSessionControlRequest,
	type PiSessionControlResult,
} from "./controls.js";
import type { ManagerPresentation, ManagerPresentationStyle } from "./manager-presentation.js";

const READY_TIMEOUT_MS = 30_000;
const CONTROL_EXECUTION_TIMEOUT_MS = 12_000;
export const MANAGER_CONTROL_INTERACTION_TIMEOUT_MS = 180_000;
const PI_COMMAND_NAME = "pi";
const MANAGER_COMMAND_NAME = "m";
const LEGACY_MANAGER_COMMAND_NAME = "manager";

export interface DiscordPresentationControlRequest {
	requestId: string; guildId?: string; channelId: string; messageId: string; customId: string;
}

export interface DiscordInboundMessage {
	id: string;
	channelId: string;
	content: string;
	authorBot: boolean;
	attachments?: DiscordInboundAttachment[];
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
	subscribeOwner?: true;
}

export interface RenameSessionThreadRequest {
	channelId: string;
	threadId: string;
	name: string;
}

export interface DiscordTransport {
	connect(config: DiscordBridgeConfig): Promise<void>;
	disconnect(): Promise<void>;
	onMessage(listener: (message: DiscordInboundMessage) => void): () => void;
	onSessionControl(listener: (request: DiscordSessionControlRequest) => Promise<PiSessionControlResult>): () => void;
	onModelAutocomplete(listener: (channelId: string, prefix: string) => DiscordModelChoice[]): () => void;
	onManagerControl(listener: (request: DiscordManagerControlRequest) => Promise<PiSessionControlResult>): () => void;
	onManagerAutocomplete(listener: (channelId: string, prefix: string, kind: "task" | "target") => DiscordModelChoice[]): () => void;
	onPresentationControl(listener: (request: DiscordPresentationControlRequest) => Promise<PiSessionControlResult>): () => void;
	ensureProjectChannel(request: ProjectChannelRequest): Promise<string>;
	ensureSessionThread(request: SessionThreadRequest): Promise<string>;
	renameSessionThread(request: RenameSessionThreadRequest): Promise<void>;
	fetchMessagesAfter(channelId: string, afterId?: string): Promise<DiscordInboundMessage[]>;
	sendText(channelId: string, text: string, nonce: string): Promise<string>;
	sendPresentation(channelId: string, presentation: ManagerPresentation, nonce: string): Promise<string>;
	latestMessageId(channelId: string): Promise<string | undefined>;
	editOwnText(channelId: string, messageId: string, text: string): Promise<void>;
	editOwnPresentation(channelId: string, messageId: string, presentation: ManagerPresentation): Promise<void>;
	deleteOwnText(channelId: string, messageId: string): Promise<void>;
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
	const previous: LifecycleReactionState[] = [];
	for (const reaction of reactions) {
		if (reaction.emoji.name === next) {
			hasNext ||= reaction.me;
			continue;
		}
		if (reaction.me && DISCORD_LIFECYCLE_REACTIONS.includes(reaction.emoji.name as DiscordLifecycleReaction)) {
			previous.push(reaction);
		}
	}
	// Display progress before cleanup. Discord may rate-limit removal, and removing first
	// leaves the message blank while the replacement waits or when its API call fails.
	if (!hasNext) await add(next);
	for (const reaction of previous) await reaction.users.remove(botUserId);
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

export async function subscribeThreadOwner(thread: {
	guild: { ownerId: string };
	members: { add(userId: string): Promise<unknown> };
}): Promise<void> {
	await thread.members.add(thread.guild.ownerId);
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

const PRESENTATION_BUTTON_STYLES: Record<ManagerPresentationStyle, ButtonStyle> = {
	primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger,
};

export function presentationComponents(presentation: ManagerPresentation): ActionRowBuilder<ButtonBuilder>[] {
	const buttons = presentation.controls.map((control) => new ButtonBuilder()
		.setCustomId(`m:${presentation.revision}:${control.id}`)
		.setLabel(control.label)
		.setStyle(PRESENTATION_BUTTON_STYLES[control.style]));
	const rows: ActionRowBuilder<ButtonBuilder>[] = [];
	for (let index = 0; index < buttons.length; index += 5) {
		rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(index, index + 5)));
	}
	return rows;
}

export function managerCommandDefinition(): ChatInputApplicationCommandData {
	const descriptions = {
		handoff: "Work directly in a retained task worker",
		takeback: "Request a worker summary and resume manager supervision",
		archive: "Archive a task without merging",
		"merge-and-archive": "Fast-forward locally into the landing branch, then archive",
		"reconcile-pr": "Check the task pull request and archive it if merged",
	} as const;
	return {
		name: MANAGER_COMMAND_NAME,
		description: "Control tasks and send requests from the live the-manager session",
		options: [
			...MANAGER_TASK_ACTIONS.map((action) => ({
				type: ApplicationCommandOptionType.Subcommand as const,
				name: action,
				description: descriptions[action],
				options: [{
					type: ApplicationCommandOptionType.String as const,
					name: "task",
					description: "Managed task",
					required: action !== "reconcile-pr",
					autocomplete: true,
				}],
			})),
			{
				type: ApplicationCommandOptionType.Subcommand,
				name: "ask",
				description: "Send a request with project or task context",
				options: [{
					type: ApplicationCommandOptionType.String,
					name: "target",
					description: "Configured project or active task",
					required: true,
					autocomplete: true,
				}, {
					type: ApplicationCommandOptionType.String,
					name: "request",
					description: "Request for the manager",
					required: true,
					maxLength: MAX_SESSION_CONTROL_TEXT_LENGTH,
				}],
			},
		],
	};
}

const MAX_PENDING_INTERACTION_CHANNELS = 1_000;

export class DiscordInteractionChannelResolver {
	private readonly channels = new Map<string, string>();

	observe(packet: unknown): void {
		// Discord's raw channel_id is the invocation context; normalized partial channel data can disagree for threads.
		if (!packet || typeof packet !== "object" || Array.isArray(packet)) return;
		const event = packet as { t?: unknown; d?: unknown };
		if (event.t !== "INTERACTION_CREATE" || !event.d || typeof event.d !== "object" || Array.isArray(event.d)) return;
		const interaction = event.d as { id?: unknown; channel_id?: unknown };
		if (typeof interaction.id !== "string" || typeof interaction.channel_id !== "string") return;
		this.channels.set(interaction.id, interaction.channel_id);
		while (this.channels.size > MAX_PENDING_INTERACTION_CHANNELS) {
			this.channels.delete(this.channels.keys().next().value!);
		}
	}

	resolve(interaction: { id: string; channelId: string | null }): string | undefined {
		const channelId = this.channels.get(interaction.id);
		this.channels.delete(interaction.id);
		return channelId ?? interaction.channelId ?? undefined;
	}
}

export class DiscordJsTransport implements DiscordTransport {
	private client: Client | undefined;
	private readonly listeners = new Set<(message: DiscordInboundMessage) => void>();
	private readonly controlListeners = new Set<(request: DiscordSessionControlRequest) => Promise<PiSessionControlResult>>();
	private readonly autocompleteListeners = new Set<(channelId: string, prefix: string) => DiscordModelChoice[]>();
	private readonly managerControlListeners = new Set<(request: DiscordManagerControlRequest) => Promise<PiSessionControlResult>>();
	private readonly managerAutocompleteListeners = new Set<(channelId: string, prefix: string, kind: "task" | "target") => DiscordModelChoice[]>();
	private readonly presentationControlListeners = new Set<(request: DiscordPresentationControlRequest) => Promise<PiSessionControlResult>>();
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
		const interactionChannels = new DiscordInteractionChannelResolver();
		client.on(Events.Raw, (packet) => interactionChannels.observe(packet));
		client.on(Events.MessageCreate, (message) => {
			const normalized: DiscordInboundMessage = {
				id: message.id,
				channelId: message.channelId,
				content: message.content,
				authorBot: message.author.bot,
				attachments: [...message.attachments.values()].map((attachment) => ({
					id: attachment.id,
					url: attachment.url,
					...(attachment.contentType ? { contentType: attachment.contentType } : {}),
					size: attachment.size,
				})),
			};
			for (const listener of this.listeners) listener(normalized);
		});
		client.on(Events.InteractionCreate, (interaction) => {
			const channelId = interactionChannels.resolve(interaction);
			if (interaction.isButton()) {
				void this.executePresentationControlInteraction(interaction, channelId);
				return;
			}
			if (interaction.isAutocomplete()) {
				const focused = interaction.options.getFocused(true);
				const managerKind = interaction.commandName === MANAGER_COMMAND_NAME &&
					(focused.name === "task" || focused.name === "target") ? focused.name : undefined;
				const pi = interaction.commandName === PI_COMMAND_NAME && focused.name === "model";
				if (!managerKind && !pi) return;
				let choices: DiscordModelChoice[] = [];
				if (channelId && managerKind) {
					for (const listener of this.managerAutocompleteListeners) {
						choices = listener(channelId, String(focused.value), managerKind);
						break;
					}
				} else if (channelId) {
					for (const listener of this.autocompleteListeners) {
						choices = listener(channelId, String(focused.value));
						break;
					}
				}
				const maximum = managerKind === "target" ? MAX_MANAGER_TARGET_AUTOCOMPLETE_CHOICES
					: managerKind === "task" ? MAX_MANAGER_TASK_AUTOCOMPLETE_CHOICES : MAX_MODEL_AUTOCOMPLETE_CHOICES;
				void interaction.respond(choices.slice(0, maximum)).catch((error) => {
					console.error("[discord-bridge] Discord autocomplete response failed:", error);
				});
				return;
			}
			if (!interaction.isChatInputCommand()) return;
			if (interaction.commandName === PI_COMMAND_NAME) void this.executeControlInteraction(interaction, channelId);
			else if (interaction.commandName === MANAGER_COMMAND_NAME) void this.executeManagerControlInteraction(interaction, channelId);
		});

		let timer: ReturnType<typeof setTimeout> | undefined;
		const ready = new Promise<void>((resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`Discord client did not become ready within ${READY_TIMEOUT_MS}ms`)), READY_TIMEOUT_MS);
			client.once(Events.ClientReady, () => resolve());
		});
		try {
			await client.login(config.token);
			await ready;
			await this.registerControls(config.guildId);
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

	onSessionControl(listener: (request: DiscordSessionControlRequest) => Promise<PiSessionControlResult>): () => void {
		this.controlListeners.add(listener);
		return () => this.controlListeners.delete(listener);
	}

	onModelAutocomplete(listener: (channelId: string, prefix: string) => DiscordModelChoice[]): () => void {
		this.autocompleteListeners.add(listener);
		return () => this.autocompleteListeners.delete(listener);
	}

	onManagerControl(listener: (request: DiscordManagerControlRequest) => Promise<PiSessionControlResult>): () => void {
		this.managerControlListeners.add(listener);
		return () => this.managerControlListeners.delete(listener);
	}

	onManagerAutocomplete(listener: (channelId: string, prefix: string, kind: "task" | "target") => DiscordModelChoice[]): () => void {
		this.managerAutocompleteListeners.add(listener);
		return () => this.managerAutocompleteListeners.delete(listener);
	}

	onPresentationControl(listener: (request: DiscordPresentationControlRequest) => Promise<PiSessionControlResult>): () => void {
		this.presentationControlListeners.add(listener);
		return () => this.presentationControlListeners.delete(listener);
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
			const thread = mapped?.isThread() ? mapped : null;
			const reused = await reuseSessionThread(thread, request.channelId);
			if (reused) {
				if (request.subscribeOwner) await subscribeThreadOwner(thread!);
				return reused;
			}
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
		if (request.subscribeOwner) await subscribeThreadOwner(thread);
		return thread.id;
	}

	async renameSessionThread(request: RenameSessionThreadRequest): Promise<void> {
		const mapped = await this.readyClient().channels.fetch(request.threadId).catch(() => null);
		const thread = mapped?.isThread() ? mapped : null;
		if (!thread || thread.parentId !== request.channelId) {
			throw new Error(`Discord session thread ${request.threadId} is missing or has the wrong parent`);
		}
		await thread.setName(request.name, "Pi session conversation title");
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
				attachments: [...message.attachments.values()].map((attachment) => ({
					id: attachment.id,
					url: attachment.url,
					...(attachment.contentType ? { contentType: attachment.contentType } : {}),
					size: attachment.size,
				})),
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
			flags: MessageFlags.SuppressEmbeds,
		});
		return message.id;
	}

	async sendPresentation(channelId: string, presentation: ManagerPresentation, nonce: string): Promise<string> {
		const channel = await this.textChannel(channelId, "receive presentations");
		const message = await channel.send({
			content: presentation.content,
			components: presentationComponents(presentation),
			nonce,
			enforceNonce: true,
			allowedMentions: { parse: [] },
			flags: MessageFlags.SuppressEmbeds,
		});
		return message.id;
	}

	async latestMessageId(channelId: string): Promise<string | undefined> {
		const channel = await this.textChannel(channelId, "inspect messages");
		return (await channel.messages.fetch({ limit: 1 })).first()?.id;
	}

	async editOwnText(channelId: string, messageId: string, text: string): Promise<void> {
		const client = this.readyClient();
		const channel = await this.textChannel(channelId, "edit messages");
		const message = await channel.messages.fetch(messageId);
		if (message.author.id !== client.user.id) throw new Error(`Discord message ${messageId} is not owned by this bot`);
		await message.edit({
			content: text,
			allowedMentions: { parse: [] },
			flags: MessageFlags.SuppressEmbeds,
		});
	}

	async editOwnPresentation(channelId: string, messageId: string, presentation: ManagerPresentation): Promise<void> {
		const client = this.readyClient();
		const channel = await this.textChannel(channelId, "edit presentations");
		const message = await channel.messages.fetch(messageId);
		if (message.author.id !== client.user.id) throw new Error(`Discord message ${messageId} is not owned by this bot`);
		await message.edit({
			content: presentation.content,
			components: presentationComponents(presentation),
			allowedMentions: { parse: [] },
			flags: MessageFlags.SuppressEmbeds,
		});
	}

	async deleteOwnText(channelId: string, messageId: string): Promise<void> {
		const client = this.readyClient();
		const channel = await this.textChannel(channelId, "delete messages");
		let message;
		try {
			message = await channel.messages.fetch(messageId);
		} catch (error) {
			if ((error as { code?: unknown }).code === 10_008) return;
			throw error;
		}
		if (message.author.id !== client.user.id) throw new Error(`Discord message ${messageId} is not owned by this bot`);
		await message.delete();
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

	private async registerControls(guildId: string): Promise<void> {
		const guild = await this.guild(guildId);
		const definition: ChatInputApplicationCommandData = {
			name: PI_COMMAND_NAME,
			description: "Control the live Pi session mapped to this thread",
			options: [
				{ type: ApplicationCommandOptionType.Subcommand, name: "status", description: "Show live Pi session status" },
				{
					type: ApplicationCommandOptionType.Subcommand,
					name: "model",
					description: "Select the Pi model",
					options: [{
						type: ApplicationCommandOptionType.String,
						name: "model",
						description: "Provider and model",
						required: true,
						autocomplete: true,
					}],
				},
				{
					type: ApplicationCommandOptionType.Subcommand,
					name: "thinking",
					description: "Select the Pi thinking level",
					options: [{
						type: ApplicationCommandOptionType.String,
						name: "level",
						description: "Thinking level",
						required: true,
						choices: PI_THINKING_LEVELS.map((level) => ({ name: level, value: level })),
					}],
				},
				{
					type: ApplicationCommandOptionType.Subcommand,
					name: "steer",
					description: "Steer the current Pi run",
					options: [{
						type: ApplicationCommandOptionType.String,
						name: "message",
						description: "Message delivered after the current turn",
						required: true,
						maxLength: MAX_SESSION_CONTROL_TEXT_LENGTH,
					}],
				},
				{
					type: ApplicationCommandOptionType.Subcommand,
					name: "followup",
					description: "Queue a Pi follow-up",
					options: [{
						type: ApplicationCommandOptionType.String,
						name: "message",
						description: "Message delivered after the current run settles",
						required: true,
						maxLength: MAX_SESSION_CONTROL_TEXT_LENGTH,
					}],
				},
				{ type: ApplicationCommandOptionType.Subcommand, name: "abort", description: "Request abort of the current Pi turn" },
			],
		};
		const managerDefinition = managerCommandDefinition();
		const existing = await guild.commands.fetch();
		const legacyManager = existing.find((candidate) => candidate.name === LEGACY_MANAGER_COMMAND_NAME);
		if (legacyManager) await guild.commands.delete(legacyManager.id);
		for (const command of [definition, managerDefinition]) {
			const current = existing.find((candidate) => candidate.name === command.name);
			if (current) await guild.commands.edit(current.id, command);
			else await guild.commands.create(command);
		}
	}

	private async executeControlInteraction(command: ChatInputCommandInteraction, channelId?: string): Promise<void> {
		try {
			await command.deferReply({ flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds });
		} catch {
			return;
		}
		let result: PiSessionControlResult;
		try {
			if (!channelId) throw new Error("Discord interaction did not identify its channel.");
			const subcommand = command.options.getSubcommand();
			const action = subcommand === "status" || subcommand === "abort"
				? { type: subcommand } as const
				: subcommand === "model"
					? { type: "model" as const, value: command.options.getString("model", true) }
					: subcommand === "thinking"
						? { type: "thinking" as const, level: command.options.getString("level", true) }
						: subcommand === "steer" || subcommand === "followup"
							? { type: subcommand, text: command.options.getString("message", true) } as const
							: undefined;
			if (!action) throw new Error("Unknown /pi subcommand");
			const listener = this.controlListeners.values().next().value;
			if (!listener) result = { ok: false, message: "Discord relay is not ready for Pi session controls." };
			else {
				result = await Promise.race([
					listener({ requestId: command.id, channelId, action }),
					new Promise<PiSessionControlResult>((resolve) => {
						const timer = setTimeout(() => resolve({ ok: false, message: "Pi session control timed out." }), CONTROL_EXECUTION_TIMEOUT_MS);
						timer.unref();
					}),
				]);
			}
		} catch (error) {
			result = { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
		const bounded = boundedControlResult(result);
		await command.editReply({
			content: `${bounded.ok ? "✅" : "❌"} ${bounded.message}`,
			allowedMentions: { parse: [] },
			flags: MessageFlags.SuppressEmbeds,
		}).catch(() => {});
	}

	private async executePresentationControlInteraction(
		interaction: import("discord.js").ButtonInteraction,
		channelId?: string,
	): Promise<void> {
		try {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds });
		} catch {
			return;
		}
		await interaction.editReply({
			content: "Running manager control…",
			allowedMentions: { parse: [] },
			flags: MessageFlags.SuppressEmbeds,
		}).catch(() => {});
		let result: PiSessionControlResult;
		try {
			if (!channelId) throw new Error("Discord interaction did not identify its channel.");
			const listener = this.presentationControlListeners.values().next().value;
			result = listener ? await listener({
				requestId: interaction.id,
				...(interaction.guildId ? { guildId: interaction.guildId } : {}),
				channelId,
				messageId: interaction.message.id,
				customId: interaction.customId,
			}) : { ok: false, message: "Discord relay is not ready for manager presentation controls." };
		} catch (error) {
			result = { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
		const bounded = boundedControlResult(result);
		await interaction.editReply({
			content: `${bounded.ok ? "✅" : "❌"} ${bounded.message}`,
			allowedMentions: { parse: [] },
			flags: MessageFlags.SuppressEmbeds,
		}).catch(() => {});
	}

	private async executeManagerControlInteraction(command: ChatInputCommandInteraction, channelId?: string): Promise<void> {
		try {
			await command.deferReply({ flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds });
		} catch {
			return;
		}
		let result: PiSessionControlResult;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (!channelId) throw new Error("Discord interaction did not identify its channel.");
			const action = command.options.getSubcommand();
			if (!(MANAGER_CONTROL_ACTIONS as readonly string[]).includes(action)) throw new Error("Unknown /m subcommand");
			const listener = this.managerControlListeners.values().next().value;
			if (!listener) result = { ok: false, message: "Discord relay is not ready for manager controls." };
			else {
				let request: DiscordManagerControlRequest;
				if (action === "ask") {
					request = {
						requestId: command.id,
						channelId,
						action: "ask",
						target: command.options.getString("target", true),
						request: command.options.getString("request", true),
					};
				} else if (action === "reconcile-pr") {
					const taskId = command.options.getString("task", false);
					request = {
						requestId: command.id,
						channelId,
						action: "reconcile-pr",
						...(taskId ? { taskId } : {}),
					};
				} else {
					request = {
						requestId: command.id,
						channelId,
						action: action as Exclude<DiscordManagerControlRequest["action"], "ask" | "reconcile-pr">,
						taskId: command.options.getString("task", true),
					};
				}
				result = await Promise.race([
					listener(request),
					new Promise<PiSessionControlResult>((resolveResult) => {
						timer = setTimeout(() => resolveResult({ ok: false, message: "Manager control timed out." }), MANAGER_CONTROL_INTERACTION_TIMEOUT_MS);
						timer.unref();
					}),
				]);
			}
		} catch (error) {
			result = { ok: false, message: error instanceof Error ? error.message : String(error) };
		} finally {
			if (timer) clearTimeout(timer);
		}
		const bounded = boundedControlResult(result);
		await command.editReply({
			content: `${bounded.ok ? "✅" : "❌"} ${bounded.message}`,
			allowedMentions: { parse: [] },
			flags: MessageFlags.SuppressEmbeds,
		}).catch(() => {});
	}

	private readyClient(): Client<true> {
		if (!this.client?.isReady()) throw new Error("Discord transport is not connected");
		return this.client;
	}

	private async textChannel(channelId: string, action: string) {
		const channel = await this.readyClient().channels.fetch(channelId).catch(() => null);
		if (!channel?.isTextBased() || channel.isDMBased()) {
			throw new Error(`Discord channel ${channelId} is missing or cannot ${action}`);
		}
		return channel;
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
