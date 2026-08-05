import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DISCORD_STATE_FILE } from "./config.js";
import { collidingProjectChannelName, normalizeCwd, projectChannelName } from "./text.js";
import { canAdvanceLifecycleStatus, type DiscordLifecycleStatus } from "./reactions.js";
import { isQueuedInboundImageList, type QueuedInboundImage } from "./inbound-images.js";

const STATE_VERSION = 1;
export const MAX_RECENT_MESSAGE_IDS = 2_000;
const MAX_LIFECYCLE_MESSAGES_PER_SESSION = 2_000;
const MAX_RETAINED_IMAGE_MESSAGES_PER_SESSION = 2_000;
export const DISCORD_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const MIN_RETAINED_DISCORD_SESSIONS = 100;
const LOCK_STALE_MS = 120_000;
const LOCK_RETRIES = 600;
const LOCK_RETRY_MS = 50;
export const MAX_DISCORD_NONCE_LENGTH = 25;

function projectSummaryNonce(): string {
	// 144 random bits, encoded without padding, stay below Discord's 25-character limit.
	return randomBytes(18).toString("base64url");
}

function isValidDiscordNonce(nonce: string): boolean {
	return nonce.length > 0 && nonce.length <= MAX_DISCORD_NONCE_LENGTH;
}

export interface ProjectSummaryState {
	desiredText: string;
	revision: number;
	delivery?: {
		messageId: string;
		content: string;
	};
	pendingSend?: {
		nonce: string;
		content: string;
	};
}

export interface ProjectChannelMapping {
	channelId: string;
	name?: string;
	summary?: ProjectSummaryState;
}

export interface QueuedDiscordMessage {
	id: string;
	content: string;
	images?: QueuedInboundImage[];
}

export interface DiscordLifecycleMessage {
	messageId: string;
	channelId: string;
	status: DiscordLifecycleStatus;
	updatedAt: number;
}

export interface OutboundChunk {
	index: number;
	content: string;
	nonce: string;
	discordMessageId?: string;
}

export interface OutboundMessage {
	id: string;
	// "interactive" is retained only to drain state written by the short-lived 7c01263 protocol.
	kind: "user" | "interactive" | "assistant";
	threadId: string;
	chunks: OutboundChunk[];
}

export interface RetainedInboundImages {
	messageId: string;
	acknowledgedAt: number;
	images: QueuedInboundImage[];
}

export interface SessionThreadMapping {
	cwd: string;
	channelId: string;
	threadId: string;
	lastActiveAt: number;
	threadCursors: Record<string, string>;
	pendingMessages: QueuedDiscordMessage[];
	retainedImages: RetainedInboundImages[];
	outboundMessages: OutboundMessage[];
	lifecycleMessages: DiscordLifecycleMessage[];
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

function parseLifecycleMessages(value: unknown, file: string, fallbackUpdatedAt: number): DiscordLifecycleMessage[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`Discord bridge state ${file} has an invalid lifecycle message list`);
	return value.map((message) => {
		if (!isRecord(message) || typeof message.messageId !== "string" || typeof message.channelId !== "string" ||
			(message.status !== "accepted" && message.status !== "thinking" && message.status !== "tool" &&
				message.status !== "succeeded" && message.status !== "failed") ||
			(message.updatedAt !== undefined && (!Number.isSafeInteger(message.updatedAt) || Number(message.updatedAt) < 0))) {
			throw new Error(`Discord bridge state ${file} has an invalid lifecycle message`);
		}
		return {
			messageId: message.messageId,
			channelId: message.channelId,
			status: message.status as DiscordLifecycleStatus,
			updatedAt: message.updatedAt === undefined ? fallbackUpdatedAt : Number(message.updatedAt),
		};
	}).slice(-MAX_LIFECYCLE_MESSAGES_PER_SESSION);
}

