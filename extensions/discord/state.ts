import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DISCORD_STATE_FILE } from "./config.js";
import { collidingProjectChannelName, normalizeCwd, projectChannelName } from "./text.js";

const STATE_VERSION = 1;
const MAX_RECENT_MESSAGE_IDS = 2_000;
const LOCK_STALE_MS = 120_000;
const LOCK_RETRIES = 600;
const LOCK_RETRY_MS = 50;

export interface ProjectChannelMapping {
	channelId: string;
	name?: string;
}

export interface QueuedDiscordMessage {
	id: string;
	content: string;
}

export interface OutboundChunk {
	index: number;
	content: string;
	nonce: string;
	discordMessageId?: string;
}

export interface OutboundMessage {
	id: string;
	kind: "user" | "interactive" | "assistant";
	threadId: string;
	chunks: OutboundChunk[];
}

export interface SessionThreadMapping {
	cwd: string;
	channelId: string;
	threadId: string;
	threadCursors: Record<string, string>;
	pendingMessages: QueuedDiscordMessage[];
	outboundMessages: OutboundMessage[];
}

export interface DiscordBridgeState {
	version: 1;
	projects: Record<string, ProjectChannelMapping>;
	sessions: Record<string, SessionThreadMapping>;
	recentMessageIds: string[];
}

function emptyState(): DiscordBridgeState {
	return { version: STATE_VERSION, projects: {}, sessions: {}, recentMessageIds: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseOutboundMessages(value: unknown, file: string, fallbackThreadId: string): OutboundMessage[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`Discord bridge state ${file} has an invalid outbound queue`);
	return value.map((message) => {
		if (!isRecord(message) || typeof message.id !== "string" ||
			(message.kind !== "user" && message.kind !== "interactive" && message.kind !== "assistant") ||
			(message.threadId !== undefined && typeof message.threadId !== "string") || !Array.isArray(message.chunks)) {
			throw new Error(`Discord bridge state ${file} has an invalid outbound message`);
		}
		const chunks = message.chunks.map((chunk) => {
			if (!isRecord(chunk) || typeof chunk.index !== "number" || typeof chunk.content !== "string" || typeof chunk.nonce !== "string" ||
				(chunk.discordMessageId !== undefined && typeof chunk.discordMessageId !== "string")) {
				throw new Error(`Discord bridge state ${file} has an invalid outbound chunk`);
			}
			return {
				index: chunk.index,
				content: chunk.content,
				nonce: chunk.nonce,
				...(typeof chunk.discordMessageId === "string" ? { discordMessageId: chunk.discordMessageId } : {}),
			};
		});
		return {
			id: message.id,
			kind: message.kind,
			threadId: typeof message.threadId === "string" ? message.threadId : fallbackThreadId,
			chunks,
		};
	});
}

function parsePendingMessages(value: unknown, file: string): QueuedDiscordMessage[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`Discord bridge state ${file} has an invalid pending message queue`);
	return value.map((message) => {
		if (!isRecord(message) || typeof message.id !== "string" || typeof message.content !== "string") {
			throw new Error(`Discord bridge state ${file} has an invalid pending message`);
		}
		return { id: message.id, content: message.content };
	});
}

