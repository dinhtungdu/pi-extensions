import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

const DISCORD_NAME_LIMIT = 100;
const DISCORD_MESSAGE_LIMIT = 2_000;
const SAFE_MESSAGE_LIMIT = 1_900;

function slug(value: string, fallback: string): string {
	const result = value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return result || fallback;
}

function projectSlug(value: string): string {
	const result = value
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return result || "project";
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function normalizeCwd(cwd: string): string {
	return resolve(cwd);
}

export function projectChannelName(cwd: string): string {
	return projectSlug(basename(normalizeCwd(cwd))).slice(0, DISCORD_NAME_LIMIT);
}

export function collidingProjectChannelName(cwd: string): string {
	const normalized = normalizeCwd(cwd);
	const suffix = shortHash(normalized);
	const prefix = projectChannelName(normalized);
	return `${prefix.slice(0, DISCORD_NAME_LIMIT - suffix.length - 1)}-${suffix}`;
}

export function sessionThreadName(sessionId: string, sessionName?: string): string {
	const suffix = slug(sessionId.replaceAll("-", "").slice(0, 8), "session");
	const prefix = `pi-${slug(sessionName ?? "session", "session")}`;
	return `${prefix.slice(0, DISCORD_NAME_LIMIT - suffix.length - 1)}-${suffix}`;
}

export function assistantText(message: {
	role?: string;
	content?: unknown;
	stopReason?: string;
}): string | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
	const text = message.content
		.filter((part): part is { type: "text"; text: string } => {
			return Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string";
		})
		.map((part) => part.text)
		.join("")
		.trim();
	return text || undefined;
}

const INTERACTIVE_HEADER = "──────────── 👨‍💻 ────────────";
const INTERACTIVE_FOOTER = "──────────────────────────────";
const INTERACTIVE_PREFIX = `${INTERACTIVE_HEADER}\n`;
const INTERACTIVE_SUFFIX = `\n${INTERACTIVE_FOOTER}`;
const MAX_UTF16_CODE_POINT_LENGTH = 2;

export function interactiveUserChunks(text: string, maximum = SAFE_MESSAGE_LIMIT): string[] {
	const frameLength = INTERACTIVE_PREFIX.length + INTERACTIVE_SUFFIX.length;
	const payloadLimit = maximum - frameLength;
	const minimum = frameLength + MAX_UTF16_CODE_POINT_LENGTH;
	if (!Number.isInteger(maximum) || maximum < minimum || maximum > DISCORD_MESSAGE_LIMIT) {
		throw new Error(`Formatted Discord message limit must be between ${minimum} and ${DISCORD_MESSAGE_LIMIT}`);
	}
	const payloads: string[] = [];
	let payload = "";
	for (const character of text) {
		if (payload && payload.length + character.length > payloadLimit) {
			payloads.push(payload);
			payload = "";
		}
		payload += character;
	}
	if (payload) payloads.push(payload);
	return payloads.map((chunk) => `${INTERACTIVE_PREFIX}${chunk}${INTERACTIVE_SUFFIX}`);
}

export function splitDiscordText(text: string, maximum = SAFE_MESSAGE_LIMIT): string[] {
	if (!Number.isInteger(maximum) || maximum < 1 || maximum > DISCORD_MESSAGE_LIMIT) {
		throw new Error(`Discord message limit must be between 1 and ${DISCORD_MESSAGE_LIMIT}`);
	}
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > maximum) {
		let cut = remaining.lastIndexOf("\n", maximum);
		if (cut < Math.floor(maximum / 2)) cut = remaining.lastIndexOf(" ", maximum);
		if (cut < 1) cut = maximum;
		chunks.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut);
		if (remaining.startsWith("\n")) remaining = remaining.slice(1);
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}