function parsePendingMessages(value: unknown, file: string): QueuedDiscordMessage[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`Discord bridge state ${file} has an invalid pending message queue`);
	return value.map((message) => {
		if (!isRecord(message) || typeof message.id !== "string" || typeof message.content !== "string" ||
			(message.images !== undefined && !isQueuedInboundImageList(message.images))) {
			throw new Error(`Discord bridge state ${file} has an invalid pending message`);
		}
		const images = message.images as QueuedInboundImage[] | undefined;
		return {
			id: message.id,
			content: message.content,
			...(images?.length ? { images: images.map((image) => ({ ...image })) } : {}),
		};
	});
}

function parseRetainedImages(value: unknown, file: string): RetainedInboundImages[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_RETAINED_IMAGE_MESSAGES_PER_SESSION) {
		throw new Error(`Discord bridge state ${file} has an invalid retained image list`);
	}
	return value.map((entry) => {
		if (!isRecord(entry) || typeof entry.messageId !== "string" || !Number.isSafeInteger(entry.acknowledgedAt) ||
			Number(entry.acknowledgedAt) < 0 || !isQueuedInboundImageList(entry.images) || entry.images.length === 0) {
			throw new Error(`Discord bridge state ${file} has invalid retained image metadata`);
		}
		return {
			messageId: entry.messageId,
			acknowledgedAt: Number(entry.acknowledgedAt),
			images: (entry.images as QueuedInboundImage[]).map((image) => ({ ...image })),
		};
	});
}

function parseProjectSummary(value: unknown, file: string): ProjectSummaryState | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || typeof value.desiredText !== "string") {
		throw new Error(`Discord bridge state ${file} has an invalid project summary`);
	}
	let delivery: ProjectSummaryState["delivery"];
	if (value.delivery !== undefined) {
		if (!isRecord(value.delivery) || typeof value.delivery.messageId !== "string" || typeof value.delivery.content !== "string") {
			throw new Error(`Discord bridge state ${file} has an invalid project summary delivery`);
		}
		delivery = { messageId: value.delivery.messageId, content: value.delivery.content };
	}
	let pendingSend: ProjectSummaryState["pendingSend"];
	if (value.pendingSend !== undefined) {
		if (!isRecord(value.pendingSend) || typeof value.pendingSend.nonce !== "string" || typeof value.pendingSend.content !== "string") {
			throw new Error(`Discord bridge state ${file} has an invalid pending project summary`);
		}
		pendingSend = { nonce: value.pendingSend.nonce, content: value.pendingSend.content };
	}
	if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0)) {
		throw new Error(`Discord bridge state ${file} has an invalid project summary revision`);
	}
	return {
		desiredText: value.desiredText,
		revision: value.revision === undefined ? 0 : Number(value.revision),
		...(delivery ? { delivery } : {}),
		...(pendingSend ? { pendingSend } : {}),
	};
}

