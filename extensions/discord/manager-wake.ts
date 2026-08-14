import { createConnection } from "node:net";
import { isAbsolute, resolve } from "node:path";

export const MANAGER_WAKE_SCHEMA_VERSION = 1;
export const MANAGER_WAKE_TIMEOUT_MS = 2_000;
export const MAX_MANAGER_WAKE_RESPONSE_BYTES = 4_096;
const MAX_MANAGER_WAKE_DESCRIPTOR_BYTES = 4_096;
const MAX_MANAGER_WAKE_SOCKET_PATH_LENGTH = 1_024;

export interface ManagerWakeDescriptor {
	schemaVersion: 1;
	provider: "the-manager";
	socketPath: string;
	taskId: string;
	generation: number;
	capability: string;
}

interface ManagerWakeRequest {
	type: "discord_session_wake";
	schema_version: 1;
	request_id: string;
	task_id: string;
	session_id: string;
	generation: number;
	capability: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isManagerWakeDescriptor(value: unknown): value is ManagerWakeDescriptor {
	if (!isRecord(value) || !hasExactKeys(value, [
		"schemaVersion", "provider", "socketPath", "taskId", "generation", "capability",
	])) return false;
	return value.schemaVersion === MANAGER_WAKE_SCHEMA_VERSION && value.provider === "the-manager" &&
		typeof value.socketPath === "string" && value.socketPath.length > 0 &&
		value.socketPath.length <= MAX_MANAGER_WAKE_SOCKET_PATH_LENGTH && !value.socketPath.includes("\0") &&
		isAbsolute(value.socketPath) && typeof value.taskId === "string" && value.taskId.length > 0 &&
		value.taskId.length <= 200 && Number.isSafeInteger(value.generation) && Number(value.generation) > 0 &&
		typeof value.capability === "string" && /^[a-f0-9]{64}$/.test(value.capability);
}

export function managerWakeRegistration(environment: NodeJS.ProcessEnv): ManagerWakeDescriptor | null | undefined {
	if (environment.THE_MANAGER_ROLE !== "task-lead") return undefined;
	const encoded = environment.THE_MANAGER_DISCORD_WAKE_DESCRIPTOR;
	if (!encoded || Buffer.byteLength(encoded) > MAX_MANAGER_WAKE_DESCRIPTOR_BYTES) return null;
	let descriptor: unknown;
	try {
		descriptor = JSON.parse(encoded);
	} catch {
		return null;
	}
	if (!isManagerWakeDescriptor(descriptor)) return null;
	const generation = Number(environment.THE_MANAGER_TASK_LEAD_GENERATION);
	const root = environment.THE_MANAGER_ROOT;
	const broadCapability = environment.THE_MANAGER_TASK_LEAD_CAPABILITY;
	if (!root || !isAbsolute(root) || descriptor.socketPath !== resolve(root, ".manager", "supervisor.sock") ||
		descriptor.taskId !== environment.THE_MANAGER_TASK_ID || !Number.isSafeInteger(generation) || generation < 1 ||
		descriptor.generation !== generation || !broadCapability || !/^[a-f0-9]{64}$/.test(broadCapability) ||
		descriptor.capability === broadCapability) return null;
	return { ...descriptor };
}

function isSuccessfulResponse(value: unknown, request: ManagerWakeRequest): boolean {
	if (!isRecord(value) || !hasExactKeys(value, [
		"ok", "type", "schema_version", "request_id", "task_id", "session_id", "generation",
	])) return false;
	return value.ok === true && value.type === request.type && value.schema_version === request.schema_version &&
		value.request_id === request.request_id && value.task_id === request.task_id &&
		value.session_id === request.session_id && value.generation === request.generation;
}

export function wakeManagerSession(
	descriptor: ManagerWakeDescriptor,
	sessionId: string,
	messageId: string,
): Promise<void> {
	if (!sessionId || sessionId.length > 200 || !messageId || messageId.length > 100) {
		return Promise.reject(new Error("Manager wake identity is invalid"));
	}
	const request: ManagerWakeRequest = {
		type: "discord_session_wake",
		schema_version: MANAGER_WAKE_SCHEMA_VERSION,
		request_id: messageId,
		task_id: descriptor.taskId,
		session_id: sessionId,
		generation: descriptor.generation,
		capability: descriptor.capability,
	};
	return new Promise((resolveRequest, rejectRequest) => {
		const socket = createConnection(descriptor.socketPath);
		let settled = false;
		let response = "";
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) rejectRequest(error);
			else resolveRequest();
		};
		const timer = setTimeout(() => finish(new Error(`Manager wake timed out after ${MANAGER_WAKE_TIMEOUT_MS}ms`)),
			MANAGER_WAKE_TIMEOUT_MS);
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk: string) => {
			response += chunk;
			if (Buffer.byteLength(response) > MAX_MANAGER_WAKE_RESPONSE_BYTES) {
				finish(new Error("Manager wake response is too large"));
				return;
			}
			const newline = response.indexOf("\n");
			if (newline < 0) return;
			try {
				const parsed: unknown = JSON.parse(response.slice(0, newline));
				finish(isSuccessfulResponse(parsed, request) ? undefined : new Error("Manager wake was rejected"));
			} catch {
				finish(new Error("Manager wake response is malformed"));
			}
		});
		socket.once("error", (error) => finish(error));
		socket.once("close", () => finish(new Error("Manager wake endpoint closed without a response")));
	});
}
