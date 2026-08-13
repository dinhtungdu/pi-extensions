import { execFile } from "node:child_process";
import { unwatchFile, watch, watchFile, type FSWatcher } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
const RENDER_TIMEOUT_MS = 2_000, MAX_OUTPUT_BYTES = 1_048_576, REFRESH_DEBOUNCE_MS = 100;
export const MAX_MANAGER_PRESENTATION_CONTENT = 10_000, MANAGER_PRESENTATION_SCHEMA_VERSION = 1;
export const MANAGER_PRESENTATION_CONTROL_COMMANDS = {
	"github-refresh-reconcile": "github-refresh-reconcile",
} as const;
export const SUPPORTED_MANAGER_PRESENTATION_CONTROLS = Object.freeze(Object.keys(MANAGER_PRESENTATION_CONTROL_COMMANDS));
export function isSupportedManagerPresentationControl(id: unknown, command: unknown): boolean {
	return typeof id === "string" && typeof command === "string" &&
		MANAGER_PRESENTATION_CONTROL_COMMANDS[id as keyof typeof MANAGER_PRESENTATION_CONTROL_COMMANDS] === command;
}
export const MANAGER_PRESENTATION_STYLES = ["primary", "secondary", "success", "danger"] as const;
export type ManagerPresentationStyle = typeof MANAGER_PRESENTATION_STYLES[number];
export interface ManagerPresentationControl { id: string; label: string; style: ManagerPresentationStyle; command: string }
export interface ManagerPresentationActionControl extends ManagerPresentationControl {
	command: "task-merge-and-archive";
	taskId: string;
	after: number;
}
export interface ManagerPresentation {
	schemaVersion: 1;
	revision: string;
	content: string;
	controls: ManagerPresentationControl[];
	actionControls?: ManagerPresentationActionControl[];
	degraded: boolean;
	warnings: string[];
}
export interface ManagerPresentationCallbacks { onPresentation(presentation: ManagerPresentation): void; onUnavailable(error: Error): void }
interface WatchHandle { close(): void }
export interface ManagerPresentationDependencies {
	render?: (root: string) => Promise<unknown>; watchDirectory?: (path: string, listener: () => void) => FSWatcher
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
function isControlShape(value: unknown): value is ManagerPresentationControl {
	return isRecord(value) && typeof value.id === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value.id) &&
		typeof value.label === "string" && value.label.length >= 1 && value.label.length <= 80 &&
		typeof value.style === "string" && (MANAGER_PRESENTATION_STYLES as readonly string[]).includes(value.style);
}
export function isManagerPresentationActionControl(value: unknown, contentLength?: number): value is ManagerPresentationActionControl {
	if (!isControlShape(value)) return false;
	const action = value as unknown as Record<string, unknown>;
	if (!hasExactKeys(action, ["id", "label", "style", "command", "taskId", "after"])) return false;
	return action.command === "task-merge-and-archive" &&
		typeof action.taskId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(action.taskId) &&
		Number.isSafeInteger(action.after) && Number(action.after) > 0 &&
		(contentLength === undefined || Number(action.after) <= contentLength);
}
function isSplitSurrogateOffset(after: number, content: string | undefined): boolean {
	if (content === undefined || after <= 0 || after >= content.length) return false;
	const left = content.charCodeAt(after - 1), right = content.charCodeAt(after);
	return left >= 0xD800 && left <= 0xDBFF && right >= 0xDC00 && right <= 0xDFFF;
}
export function isManagerPresentation(value: unknown): value is ManagerPresentation {
	if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision) ||
		typeof value.content !== "string" || value.content.length < 1 || value.content.length > MAX_MANAGER_PRESENTATION_CONTENT ||
		!Array.isArray(value.controls) || value.controls.length > 25 ||
		(value.actionControls !== undefined && !Array.isArray(value.actionControls)) ||
		(Array.isArray(value.actionControls) && value.actionControls.length > 9) || typeof value.degraded !== "boolean" ||
		!Array.isArray(value.warnings) || value.warnings.length > 20 ||
		!value.warnings.every((warning) => typeof warning === "string" && warning.length <= 500)) return false;
	const ids = new Set<string>();
	for (const control of value.controls) {
		if (!isControlShape(control) || !isSupportedManagerPresentationControl(control.id, control.command) || ids.has(control.id)) return false;
		ids.add(control.id);
	}
	let previousAfter = 0;
	const taskIds = new Set<string>();
	for (const action of value.actionControls ?? []) {
		if (!isManagerPresentationActionControl(action, value.content.length) || isSplitSurrogateOffset(action.after, value.content) ||
			ids.has(action.id) || taskIds.has(action.taskId) || action.after <= previousAfter) return false;
		ids.add(action.id);
		taskIds.add(action.taskId);
		previousAfter = action.after;
	}
	return true;
}

