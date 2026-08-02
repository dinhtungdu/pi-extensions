export const MAX_MODEL_CATALOGUE_ITEMS = 500;
export const MAX_MODEL_AUTOCOMPLETE_CHOICES = 25;
export const MAX_MANAGER_TASK_CATALOGUE_ITEMS = 500;
export const MAX_MANAGER_PROJECT_CATALOGUE_ITEMS = 500;
export const MAX_MANAGER_TASK_AUTOCOMPLETE_CHOICES = 25;
export const MAX_MANAGER_TARGET_AUTOCOMPLETE_CHOICES = 25;
export const MAX_SESSION_CONTROL_TEXT_LENGTH = 2_000;
export const MAX_SESSION_CONTROL_QUEUE = 32;
export const MAX_RECENT_SESSION_CONTROLS = 2_000;

export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = typeof PI_THINKING_LEVELS[number];

export interface PiModelCatalogueEntry {
	provider: string;
	id: string;
	name: string;
}

export type PiSessionControlAction =
	| { type: "status" }
	| { type: "model"; provider: string; modelId: string }
	| { type: "thinking"; level: PiThinkingLevel }
	| { type: "steer"; text: string }
	| { type: "followup"; text: string }
	| { type: "abort" };

export interface PiSessionControlRequest {
	requestId: string;
	action: PiSessionControlAction;
}

export interface PiSessionControlResult {
	ok: boolean;
	message: string;
}

export type DiscordSessionControlAction =
	| { type: "status" }
	| { type: "model"; value: string }
	| { type: "thinking"; level: string }
	| { type: "steer"; text: string }
	| { type: "followup"; text: string }
	| { type: "abort" };

export interface DiscordSessionControlRequest {
	requestId: string;
	channelId: string;
	action: DiscordSessionControlAction;
}

export interface DiscordModelChoice {
	name: string;
	value: string;
}

export const MANAGER_LIFECYCLE_ACTIONS = ["handoff", "takeback", "archive", "merge-and-archive"] as const;
export const MANAGER_TASK_ACTIONS = [...MANAGER_LIFECYCLE_ACTIONS, "reconcile-pr"] as const;
export const MANAGER_CONTROL_ACTIONS = [...MANAGER_TASK_ACTIONS, "ask"] as const;
export type ManagerLifecycleAction = typeof MANAGER_LIFECYCLE_ACTIONS[number];
export type ManagerTaskAction = typeof MANAGER_TASK_ACTIONS[number];
export type ManagerControlAction = typeof MANAGER_CONTROL_ACTIONS[number];
const MANAGER_ACTIVE_TASK_STATUSES = new Set(["planning", "active", "needs-input", "ready"]);

export interface ManagerTaskCatalogueEntry {
	taskId: string;
	project: string;
	title: string;
	status: string;
}

export interface ManagerProjectCatalogueEntry {
	projectId: string;
}

export type PiManagerControlRequest = { requestId: string } & (
	| { action: ManagerLifecycleAction; taskId: string }
	| { action: "reconcile-pr"; taskId?: string }
	| { action: "ask"; target: string; request: string }
);

export type DiscordManagerControlRequest = PiManagerControlRequest & { channelId: string };

const MANAGER_TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isManagerControlAction(value: unknown): value is ManagerControlAction {
	return typeof value === "string" && (MANAGER_CONTROL_ACTIONS as readonly string[]).includes(value);
}

export function isManagerLifecycleAction(value: unknown): value is ManagerLifecycleAction {
	return typeof value === "string" && (MANAGER_LIFECYCLE_ACTIONS as readonly string[]).includes(value);
}

export function isManagerTaskAction(value: unknown): value is ManagerTaskAction {
	return typeof value === "string" && (MANAGER_TASK_ACTIONS as readonly string[]).includes(value);
}

export function isManagerTaskCatalogue(value: unknown): value is ManagerTaskCatalogueEntry[] {
	if (!Array.isArray(value) || value.length > MAX_MANAGER_TASK_CATALOGUE_ITEMS) return false;
	const taskIds = new Set<string>();
	return value.every((task) => {
		if (!task || typeof task !== "object" || Array.isArray(task)) return false;
		const entry = task as Record<string, unknown>;
		if (typeof entry.taskId !== "string" || taskIds.has(entry.taskId)) return false;
		taskIds.add(entry.taskId);
		return entry.taskId.length <= 100 && MANAGER_TASK_ID.test(entry.taskId) &&
			typeof entry.project === "string" && entry.project.length > 0 && entry.project.length <= 100 &&
			typeof entry.title === "string" && entry.title.length > 0 && entry.title.length <= 200 &&
			typeof entry.status === "string" && entry.status.length > 0 && entry.status.length <= 32;
	});
}

export function isManagerProjectCatalogue(value: unknown): value is ManagerProjectCatalogueEntry[] {
	if (!Array.isArray(value) || value.length > MAX_MANAGER_PROJECT_CATALOGUE_ITEMS) return false;
	const projectIds = new Set<string>();
	return value.every((project) => {
		if (!project || typeof project !== "object" || Array.isArray(project)) return false;
		const entry = project as Record<string, unknown>;
		if (typeof entry.projectId !== "string" || projectIds.has(entry.projectId)) return false;
		projectIds.add(entry.projectId);
		return entry.projectId.length <= 100 && MANAGER_TASK_ID.test(entry.projectId);
	});
}

