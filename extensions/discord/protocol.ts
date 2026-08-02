import { createHash } from "node:crypto";
import type { DiscordBridgeConfig } from "./config.js";
import type { RelaySessionRegistration } from "./relay-core.js";
import type { DiscordLifecycleStatus } from "./reactions.js";
import { isQueuedInboundImageList, type QueuedInboundImage } from "./inbound-images.js";
import {
	isManagerTaskCatalogue,
	isPiManagerControlRequest,
	isPiModelCatalogue,
	isPiSessionControlAction,
	type ManagerTaskCatalogueEntry,
	type PiManagerControlRequest,
	type PiModelCatalogueEntry,
	type PiSessionControlAction,
} from "./controls.js";

export const MAX_IPC_FRAME_BYTES = 1_048_576;

export type ClientFrame =
	| ({
		type: "register";
		token: string;
		clientId: string;
		generation: string;
		configFingerprint: string;
		configEpoch: number;
		sessionControls?: { modelCatalogue: PiModelCatalogueEntry[] };
		managerControls?: { taskCatalogue: ManagerTaskCatalogueEntry[] };
		inboundImages?: true;
	} & RelaySessionRegistration)
	| { type: "outbound"; requestId: string; messageId: string; kind: "user" | "assistant"; text: string }
	| { type: "project_summary"; requestId: string; text: string }
	| { type: "ack_inbound"; requestId: string; messageId: string }
	| { type: "release_inbound_images"; requestId: string; messageId: string }
	| { type: "lifecycle"; messageId: string; status: DiscordLifecycleStatus }
	| { type: "control_result"; requestId: string; ok: boolean; message: string }
	| { type: "manager_catalogue"; requestId: string; taskCatalogue: ManagerTaskCatalogueEntry[] }
	| { type: "manager_control_result"; requestId: string; ok: boolean; message: string }
	| { type: "unregister" }
	| { type: "ping" };

export type ServerFrame =
	| {
		type: "registered";
		channelId: string;
		threadId: string;
		leaderPid: number;
		leaderNonce?: string;
		lifecycleReactions?: true;
		projectSummaries?: true;
		sessionControls?: true;
		managerControls?: true;
		inboundImages?: true;
	}
	| { type: "inbound"; messageId: string; text: string; images?: QueuedInboundImage[] }
	| { type: "control"; requestId: string; action: PiSessionControlAction }
	| ({ type: "manager_control" } & PiManagerControlRequest)
	| { type: "inbound_acked"; requestId: string; messageId: string }
	| { type: "inbound_images_released"; requestId: string; messageId: string }
	| { type: "outbound_queued"; requestId: string; messageId: string }
	| { type: "project_summary_queued"; requestId: string }
	| { type: "manager_catalogue_updated"; requestId: string }
	| { type: "pong" }
	| { type: "replacing"; configEpoch: number }
	| { type: "error"; message: string; fatal?: boolean; requestId?: string };

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
		) && typeof frame.configEpoch === "number" &&
			(frame.projectIdentityResolved === undefined || typeof frame.projectIdentityResolved === "boolean") &&
			(frame.sessionName === undefined || typeof frame.sessionName === "string") &&
			(frame.inboundImages === undefined || frame.inboundImages === true) &&
			(frame.sessionControls === undefined || (
				Boolean(frame.sessionControls) && typeof frame.sessionControls === "object" && !Array.isArray(frame.sessionControls) &&
				isPiModelCatalogue((frame.sessionControls as Record<string, unknown>).modelCatalogue)
			)) &&
			(frame.managerControls === undefined || (
				Boolean(frame.managerControls) && typeof frame.managerControls === "object" && !Array.isArray(frame.managerControls) &&
				isManagerTaskCatalogue((frame.managerControls as Record<string, unknown>).taskCatalogue)
			));
	}
	if (frame.type === "outbound") {
		return typeof frame.requestId === "string" && typeof frame.messageId === "string" && typeof frame.text === "string" &&
			(frame.kind === "user" || frame.kind === "assistant");
	}
	if (frame.type === "ack_inbound" || frame.type === "release_inbound_images") {
		return typeof frame.requestId === "string" && typeof frame.messageId === "string";
	}
	if (frame.type === "project_summary") {
		return typeof frame.requestId === "string" && typeof frame.text === "string" && frame.text.length <= 2_000;
	}
	if (frame.type === "lifecycle") {
		return typeof frame.messageId === "string" &&
			(frame.status === "accepted" || frame.status === "thinking" || frame.status === "tool" ||
				frame.status === "succeeded" || frame.status === "failed");
	}
	if (frame.type === "control_result" || frame.type === "manager_control_result") {
		return typeof frame.requestId === "string" && typeof frame.ok === "boolean" &&
			typeof frame.message === "string" && frame.message.length <= 2_000;
	}
	if (frame.type === "manager_catalogue") {
		return typeof frame.requestId === "string" && isManagerTaskCatalogue(frame.taskCatalogue);
	}
	return frame.type === "unregister" || frame.type === "ping";
}

export function isServerFrame(value: unknown): value is ServerFrame {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const frame = value as Record<string, unknown>;
	if (frame.type === "registered") {
		return typeof frame.channelId === "string" && typeof frame.threadId === "string" && typeof frame.leaderPid === "number" &&
			(frame.leaderNonce === undefined || (typeof frame.leaderNonce === "string" && frame.leaderNonce.length > 0)) &&
			(frame.lifecycleReactions === undefined || frame.lifecycleReactions === true) &&
			(frame.projectSummaries === undefined || frame.projectSummaries === true) &&
			(frame.sessionControls === undefined || frame.sessionControls === true) &&
			(frame.managerControls === undefined || frame.managerControls === true) &&
			(frame.inboundImages === undefined || frame.inboundImages === true);
	}
	if (frame.type === "inbound") {
		return typeof frame.messageId === "string" && typeof frame.text === "string" &&
			(frame.images === undefined || isQueuedInboundImageList(frame.images));
	}
	if (frame.type === "control") return typeof frame.requestId === "string" && isPiSessionControlAction(frame.action);
	if (frame.type === "manager_control") return isPiManagerControlRequest(frame);
	if (frame.type === "inbound_acked" || frame.type === "inbound_images_released") {
		return typeof frame.requestId === "string" && typeof frame.messageId === "string";
	}
	if (frame.type === "outbound_queued") return typeof frame.requestId === "string" && typeof frame.messageId === "string";
	if (frame.type === "project_summary_queued" || frame.type === "manager_catalogue_updated") return typeof frame.requestId === "string";
	if (frame.type === "error") {
		return typeof frame.message === "string" && (frame.requestId === undefined || typeof frame.requestId === "string");
	}
	if (frame.type === "replacing") return typeof frame.configEpoch === "number";
	return frame.type === "pong";
}
