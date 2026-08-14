import { createHash } from "node:crypto";
import type { DiscordBridgeConfig } from "./config.js";
import type { RelaySessionRegistration } from "./relay-core.js";
import type { DiscordLifecycleStatus } from "./reactions.js";
import { isQueuedInboundImageList, type QueuedInboundImage } from "./inbound-images.js";
import { isNativeOutboundImageList, type NativeOutboundImage } from "./outbound-images.js";
import {
	isPiModelCatalogue,
	isPiSessionControlAction,
	type PiModelCatalogueEntry,
	type PiSessionControlAction,
} from "./controls.js";
import { isManagerWakeDescriptor } from "./manager-wake.js";
import { isManagerTaskSnapshot, type ManagerTaskSnapshot } from "./manager-task-snapshot.js";
import { isManagerTaskTerminal, type ManagerTaskTerminal } from "./manager-task-terminal.js";
import {
	isManagerPresentation,
	isManagerPresentationActionControl,
	isSupportedManagerPresentationControl,
	MANAGER_PRESENTATION_SCHEMA_VERSION,
	type ManagerPresentation,
	type ManagerPresentationActionControl,
} from "./manager-presentation.js";

export const MAX_IPC_FRAME_BYTES = 16 * 1_048_576;

export type ClientFrame =
	| ({
		type: "register";
		token: string;
		clientId: string;
		generation: string;
		configFingerprint: string;
		configEpoch: number;
		sessionControls?: { modelCatalogue: PiModelCatalogueEntry[] };
		managerTaskSummaryProducer?: true;
		managerPresentation?: { schemaVersion: 1; controlIds: string[] };
		managerTaskSnapshotTaskId?: string;
		inboundImages?: true;
		nativeOutboundImages?: true;
	} & RelaySessionRegistration)
	| { type: "outbound"; requestId: string; messageId: string; kind: "user" | "assistant"; text: string; responseTo?: string[];
		nativeImages?: NativeOutboundImage[] }
	| { type: "working"; requestId: string; messageId: string }
	| { type: "manager_presentation"; requestId: string; presentation: ManagerPresentation }
	| { type: "manager_task_snapshot"; requestId: string; snapshot: ManagerTaskSnapshot }
	| { type: "manager_task_terminal"; requestId: string; terminal: ManagerTaskTerminal }
	| { type: "ack_inbound"; requestId: string; messageId: string }
	| { type: "release_inbound_images"; requestId: string; messageId: string }
	| { type: "lifecycle"; messageId: string; status: DiscordLifecycleStatus }
	| { type: "control_result"; requestId: string; ok: boolean; message: string }
	| { type: "manager_presentation_control_result"; requestId: string; ok: boolean; message: string }
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
		sessionControls?: true;
		managerPresentation?: { schemaVersion: 1; controlIds: string[] };
		inboundImages?: true;
		nativeOutboundImages?: true;
	}
	| { type: "inbound"; messageId: string; text: string; images?: QueuedInboundImage[] }
	| { type: "control"; requestId: string; action: PiSessionControlAction }
	| { type: "manager_presentation_control"; requestId: string; revision: string; controlId: string; command: string;
		actionControl?: ManagerPresentationActionControl }
	| { type: "inbound_acked"; requestId: string; messageId: string }
	| { type: "inbound_images_released"; requestId: string; messageId: string }
	| { type: "outbound_queued"; requestId: string; messageId: string }
	| { type: "working_queued"; requestId: string; messageId: string }
	| { type: "manager_presentation_queued"; requestId: string }
	| { type: "manager_task_snapshot_queued"; requestId: string }
	| { type: "manager_task_terminal_queued"; requestId: string }
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