function isLegacyConfirmation(value: unknown): boolean {
	if (!isRecord(value) || !hasExactKeys(value, ["title", "body", "confirmLabel"])) return false;
	return typeof value.title === "string" && value.title.length >= 1 && value.title.length <= 100 &&
		typeof value.body === "string" && value.body.length >= 1 && value.body.length <= 1_500 &&
		typeof value.confirmLabel === "string" && value.confirmLabel.length >= 1 && value.confirmLabel.length <= 80 &&
		![value.title, value.body, value.confirmLabel].some((text) => text.includes("\0"));
}

export function normalizePersistedManagerPresentation(value: unknown): ManagerPresentation | undefined {
	if (isManagerPresentation(value)) return structuredClone(value);
	if (!isRecord(value) || !Array.isArray(value.actionControls)) return undefined;
	const actionControls = value.actionControls.map((raw) => {
		if (!isRecord(raw) || !hasExactKeys(raw, ["id", "label", "style", "command", "taskId", "after", "confirmation"]) ||
			!isLegacyConfirmation(raw.confirmation)) return undefined;
		const action = {
			id: raw.id,
			label: raw.label,
			style: raw.style,
			command: raw.command,
			taskId: raw.taskId,
			after: raw.after,
		};
		return isManagerPresentationActionControl(action) ? action : undefined;
	});
	if (actionControls.some((action) => action === undefined)) return undefined;
	const normalized = { ...value, actionControls };
	return isManagerPresentation(normalized) ? structuredClone(normalized) : undefined;
}
function parseActionControl(value: unknown): ManagerPresentationActionControl | undefined {
	if (!isRecord(value) || !hasExactKeys(value, ["id", "label", "style", "command", "task_id", "after"])) return undefined;
	const action: ManagerPresentationActionControl = {
		id: value.id as string,
		label: value.label as string,
		style: value.style as ManagerPresentationStyle,
		command: value.command as "task-merge-and-archive",
		taskId: value.task_id as string,
		after: value.after as number,
	};
	return isManagerPresentationActionControl(action) ? action : undefined;
}
export function parseManagerPresentationEnvelope(value: unknown): ManagerPresentation {
	if (!isRecord(value) || value.ok !== true || value.command !== "summary-render" || value.schema_version !== 1) {
		throw new Error("the-manager summary-render returned an unsupported response");
	}
	const rawActions = value.action_controls ?? [];
	if (!Array.isArray(rawActions)) throw new Error("the-manager summary-render returned an invalid presentation");
	const actionControls = rawActions.map(parseActionControl);
	if (actionControls.some((action) => action === undefined)) {
		throw new Error("the-manager summary-render returned an invalid presentation");
	}
	const presentation: ManagerPresentation = {
		schemaVersion: 1,
		revision: value.revision as string,
		content: value.content as string,
		controls: value.controls as ManagerPresentationControl[],
		...(value.action_controls !== undefined ? { actionControls: actionControls as ManagerPresentationActionControl[] } : {}),
		degraded: value.degraded as boolean,
		warnings: value.warnings as string[],
	};
	if (!isManagerPresentation(presentation)) throw new Error("the-manager summary-render returned an invalid presentation");
	return structuredClone(presentation);
}
async function defaultRender(root: string): Promise<unknown> {
	return new Promise((resolveResult, reject) => execFile(
		process.execPath,
		[join(root, "bin", "manager.mjs"), "summary-render", "--root", root, "--max-chars", String(MAX_MANAGER_PRESENTATION_CONTENT)],
		{ cwd: root, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, timeout: RENDER_TIMEOUT_MS, windowsHide: true },
		(error, stdout, stderr) => {
			if (error) return reject(new Error(`Cannot render the-manager presentation: ${stderr.trim() || error.message}`));
			try { resolveResult(JSON.parse(stdout) as unknown); }
			catch (parseError) {
				reject(new Error(`Cannot parse the-manager presentation: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
			}
		},
	));
}
async function pathHasType(path: string, type: "file" | "directory"): Promise<boolean> {
	return stat(path).then((entry) => type === "file" ? entry.isFile() : entry.isDirectory(), () => false);
}
export class ManagerPresentationProducer {
	private readonly watchers: WatchHandle[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private refreshing = false; private refreshRequested = false; private stopped = true;
	private constructor(
		readonly root: string,
		private readonly callbacks: ManagerPresentationCallbacks,
		private readonly dependencies: Required<ManagerPresentationDependencies>,
	) {}
	static async create(root: string, callbacks: ManagerPresentationCallbacks, dependencies: ManagerPresentationDependencies = {}) {
		const canonicalRoot = await realpath(root).catch(() => undefined);
		if (!canonicalRoot || !await pathHasType(join(canonicalRoot, "bin", "manager.mjs"), "file") ||
			!await pathHasType(join(canonicalRoot, "data", "tasks"), "directory")) return undefined;
		return new ManagerPresentationProducer(canonicalRoot, callbacks, {
			render: dependencies.render ?? defaultRender,
			watchDirectory: dependencies.watchDirectory ?? ((path, listener) => watch(path, listener)),
		});
	}
	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		for (const directory of [join(this.root, "data", "tasks"), join(this.root, "data")]) {
			const listener = () => this.requestRefresh();
			try {
				const watcher = this.dependencies.watchDirectory(directory, listener);
				watcher.on("error", (error) => this.callbacks.onUnavailable(error));
				this.watchers.push(watcher);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
					try {
						watchFile(directory, { interval: 250, persistent: false }, listener);
						this.watchers.push({ close: () => unwatchFile(directory, listener) });
					} catch (pollError) {
						this.callbacks.onUnavailable(pollError instanceof Error ? pollError : new Error(String(pollError)));
					}
				} else this.callbacks.onUnavailable(error instanceof Error ? error : new Error(String(error)));
			}
		}
		this.requestRefresh(0);
	}
	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const watcher of this.watchers) watcher.close();
		this.watchers.length = 0;
	}
	requestRefresh(delay = REFRESH_DEBOUNCE_MS): void {
		if (this.stopped) return;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, delay);
		this.timer.unref();
	}
	async renderCurrent(): Promise<ManagerPresentation> {
		return parseManagerPresentationEnvelope(await this.dependencies.render(this.root));
	}
	private async refresh(): Promise<void> {
		if (this.refreshing) { this.refreshRequested = true; return; }
		this.refreshing = true;
		try {
			do {
				this.refreshRequested = false;
				try {
					const presentation = await this.renderCurrent();
					if (!this.stopped) this.callbacks.onPresentation(presentation);
				} catch (error) {
					if (!this.stopped) this.callbacks.onUnavailable(error instanceof Error ? error : new Error(String(error)));
				}
			} while (!this.stopped && this.refreshRequested);
		} finally { this.refreshing = false; }
	}
}
