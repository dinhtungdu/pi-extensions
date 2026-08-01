import { createHash } from "node:crypto";
import type { DiscordBridgeConfig } from "./config.js";
import type { RelaySessionRegistration } from "./relay-core.js";

export const MAX_IPC_FRAME_BYTES = 1_048_576;

export type ClientFrame =
	| ({ type: "register"; token: string; clientId: string; generation: string; configFingerprint: string; configEpoch: number } & RelaySessionRegistration)
	| { type: "outbound"; requestId: string; messageId: string; kind: "user" | "interactive" | "assistant"; text: string }
	| { type: "ack_inbound"; requestId: string; messageId: string }
	| { type: "unregister" }
	| { type: "ping" };

export type ServerFrame =
	| { type: "registered"; channelId: string; threadId: string; leaderPid: number }
	| { type: "inbound"; messageId: string; text: string }
	| { type: "inbound_acked"; requestId: string; messageId: string }
	| { type: "outbound_queued"; requestId: string; messageId: string }
	| { type: "pong" }
	| { type: "replacing"; configEpoch: number }
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
		return ["token", "clientId", "generation", "configFingerprint", "cwd", "sessionId"].every(
			(key) => typeof frame[key] === "string",
		) && typeof frame.configEpoch === "number" && (frame.sessionName === undefined || typeof frame.sessionName === "string");
	}
	if (frame.type === "outbound") {
		return typeof frame.requestId === "string" && typeof frame.messageId === "string" && typeof frame.text === "string" &&
			(frame.kind === "user" || frame.kind === "interactive" || frame.kind === "assistant");
	}
	if (frame.type === "ack_inbound") return typeof frame.requestId === "string" && typeof frame.messageId === "string";
	return frame.type === "unregister" || frame.type === "ping";
}

export function isServerFrame(value: unknown): value is ServerFrame {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const frame = value as Record<string, unknown>;
	if (frame.type === "registered") {
		return typeof frame.channelId === "string" && typeof frame.threadId === "string" && typeof frame.leaderPid === "number";
	}
	if (frame.type === "inbound") return typeof frame.messageId === "string" && typeof frame.text === "string";
	if (frame.type === "inbound_acked") return typeof frame.requestId === "string" && typeof frame.messageId === "string";
	if (frame.type === "outbound_queued") return typeof frame.requestId === "string" && typeof frame.messageId === "string";
	if (frame.type === "error") return typeof frame.message === "string";
	if (frame.type === "replacing") return typeof frame.configEpoch === "number";
	return frame.type === "pong";
}