function isManagerPresentationCapability(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const capability = value as Record<string, unknown>;
	return capability.schemaVersion === MANAGER_PRESENTATION_SCHEMA_VERSION && Array.isArray(capability.controlIds) &&
		capability.controlIds.length <= 25 && new Set(capability.controlIds).size === capability.controlIds.length && capability.controlIds.every((id) =>
			typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(id));
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
			(frame.nativeOutboundImages === undefined || frame.nativeOutboundImages === true) &&
			(frame.managerTaskSummaryProducer === undefined || frame.managerTaskSummaryProducer === true) &&
			(frame.managerTaskSnapshotTaskId === undefined ||
				(typeof frame.managerTaskSnapshotTaskId === "string" && frame.managerTaskSnapshotTaskId.length > 0)) &&
			(frame.managerWake === undefined || frame.managerWake === null || isManagerWakeDescriptor(frame.managerWake)) &&
			(frame.subscribeOwnerToThread === undefined || frame.subscribeOwnerToThread === true) &&
			(frame.managerPresentation === undefined || isManagerPresentationCapability(frame.managerPresentation)) &&
			(frame.sessionControls === undefined || (
				Boolean(frame.sessionControls) && typeof frame.sessionControls === "object" && !Array.isArray(frame.sessionControls) &&
				isPiModelCatalogue((frame.sessionControls as Record<string, unknown>).modelCatalogue)
			));
	}
	if (frame.type === "outbound") {
		return typeof frame.requestId === "string" && typeof frame.messageId === "string" && typeof frame.text === "string" &&
			(frame.kind === "user" || frame.kind === "assistant") &&
			(frame.responseTo === undefined || frame.kind === "assistant" && Array.isArray(frame.responseTo) &&
				frame.responseTo.length >= 1 && frame.responseTo.length <= 256 &&
				new Set(frame.responseTo).size === frame.responseTo.length && frame.responseTo.every((id) => typeof id === "string")) &&
			(frame.nativeImages === undefined || frame.kind === "assistant" && isNativeOutboundImageList(frame.nativeImages));
	}
	if (frame.type === "working") {
		return typeof frame.requestId === "string" && typeof frame.messageId === "string";
	}
	if (frame.type === "ack_inbound" || frame.type === "release_inbound_images") {
		return typeof frame.requestId === "string" && typeof frame.messageId === "string";
	}
	if (frame.type === "manager_presentation") {
		return typeof frame.requestId === "string" && isManagerPresentation(frame.presentation);
	}
	if (frame.type === "manager_task_snapshot") {
		return typeof frame.requestId === "string" && isManagerTaskSnapshot(frame.snapshot);
	}
	if (frame.type === "manager_task_terminal") {
		return typeof frame.requestId === "string" && isManagerTaskTerminal(frame.terminal);
	}
	if (frame.type === "lifecycle") {
		return typeof frame.messageId === "string" &&
			(frame.status === "accepted" || frame.status === "thinking" || frame.status === "tool" ||
				frame.status === "succeeded" || frame.status === "failed");
	}
	if (frame.type === "control_result" || frame.type === "manager_presentation_control_result") {
		return typeof frame.requestId === "string" && typeof frame.ok === "boolean" &&
			typeof frame.message === "string" && frame.message.length <= 2_000 &&
			(frame.type !== "manager_presentation_control_result" || frame.terminal === undefined);
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
			(frame.sessionControls === undefined || frame.sessionControls === true) &&
			(frame.managerPresentation === undefined || isManagerPresentationCapability(frame.managerPresentation)) &&
			(frame.inboundImages === undefined || frame.inboundImages === true) &&
			(frame.nativeOutboundImages === undefined || frame.nativeOutboundImages === true);
	}
	if (frame.type === "inbound") {
		return typeof frame.messageId === "string" && typeof frame.text === "string" &&
			(frame.images === undefined || isQueuedInboundImageList(frame.images));
	}
	if (frame.type === "control") return typeof frame.requestId === "string" && isPiSessionControlAction(frame.action);
	if (frame.type === "manager_presentation_control") {
		if (typeof frame.requestId !== "string" || typeof frame.revision !== "string" || !/^[a-f0-9]{64}$/.test(frame.revision) ||
			typeof frame.controlId !== "string") return false;
		if (frame.actionControl === undefined) return isSupportedManagerPresentationControl(frame.controlId, frame.command);
		return isManagerPresentationActionControl(frame.actionControl) && frame.actionControl.id === frame.controlId &&
			frame.actionControl.command === frame.command;
	}
	if (frame.type === "inbound_acked" || frame.type === "inbound_images_released") {
		return typeof frame.requestId === "string" && typeof frame.messageId === "string";
	}
	if (frame.type === "outbound_queued" || frame.type === "working_queued") {
		return typeof frame.requestId === "string" && typeof frame.messageId === "string";
	}
	if (frame.type === "manager_presentation_queued" || frame.type === "manager_task_snapshot_queued" ||
		frame.type === "manager_task_terminal_queued") {
		return typeof frame.requestId === "string";
	}
	if (frame.type === "error") {
		return typeof frame.message === "string" && (frame.requestId === undefined || typeof frame.requestId === "string");
	}
	if (frame.type === "replacing") return typeof frame.configEpoch === "number";
	return frame.type === "pong";
}