export function isPiManagerControlRequest(value: unknown): value is PiManagerControlRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const request = value as Record<string, unknown>;
	if (typeof request.requestId !== "string" || request.requestId.length === 0) return false;
	if (request.action === "ask") {
		return typeof request.target === "string" && /^(?:project|task):[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.target) &&
			request.target.length <= 108 && typeof request.request === "string" && request.request.length > 0 &&
			request.request.length <= MAX_SESSION_CONTROL_TEXT_LENGTH;
	}
	if (request.action === "reconcile-pr" && request.taskId === undefined) return true;
	return isManagerTaskAction(request.action) && typeof request.taskId === "string" &&
		request.taskId.length <= 100 && MANAGER_TASK_ID.test(request.taskId);
}

export function managerTaskAutocompleteChoices(
	catalogue: readonly ManagerTaskCatalogueEntry[],
	prefix: string,
): DiscordModelChoice[] {
	const query = prefix.trim().toLocaleLowerCase();
	return catalogue
		.filter((task) => !query || `${task.taskId}\n${task.project}\n${task.title}\n${task.status}`.toLocaleLowerCase().includes(query))
		.slice(0, MAX_MANAGER_TASK_AUTOCOMPLETE_CHOICES)
		.map((task) => ({
			name: truncate(`${task.title} — ${task.project} (@${task.taskId})`, 100),
			value: task.taskId,
		}));
}

function humanizeManagerId(value: string): string {
	return value.split("-").filter(Boolean).map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
}

export function isActiveManagerTask(task: Pick<ManagerTaskCatalogueEntry, "status">): boolean {
	return MANAGER_ACTIVE_TASK_STATUSES.has(task.status);
}

export function managerTargetAutocompleteChoices(
	projects: readonly ManagerProjectCatalogueEntry[],
	tasks: readonly ManagerTaskCatalogueEntry[],
	prefix: string,
): DiscordModelChoice[] {
	const query = prefix.trim().toLocaleLowerCase();
	const choices = [
		...projects.map((project) => ({
			name: `Project — ${humanizeManagerId(project.projectId)} (${project.projectId})`,
			value: `project:${project.projectId}`,
			search: `project ${project.projectId} ${humanizeManagerId(project.projectId)}`,
		})),
		...tasks.filter(isActiveManagerTask).map((task) => ({
			name: `Task — ${task.title} — ${task.project} (@${task.taskId})`,
			value: `task:${task.taskId}`,
			search: `task ${task.taskId} ${task.project} ${task.title} ${task.status}`,
		})),
	];
	return choices
		.filter((choice) => !query || choice.search.toLocaleLowerCase().includes(query) || choice.value.includes(query))
		.slice(0, MAX_MANAGER_TARGET_AUTOCOMPLETE_CHOICES)
		.map((choice) => ({ name: truncate(choice.name, 100), value: choice.value }));
}

export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
	return typeof value === "string" && (PI_THINKING_LEVELS as readonly string[]).includes(value);
}

export function modelChoiceValue(model: Pick<PiModelCatalogueEntry, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function truncate(value: string, maximum: number): string {
	if (value.length <= maximum) return value;
	return `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

export function modelAutocompleteChoices(
	catalogue: readonly PiModelCatalogueEntry[],
	prefix: string,
): DiscordModelChoice[] {
	const query = prefix.trim().toLocaleLowerCase();
	return catalogue
		.filter((model) => {
			const value = modelChoiceValue(model);
			return value.length <= 100 && (!query || `${model.name}\n${value}`.toLocaleLowerCase().includes(query));
		})
		.slice(0, MAX_MODEL_AUTOCOMPLETE_CHOICES)
		.map((model) => {
			const value = modelChoiceValue(model);
			return { name: truncate(model.name === value ? value : `${model.name} (${value})`, 100), value };
		});
}

export function isPiModelCatalogue(value: unknown): value is PiModelCatalogueEntry[] {
	return Array.isArray(value) && value.length <= MAX_MODEL_CATALOGUE_ITEMS && value.every((model) => {
		if (!model || typeof model !== "object" || Array.isArray(model)) return false;
		const entry = model as Record<string, unknown>;
		return typeof entry.provider === "string" && entry.provider.length > 0 && entry.provider.length <= 100 &&
			typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 200 &&
			typeof entry.name === "string" && entry.name.length > 0 && entry.name.length <= 200;
	});
}

export function isPiSessionControlAction(value: unknown): value is PiSessionControlAction {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const action = value as Record<string, unknown>;
	if (action.type === "status" || action.type === "abort") return true;
	if (action.type === "model") {
		return typeof action.provider === "string" && action.provider.length > 0 && action.provider.length <= 100 &&
			typeof action.modelId === "string" && action.modelId.length > 0 && action.modelId.length <= 200;
	}
	if (action.type === "thinking") return isPiThinkingLevel(action.level);
	if (action.type === "steer" || action.type === "followup") {
		return typeof action.text === "string" && action.text.length > 0 && action.text.length <= MAX_SESSION_CONTROL_TEXT_LENGTH;
	}
	return false;
}

export function boundedControlResult(result: PiSessionControlResult): PiSessionControlResult {
	const message = result.message.trim() || (result.ok ? "Done." : "Session control failed.");
	return { ok: result.ok, message: truncate(message, MAX_SESSION_CONTROL_TEXT_LENGTH) };
}