function parseState(value: unknown, file: string, fallbackActivityAt: number): DiscordBridgeState {
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
		const summary = parseProjectSummary(mapping.summary, file);
		projects[cwd] = {
			channelId: mapping.channelId,
			...(typeof mapping.name === "string" ? { name: mapping.name } : {}),
			...(summary ? { summary } : {}),
		};
	}

	const sessions: Record<string, SessionThreadMapping> = {};
	for (const [sessionId, mapping] of Object.entries(value.sessions)) {
		if (
			!isRecord(mapping) ||
			typeof mapping.cwd !== "string" ||
			typeof mapping.channelId !== "string" ||
			typeof mapping.threadId !== "string" ||
			(mapping.lastActiveAt !== undefined && (!Number.isSafeInteger(mapping.lastActiveAt) || Number(mapping.lastActiveAt) < 0)) ||
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
			lastActiveAt: mapping.lastActiveAt === undefined ? fallbackActivityAt : Number(mapping.lastActiveAt),
			threadCursors,
			pendingMessages: parsePendingMessages(mapping.pendingMessages, file),
			retainedImages: parseRetainedImages(mapping.retainedImages, file),
			outboundMessages: parseOutboundMessages(mapping.outboundMessages, file, mapping.threadId),
			lifecycleMessages: parseLifecycleMessages(mapping.lifecycleMessages, file, fallbackActivityAt),
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

function isCompletedLifecycle(status: DiscordLifecycleStatus): boolean {
	return status === "succeeded" || status === "failed";
}

function compactState(state: DiscordBridgeState, now: number, protectedSessionIds: ReadonlySet<string>): void {
	const retentionCutoff = now - DISCORD_SESSION_RETENTION_MS;
	for (const sessionId of protectedSessionIds) {
		const session = state.sessions[sessionId];
		if (session) session.lastActiveAt = now;
	}
	for (const session of Object.values(state.sessions)) {
		session.lifecycleMessages = session.lifecycleMessages.filter((message) =>
			!isCompletedLifecycle(message.status) || message.updatedAt >= retentionCutoff);
	}
	const latestSessionIds = new Set(Object.entries(state.sessions)
		.sort(([leftId, left], [rightId, right]) => right.lastActiveAt - left.lastActiveAt || leftId.localeCompare(rightId))
		.slice(0, MIN_RETAINED_DISCORD_SESSIONS)
		.map(([sessionId]) => sessionId));
	for (const [sessionId, session] of Object.entries(state.sessions)) {
		const hasQueuedWork = session.pendingMessages.length > 0 || session.outboundMessages.length > 0 ||
			session.retainedImages.length > 0 || session.lifecycleMessages.some((message) => !isCompletedLifecycle(message.status));
		if (session.lastActiveAt < retentionCutoff && !latestSessionIds.has(sessionId) &&
			!protectedSessionIds.has(sessionId) && !hasQueuedWork) {
			delete state.sessions[sessionId];
		}
	}
	state.recentMessageIds = state.recentMessageIds.slice(-MAX_RECENT_MESSAGE_IDS);
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

	constructor(
		private readonly file = DISCORD_STATE_FILE,
		private readonly now: () => number = Date.now,
	) {
		this.lockFile = `${file}.lock`;
	}

	async load(): Promise<DiscordBridgeState> {
		try {
			return parseState(JSON.parse(await readFile(this.file, "utf8")), this.file, this.now());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
			if (error instanceof Error && error.message.startsWith("Discord bridge state ")) throw error;
			throw new Error(`Cannot read Discord bridge state ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async compact(
		protectedSessionIds: ReadonlySet<string> | (() => ReadonlySet<string>) = new Set(),
	): Promise<ReadonlySet<string>> {
		return this.mutate(async (state) => {
			const protectedIds = new Set(typeof protectedSessionIds === "function" ? protectedSessionIds() : protectedSessionIds);
			compactState(state, this.now(), protectedIds);
			return protectedIds;
		});
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
			state.projects[canonicalCwd] = { channelId, name, ...(existing?.summary ? { summary: existing.summary } : {}) };
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
				lastActiveAt: this.now(),
				threadCursors: existing?.threadCursors ?? {},
				pendingMessages: existing?.pendingMessages ?? [],
				retainedImages: existing?.retainedImages ?? [],
				outboundMessages,
				lifecycleMessages: existing?.lifecycleMessages ?? [],
			};
			state.sessions[sessionId] = mapping;
			return structuredClone(mapping);
		});
	}

	async projectSummaries(): Promise<Array<{ cwd: string; mapping: ProjectChannelMapping; summary: ProjectSummaryState }>> {
		const state = await this.load();
		return Object.entries(state.projects).flatMap(([cwd, mapping]) => mapping.summary
			? [{ cwd, mapping: structuredClone(mapping), summary: structuredClone(mapping.summary) }]
			: []);
	}

	async findProjectByChannel(channelId: string): Promise<string | undefined> {
		const state = await this.load();
		return Object.entries(state.projects).find(([, mapping]) => mapping.channelId === channelId && mapping.summary)?.[0];
	}

	async setProjectSummaryDesired(
		sessionId: string,
		desiredText: string,
		candidateRevision?: number,
	): Promise<{ cwd: string; revision: number; accepted: boolean }> {
		return this.mutate(async (state) => {
			const session = state.sessions[sessionId];
			if (!session) throw new Error(`Pi session ${sessionId} has no Discord mapping`);
			session.lastActiveAt = this.now();
			const project = state.projects[session.cwd];
			if (!project || project.channelId !== session.channelId) throw new Error(`Pi session ${sessionId} has no Discord project mapping`);
			const revision = candidateRevision ?? (project.summary?.revision ?? 0) + 1;
			if (!Number.isSafeInteger(revision) || revision <= 0) throw new Error("Discord project summary revision is invalid");
			if (project.summary && revision <= project.summary.revision) {
				return { cwd: session.cwd, revision: project.summary.revision, accepted: false };
			}
			if (project.summary) {
				const changed = project.summary.desiredText !== desiredText;
				project.summary.desiredText = desiredText;
				project.summary.revision = revision;
				if (changed) delete project.summary.pendingSend;
			} else project.summary = { desiredText, revision };
			return { cwd: session.cwd, revision, accepted: true };
		});
	}

	async prepareProjectSummarySend(
		cwd: string,
		expectedRevision?: number,
	): Promise<ProjectSummaryState["pendingSend"] | undefined> {
		return this.mutate(async (state) => {
			const summary = state.projects[cwd]?.summary;
			if (!summary || summary.delivery || (expectedRevision !== undefined && summary.revision !== expectedRevision)) return undefined;
			if (!summary.pendingSend) summary.pendingSend = { nonce: projectSummaryNonce(), content: summary.desiredText };
			else if (!isValidDiscordNonce(summary.pendingSend.nonce)) {
				// Previous versions persisted UUID nonces that Discord rejected as too long.
				summary.pendingSend.nonce = projectSummaryNonce();
			}
			return structuredClone(summary.pendingSend);
		});
	}

	async recordProjectSummarySent(cwd: string, nonce: string, messageId: string, expectedRevision?: number): Promise<void> {
		await this.mutate(async (state) => {
			const summary = state.projects[cwd]?.summary;
			if (!summary?.pendingSend || summary.pendingSend.nonce !== nonce ||
				(expectedRevision !== undefined && summary.revision !== expectedRevision)) return;
			summary.delivery = { messageId, content: summary.pendingSend.content };
			delete summary.pendingSend;
		});
	}

	async recordProjectSummaryEdited(cwd: string, messageId: string, content: string, expectedRevision?: number): Promise<void> {
		await this.mutate(async (state) => {
			const summary = state.projects[cwd]?.summary;
			const delivery = summary?.delivery;
			if (delivery?.messageId === messageId && (expectedRevision === undefined || summary?.revision === expectedRevision)) {
				delivery.content = content;
			}
		});
	}

	async recordProjectSummaryDeleted(cwd: string, messageId: string, expectedRevision?: number): Promise<void> {
		await this.mutate(async (state) => {
			const summary = state.projects[cwd]?.summary;
			if (summary?.delivery?.messageId === messageId &&
				(expectedRevision === undefined || summary.revision === expectedRevision)) delete summary.delivery;
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
		message: { id: string; channelId: string; content: string; authorBot: boolean; images?: QueuedInboundImage[] },
		advanceCursor = true,
	): Promise<{ queued: boolean; message?: QueuedDiscordMessage; lifecycle?: DiscordLifecycleMessage }> {
		return this.mutate(async (state) => {
			const session = state.sessions[sessionId];
			if (!session) return { queued: false };
			session.lastActiveAt = this.now();
			if (advanceCursor) {
				session.threadCursors[message.channelId] = laterDiscordId(session.threadCursors[message.channelId], message.id);
			}
			if (message.authorBot || (!message.content.trim() && !message.images?.length) || state.recentMessageIds.includes(message.id)) {
				return { queued: false };
			}
			if (message.images && !isQueuedInboundImageList(message.images)) {
				throw new Error("Discord inbound image metadata is invalid");
			}
			state.recentMessageIds.push(message.id);
			state.recentMessageIds = state.recentMessageIds.slice(-MAX_RECENT_MESSAGE_IDS);
			const queued: QueuedDiscordMessage = {
				id: message.id,
				content: message.content,
				...(message.images?.length ? { images: message.images.map((image) => ({ ...image })) } : {}),
			};
			if (!session.pendingMessages.some((candidate) => candidate.id === message.id)) {
				session.pendingMessages.push(queued);
			}
			const lifecycle = {
				messageId: message.id,
				channelId: message.channelId,
				status: "accepted" as const,
				updatedAt: this.now(),
			};
			session.lifecycleMessages.push(lifecycle);
			session.lifecycleMessages = session.lifecycleMessages.slice(-MAX_LIFECYCLE_MESSAGES_PER_SESSION);
			return { queued: true, message: queued, lifecycle };
		});
	}

	async pendingMessages(sessionId: string): Promise<QueuedDiscordMessage[]> {
		return (await this.getSession(sessionId))?.pendingMessages ?? [];
	}

	async hasRecordedMessage(messageId: string): Promise<boolean> {
		return (await this.load()).recentMessageIds.includes(messageId);
	}

	async updateLifecycleStatus(
		sessionId: string,
		messageId: string,
		status: DiscordLifecycleStatus,
	): Promise<DiscordLifecycleMessage | undefined> {
		return this.mutate(async (state) => {
			const session = state.sessions[sessionId];
			const lifecycle = session?.lifecycleMessages.find((message) => message.messageId === messageId);
			if (!session || !lifecycle || !canAdvanceLifecycleStatus(lifecycle.status, status)) return undefined;
			const now = this.now();
			session.lastActiveAt = now;
			lifecycle.status = status;
			lifecycle.updatedAt = now;
			return structuredClone(lifecycle);
		});
	}

	async acknowledgeMessage(sessionId: string, messageId: string): Promise<void> {
		await this.mutate(async (state) => {
			const session = state.sessions[sessionId];
			if (!session) return;
			session.lastActiveAt = this.now();
			const acknowledged = session.pendingMessages.find((message) => message.id === messageId);
			if (acknowledged?.images?.length && !session.retainedImages.some((entry) => entry.messageId === messageId)) {
				session.retainedImages.push({
					messageId,
					acknowledgedAt: this.now(),
					images: acknowledged.images.map((image) => ({ ...image })),
				});
				if (session.retainedImages.length > MAX_RETAINED_IMAGE_MESSAGES_PER_SESSION) {
					throw new Error("Discord retained image metadata limit reached before image cleanup");
				}
			}
			session.pendingMessages = session.pendingMessages.filter((message) => message.id !== messageId);
		});
	}

	async releaseMessageImages(sessionId: string, messageId: string): Promise<string[]> {
		return this.mutate(async (state) => {
			const session = state.sessions[sessionId];
			if (!session) return [];
			session.lastActiveAt = this.now();
			const retained = session.retainedImages.find((entry) => entry.messageId === messageId);
			session.retainedImages = session.retainedImages.filter((entry) => entry.messageId !== messageId);
			return retained?.images.map((image) => image.localPath) ?? [];
		});
	}

	async pendingImagePaths(): Promise<Set<string>> {
		const state = await this.load();
		return new Set(Object.values(state.sessions).flatMap((session) => [
			...session.pendingMessages.flatMap((message) => message.images?.map((image) => image.localPath) ?? []),
			...session.retainedImages.flatMap((entry) => entry.images.map((image) => image.localPath)),
		]));
	}

	async enqueueOutbound(sessionId: string, message: OutboundMessage): Promise<void> {
		await this.mutate(async (state) => {
			const session = state.sessions[sessionId];
			if (!session) throw new Error(`Pi session ${sessionId} has no Discord mapping`);
			session.lastActiveAt = this.now();
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
			const session = state.sessions[sessionId];
			const message = session?.outboundMessages.find((candidate) => candidate.id === messageId);
			const chunk = message?.chunks[index];
			if (!session || !chunk) throw new Error(`Outbound chunk ${messageId}/${index} is missing`);
			session.lastActiveAt = this.now();
			chunk.discordMessageId = discordMessageId;
		});
	}

	async completeOutbound(sessionId: string, messageId: string): Promise<void> {
		await this.mutate(async (state) => {
			const session = state.sessions[sessionId];
			if (!session || session.outboundMessages[0]?.id !== messageId) return;
			if (!session.outboundMessages[0].chunks.every((chunk) => chunk.discordMessageId)) return;
			session.lastActiveAt = this.now();
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
