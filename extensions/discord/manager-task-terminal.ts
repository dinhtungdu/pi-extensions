export const MANAGER_TASK_TERMINAL_SCHEMA_VERSION = 1;
export const MAX_MANAGER_TASK_TERMINAL_CONTENT = 1_900;
const MANAGER_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ManagerTaskTerminal {
	schemaVersion: 1;
	revision: string;
	taskId: string;
	content: string;
	closeThread: true;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

export function isManagerTaskTerminal(value: unknown): value is ManagerTaskTerminal {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const terminal = value as Record<string, unknown>;
	return exactKeys(terminal, ["schemaVersion", "revision", "taskId", "content", "closeThread"]) &&
		terminal.schemaVersion === MANAGER_TASK_TERMINAL_SCHEMA_VERSION &&
		typeof terminal.revision === "string" && /^[a-f0-9]{64}$/.test(terminal.revision) &&
		typeof terminal.taskId === "string" && MANAGER_TASK_ID.test(terminal.taskId) &&
		typeof terminal.content === "string" && terminal.content.length >= 1 &&
		terminal.content.length <= MAX_MANAGER_TASK_TERMINAL_CONTENT && terminal.closeThread === true;
}
