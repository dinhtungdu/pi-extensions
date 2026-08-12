export const MANAGER_TASK_SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_MANAGER_TASK_SNAPSHOT_CONTENT = 1_900;

export interface ManagerTaskSnapshot {
	schemaVersion: 1;
	revision: string;
	taskId: string;
	title: string;
	status: string;
	content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isManagerTaskSnapshot(value: unknown): value is ManagerTaskSnapshot {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value).sort();
	const expected = ["content", "revision", "schemaVersion", "status", "taskId", "title"];
	return keys.length === expected.length && keys.every((key, index) => key === expected[index]) &&
		value.schemaVersion === MANAGER_TASK_SNAPSHOT_SCHEMA_VERSION && typeof value.revision === "string" &&
		/^[a-f0-9]{64}$/.test(value.revision) && typeof value.taskId === "string" && value.taskId.length > 0 &&
		typeof value.title === "string" && typeof value.status === "string" && typeof value.content === "string" &&
		value.content.length >= 1 && value.content.length <= MAX_MANAGER_TASK_SNAPSHOT_CONTENT;
}

export function acceptedManagerTaskSnapshot(
	environment: NodeJS.ProcessEnv,
	value: unknown,
): ManagerTaskSnapshot | undefined {
	if (environment.THE_MANAGER_ROLE !== "middle-manager" || !environment.THE_MANAGER_TASK_ID ||
		!isManagerTaskSnapshot(value) || value.taskId !== environment.THE_MANAGER_TASK_ID) return undefined;
	return structuredClone(value);
}