function parseState(value: unknown, file: string): DiscordBridgeState {
	if (!isRecord(value) || value.version !== STATE_VERSION) {
		throw new Error(`Discord bridge state ${file} has an unsupported or invalid version`);
	}
	if (!isRecord(value.projects) || !isRecord(value.sessions) || !Array.isArray(value.recentMessageIds)) {
		throw new Error(`Discord bridge state ${file} is malformed`);
	}

	const projects: Record<string, ProjectChannelMapping> = {};
	for (const [cwd, mapping] of Object.entries(value.projects)) {
		if (!isRecord(mapping) || typeof mapping.channelId !== "string" ||
			(mapping.name !== undefined && typeof mapping.name !== "string")) {
			throw new Error(`Discord bridge state ${file} has an invalid project mapping`);
		}
		projects[cwd] = {
			channelId: mapping.channelId,
			...(typeof mapping.name === "string" ? { name: mapping.name } : {}),
		};
	}

	const sessions: Record<string, SessionThreadMapping> = {};
	for (const [sessionId, mapping] of Object.entries(value.sessions)) {
		if (
			!isRecord(mapping) ||
			typeof mapping.cwd !== "string" ||
			typeof mapping.channelId !== "string" ||
			typeof mapping.threadId !== "string" ||
			(mapping.lastMessageId !== undefined && typeof mapping.lastMessageId !== "string") ||
			(mapping.threadCursors !== undefined && !isRecord(mapping.threadCursors))
		) {
			throw new Error(`Discord bridge state ${file} has an invalid session mapping`);
		}
		const threadCursors: Record<string, string> = {};
		if (isRecord(mapping.threadCursors)) {
			for (const [threadId, cursor] of Object.entries(mapping.threadCursors)) {
				if (typeof cursor !== "string") throw new Error(`Discord bridge state ${file} has an invalid thread cursor`);
				threadCursors[threadId] = cursor;
			}
		}
		if (typeof mapping.lastMessageId === "string" && !threadCursors[mapping.threadId]) {
			threadCursors[mapping.threadId] = mapping.lastMessageId;
		}
		sessions[sessionId] = {
			cwd: mapping.cwd,
			channelId: mapping.channelId,
			threadId: mapping.threadId,
			threadCursors,
			pendingMessages: parsePendingMessages(mapping.pendingMessages, file),
			outboundMessages: parseOutboundMessages(mapping.outboundMessages, file, mapping.threadId),
		};
	}

	if (!value.recentMessageIds.every((id) => typeof id === "string")) {
		throw new Error(`Discord bridge state ${file} has invalid message IDs`);
	}
	return {
		version: STATE_VERSION,
		projects,
		sessions,
		recentMessageIds: (value.recentMessageIds as string[]).slice(-MAX_RECENT_MESSAGE_IDS),
	};
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function laterDiscordId(current: string | undefined, candidate: string): string {
	if (!current) return candidate;
	try {
		return BigInt(candidate) > BigInt(current) ? candidate : current;
	} catch {
		return candidate > current ? candidate : current;
	}
}

export class DiscordStateStore {
	private readonly lockFile: string;

	constructor(private readonly file = DISCORD_STATE_FILE) {
		this.lockFile = `${file}.lock`;
	}

	async load(): Promise<DiscordBridgeState> {
		try {
			return parseState(JSON.parse(await readFile(this.file, "utf8")), this.file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
			if (error instanceof Error && error.message.startsWith("Discord bridge state ")) throw error;
			throw new Error(`Cannot read Discord bridge state ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async resolveProjectChannel(
		cwd: string,
		resolve: (request: { existingChannelId?: string; name: string }) => Promise<string>,
	): Promise<string> {
		const canonicalCwd = normalizeCwd(cwd);
		return this.mutate(async (state) => {
			const cleanName = projectChannelName(canonicalCwd);
			const collidingCwds = Object.keys(state.projects).filter((mappedCwd) => projectChannelName(mappedCwd) === cleanName);
			if (!collidingCwds.includes(canonicalCwd)) collidingCwds.push(canonicalCwd);
			for (const [index, mappedCwd] of collidingCwds.entries()) {
				const mapping = state.projects[mappedCwd];
				if (mapping && !mapping.name) {
					mapping.name = index === 0 ? cleanName : collidingProjectChannelName(mappedCwd);
				}
			}
			const existing = state.projects[canonicalCwd];
			const name = existing?.name ?? (collidingCwds[0] === canonicalCwd ? cleanName : collidingProjectChannelName(canonicalCwd));
			const channelId = await resolve({
				...(existing?.channelId ? { existingChannelId: existing.channelId } : {}),
				name,
			});
			state.projects[canonicalCwd] = { channelId, name };
			return channelId;
		});
	}

	async resolveSessionThread(
		sessionId: string,
		cwd: string,
		channelId: string,
		resolve: (existingThreadId: string | undefined) => Promise<string>,
	): Promise<SessionThreadMapping> {
		return this.mutate(async (state) => {
			const existing = state.sessions[sessionId];
			const sameParent = existing?.cwd === cwd && existing.channelId === channelId;
			const threadId = await resolve(sameParent ? existing.threadId : undefined);
			const outboundMessages = existing?.outboundMessages ?? [];
			for (const message of outboundMessages) message.threadId = threadId;
			const mapping: SessionThreadMapping = {
				cwd,
				channelId,
				threadId,
				threadCursors: existing?.threadCursors ?? {},
				pendingMessages: existing?.pendingMessages ?? [],
				outboundMessages,
			};
			state.sessions[sessionId] = mapping;
			return structuredClone(mapping);
		});
	}

	async findSessionByThread(threadId: string): Promise<{ sessionId: string; mapping: SessionThreadMapping } | undefined> {
		const state = await this.load();
		for (const [sessionId, mapping] of Object.entries(state.sessions)) {
			if (mapping.threadId === threadId) return { sessionId, mapping };
		}
		return undefined;
	}

	async getSession(sessionId: string): Promise<SessionThreadMapping | undefined> {
		const mapping = (await this.load()).sessions[sessionId];
		return mapping ? structuredClone(mapping) : undefined;
	}

	async recordDiscordMessage(
		sessionId: string,
		message: { id: string; channelId: string; content: string; authorBot: boolean },
		advanceCursor = true,
	): Promise<{ queued: boolean; message?: QueuedDiscordMessage }> {
		return this.mutate(async (state) => {
			const session = state.sessions[sessionId];
			if (!session) return { queued: false };
			if (advanceCursor) {
				session.threadCursors[message.channelId] = laterDiscordId(session.threadCursors[message.channelId], message.id);
			}
			if (message.authorBot || !message.content.trim() || state.recentMessageIds.includes(message.id)) {
				return { queued: false };
			}
			state.recentMessageIds.push(message.id);
			state.recentMessageIds = state.recentMessageIds.slice(-MAX_RECENT_MESSAGE_IDS);
			const queued = { id: message.id, content: message.content };
			if (!session.pendingMessages.some((candidate) => candidate.id === message.id)) {
				session.pendingMessages.push(queued);
			}
			return { queued: true, message: queued };
		});
	}

	async pendingMessages(sessionId: string): Promise<QueuedDiscordMessage[]> {
		return (await this.getSession(sessionId))?.pendingMessages ?? [];
	}

	async acknowledgeMessage(sessionId: string, messageId: string): Promise<void> {
		await this.mutate(async (state) => {
			const session = state.sessions[sessionId];
			if (session) session.pendingMessages = session.pendingMessages.filter((message) => message.id !== messageId);
		});
	}

	async enqueueOutbound(sessionId: string, message: OutboundMessage): Promise<void> {
		await this.mutate(async (state) => {
			const session = state.sessions[sessionId];
			if (!session) throw new Error(`Pi session ${sessionId} has no Discord mapping`);
			const existing = session.outboundMessages.find((candidate) => candidate.id === message.id);
			if (existing) {
				const sameChunks = existing.chunks.length === message.chunks.length && existing.chunks.every((chunk, index) => {
					const retried = message.chunks[index];
					return retried && chunk.index === retried.index && chunk.content === retried.content && chunk.nonce === retried.nonce;
				});
				if (!sameChunks || existing.kind !== message.kind) throw new Error(`Outbound message ${message.id} was retried with different content`);
				return;
			}
			session.outboundMessages.push(structuredClone(message));
		});
	}

	async nextOutbound(
		eligibleSessionIds?: ReadonlySet<string>,
		excludedSessionIds: ReadonlySet<string> = new Set(),
	): Promise<{ sessionId: string; mapping: SessionThreadMapping; message: OutboundMessage } | undefined> {
		const state = await this.load();
		for (const [sessionId, mapping] of Object.entries(state.sessions)) {
			if ((eligibleSessionIds && !eligibleSessionIds.has(sessionId)) || excludedSessionIds.has(sessionId)) continue;
			const message = mapping.outboundMessages[0];
			if (message) return { sessionId, mapping, message };
		}
		return undefined;
	}

	async markOutboundChunkSent(sessionId: string, messageId: string, index: number, discordMessageId: string): Promise<void> {
		await this.mutate(async (state) => {
			const message = state.sessions[sessionId]?.outboundMessages.find((candidate) => candidate.id === messageId);
			const chunk = message?.chunks[index];
			if (!chunk) throw new Error(`Outbound chunk ${messageId}/${index} is missing`);
			chunk.discordMessageId = discordMessageId;
		});
	}

	async completeOutbound(sessionId: string, messageId: string): Promise<void> {
		await this.mutate(async (state) => {
			const session = state.sessions[sessionId];
			if (!session || session.outboundMessages[0]?.id !== messageId) return;
			if (!session.outboundMessages[0].chunks.every((chunk) => chunk.discordMessageId)) return;
			session.outboundMessages.shift();
		});
	}

	private async mutate<T>(operation: (state: DiscordBridgeState) => Promise<T>): Promise<T> {
		await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
		const release = await this.acquireLock();
		try {
			const state = await this.load();
			const result = await operation(state);
			await this.write(state);
			return result;
		} finally {
			await release();
		}
	}

	private async write(state: DiscordBridgeState): Promise<void> {
		const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
		await rename(temporary, this.file);
	}

	private async acquireLock(): Promise<() => Promise<void>> {
		for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
			try {
				const handle = await open(this.lockFile, "wx", 0o600);
				await handle.writeFile(`${process.pid}\n`);
				return async () => {
					await handle.close();
					await unlink(this.lockFile).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
					});
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					const lockStat = await stat(this.lockFile);
					if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
						await unlink(this.lockFile);
						continue;
					}
				} catch (statError) {
					if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw statError;
				}
				await delay(LOCK_RETRY_MS);
			}
		}
		throw new Error(`Timed out waiting for Discord bridge state lock ${this.lockFile}`);
	}
}
