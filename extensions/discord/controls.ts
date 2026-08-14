export const MAX_MODEL_CATALOGUE_ITEMS = 500;
export const MAX_MODEL_AUTOCOMPLETE_CHOICES = 25;
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
