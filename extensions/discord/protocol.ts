import { createHash } from "node:crypto";
import type { DiscordBridgeConfig } from "./config.js";
import type { RelaySessionRegistration } from "./relay-core.js";

export const MAX_IPC_FRAME_BYTES = 1_048_576;

export type ClientFrame =
	| ({ type: "register"; token: string; clientId: string; configFingerprint: string } & RelaySessionRegistration)
	| { type: "user_text"; requestId: string; text: string }
	| { type: "assistant_text"; requestId: string; text: string }
	| { type: "ack_inbound"; messageId: string }
	| { type: "unregister" }
	| { type: "ping" };

export type ServerFrame =
	| { type: "registered"; channelId: string; threadId: string; leaderPid: number }
	| { type: "inbound"; messageId: string; text: string }
	| { type: "inbound_acked"; messageId: string }
	| { type: "sent"; requestId: string }
	| { type: "pong" }
	| { type: "error"; message: string; fatal?: boolean };

export function configFingerprint(config: DiscordBridgeConfig): string {
	return createHash("sha256")
		.update(`${config.token}\0${config.guildId}\0${config.categoryId ?? ""}`)
		.digest("hex");
}

export function encodeFrame(frame: ClientFrame | ServerFrame): string {
	return `${JSON.stringify(frame)}\n`;
}

export function parseFrame(line: string): unknown {
	if (Buffer.byteLength(line) > MAX_IPC_FRAME_BYTES) throw new Error("Local Discord relay IPC frame is too large");
	return JSON.parse(line) as unknown;
}

export function isClientFrame(value: unknown): value is ClientFrame {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const frame = value as Record<string, unknown>;
	if (typeof frame.type !== "string") return false;
	if (frame.type === "register") {
		return ["token", "clientId", "configFingerprint", "cwd", "sessionId"].every(
			(key) => typeof frame[key] === "string",
		) && (frame.sessionName === undefined || typeof frame.sessionName === "string");
	}
	if (frame.type === "user_text" || frame.type === "assistant_text") {
		return typeof frame.requestId === "string" && typeof frame.text === "string";
	}
	if (frame.type === "ack_inbound") return typeof frame.messageId === "string";
	return frame.type === "unregister" || frame.type === "ping";
}

export function isServerFrame(value: unknown): value is ServerFrame {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const frame = value as Record<string, unknown>;
	if (frame.type === "registered") {
		return typeof frame.channelId === "string" && typeof frame.threadId === "string" && typeof frame.leaderPid === "number";
	}
	if (frame.type === "inbound") return typeof frame.messageId === "string" && typeof frame.text === "string";
	if (frame.type === "inbound_acked") return typeof frame.messageId === "string";
	if (frame.type === "sent") return typeof frame.requestId === "string";
	if (frame.type === "error") return typeof frame.message === "string";
	return frame.type === "pong";
}
