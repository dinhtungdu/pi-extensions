import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DISCORD_STATE_FILE } from "./config.js";

const STATE_VERSION = 1;
const MAX_RECENT_MESSAGE_IDS = 2_000;
const LOCK_STALE_MS = 120_000;
const LOCK_RETRIES = 600;
const LOCK_RETRY_MS = 50;

export interface ProjectChannelMapping {
	channelId: string;
}

export interface QueuedDiscordMessage {
	id: string;
	content: string;
}

export interface SessionThreadMapping {
	cwd: string;
	channelId: string;
	threadId: string;
	lastMessageId?: string;
	pendingMessages: QueuedDiscordMessage[];
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
		if (!isRecord(mapping) || typeof mapping.channelId !== "string") {
			throw new Error(`Discord bridge state ${file} has an invalid project mapping`);
		}
		projects[cwd] = { channelId: mapping.channelId };
	}

	const sessions: Record<string, SessionThreadMapping> = {};
	for (const [sessionId, mapping] of Object.entries(value.sessions)) {
		if (
			!isRecord(mapping) ||
			typeof mapping.cwd !== "string" ||
			typeof mapping.channelId !== "string" ||
			typeof mapping.threadId !== "string" ||
			(mapping.lastMessageId !== undefined && typeof mapping.lastMessageId !== "string")
		) {
			throw new Error(`Discord bridge state ${file} has an invalid session mapping`);
		}
		sessions[sessionId] = {
			cwd: mapping.cwd,
			channelId: mapping.channelId,
			threadId: mapping.threadId,
			...(typeof mapping.lastMessageId === "string" ? { lastMessageId: mapping.lastMessageId } : {}),
			pendingMessages: parsePendingMessages(mapping.pendingMessages, file),
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
		resolve: (existingChannelId: string | undefined) => Promise<string>,
	): Promise<string> {
		return this.mutate(async (state) => {
			const channelId = await resolve(state.projects[cwd]?.channelId);
			state.projects[cwd] = { channelId };
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
			const mapping: SessionThreadMapping = {
				cwd,
				channelId,
				threadId,
				...(sameParent && existing?.lastMessageId ? { lastMessageId: existing.lastMessageId } : {}),
				pendingMessages: sameParent ? existing.pendingMessages : [],
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
		message: { id: string; content: string; authorBot: boolean },
	): Promise<{ queued: boolean; message?: QueuedDiscordMessage }> {
		return this.mutate(async (state) => {
			const session = state.sessions[sessionId];
			if (!session) return { queued: false };
			session.lastMessageId = laterDiscordId(session.lastMessageId, message.id);
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
