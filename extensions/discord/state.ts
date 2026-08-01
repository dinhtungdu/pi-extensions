import { open, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DISCORD_STATE_FILE } from "./config.js";

const STATE_VERSION = 1;
const MAX_RECENT_MESSAGE_IDS = 500;
const LOCK_STALE_MS = 120_000;
const LOCK_RETRIES = 600;
const LOCK_RETRY_MS = 50;

export interface ProjectChannelMapping {
	channelId: string;
}

export interface SessionThreadMapping {
	cwd: string;
	channelId: string;
	threadId: string;
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

function isStringRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseState(value: unknown, file: string): DiscordBridgeState {
	if (!isStringRecord(value) || value.version !== STATE_VERSION) {
		throw new Error(`Discord bridge state ${file} has an unsupported or invalid version`);
	}
	if (!isStringRecord(value.projects) || !isStringRecord(value.sessions) || !Array.isArray(value.recentMessageIds)) {
		throw new Error(`Discord bridge state ${file} is malformed`);
	}

	const projects: Record<string, ProjectChannelMapping> = {};
	for (const [cwd, mapping] of Object.entries(value.projects)) {
		if (!isStringRecord(mapping) || typeof mapping.channelId !== "string") {
			throw new Error(`Discord bridge state ${file} has an invalid project mapping`);
		}
		projects[cwd] = { channelId: mapping.channelId };
	}

	const sessions: Record<string, SessionThreadMapping> = {};
	for (const [sessionId, mapping] of Object.entries(value.sessions)) {
		if (
			!isStringRecord(mapping) ||
			typeof mapping.cwd !== "string" ||
			typeof mapping.channelId !== "string" ||
			typeof mapping.threadId !== "string"
		) {
			throw new Error(`Discord bridge state ${file} has an invalid session mapping`);
		}
		sessions[sessionId] = {
			cwd: mapping.cwd,
			channelId: mapping.channelId,
			threadId: mapping.threadId,
		};
	}

	if (!value.recentMessageIds.every((id) => typeof id === "string")) {
		throw new Error(`Discord bridge state ${file} has invalid message IDs`);
	}
	return {
		version: STATE_VERSION,
		projects,
		sessions,
		recentMessageIds: value.recentMessageIds.slice(-MAX_RECENT_MESSAGE_IDS) as string[],
	};
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
	): Promise<string> {
		return this.mutate(async (state) => {
			const existing = state.sessions[sessionId];
			const existingThreadId = existing?.cwd === cwd && existing.channelId === channelId
				? existing.threadId
				: undefined;
			const threadId = await resolve(existingThreadId);
			state.sessions[sessionId] = { cwd, channelId, threadId };
			return threadId;
		});
	}

	async markMessageSeen(messageId: string): Promise<boolean> {
		return this.mutate(async (state) => {
			if (state.recentMessageIds.includes(messageId)) return false;
			state.recentMessageIds.push(messageId);
			state.recentMessageIds = state.recentMessageIds.slice(-MAX_RECENT_MESSAGE_IDS);
			return true;
		});
	}

	private async mutate<T>(operation: (state: DiscordBridgeState) => Promise<T>): Promise<T> {
		await mkdir(dirname(this.file), { recursive: true });
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
