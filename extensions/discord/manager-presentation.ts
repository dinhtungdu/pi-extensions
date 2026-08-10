import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
const RENDER_TIMEOUT_MS = 2_000, MAX_OUTPUT_BYTES = 1_048_576, REFRESH_DEBOUNCE_MS = 100;
export const MAX_MANAGER_PRESENTATION_CONTENT = 2_000, MANAGER_PRESENTATION_SCHEMA_VERSION = 1;
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
export interface ManagerPresentation {
	schemaVersion: 1; revision: string; content: string; controls: ManagerPresentationControl[]; degraded: boolean; warnings: string[]
}
export interface ManagerPresentationCallbacks { onPresentation(presentation: ManagerPresentation): void; onUnavailable(error: Error): void }
export interface ManagerPresentationDependencies {
	render?: (root: string) => Promise<unknown>; watchDirectory?: (path: string, listener: () => void) => FSWatcher
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function isManagerPresentation(value: unknown): value is ManagerPresentation {
	if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision) ||
		typeof value.content !== "string" || value.content.length < 1 || value.content.length > MAX_MANAGER_PRESENTATION_CONTENT ||
		!Array.isArray(value.controls) || value.controls.length > 25 || typeof value.degraded !== "boolean" ||
		!Array.isArray(value.warnings) || value.warnings.length > 20 ||
		!value.warnings.every((warning) => typeof warning === "string" && warning.length <= 500)) return false;
	const ids = new Set<string>();
	return value.controls.every((control) => {
		if (!isRecord(control) || typeof control.id !== "string" || typeof control.command !== "string" ||
			!isSupportedManagerPresentationControl(control.id, control.command) || typeof control.label !== "string" ||
			control.label.length < 1 || control.label.length > 80 || typeof control.style !== "string" ||
			!(MANAGER_PRESENTATION_STYLES as readonly string[]).includes(control.style) || ids.has(control.id)) return false;
		ids.add(control.id);
		return true;
	});
}
export function parseManagerPresentationEnvelope(value: unknown): ManagerPresentation {
	if (!isRecord(value) || value.ok !== true || value.command !== "summary-render" || value.schema_version !== 1) {
		throw new Error("the-manager summary-render returned an unsupported response");
	}
	const presentation = {
		schemaVersion: 1 as const, revision: value.revision, content: value.content, controls: value.controls,
		degraded: value.degraded, warnings: value.warnings,
	};
	if (!isManagerPresentation(presentation)) throw new Error("the-manager summary-render returned an invalid presentation");
	return structuredClone(presentation);
}
async function defaultRender(root: string): Promise<unknown> {
	return new Promise((resolveResult, reject) => execFile(
		process.execPath,
		[join(root, "bin", "manager.mjs"), "summary-render", "--root", root, "--max-chars", "2000"],
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
	private readonly watchers: FSWatcher[] = [];
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
			try {
				const watcher = this.dependencies.watchDirectory(directory, () => this.requestRefresh());
				watcher.on("error", (error) => this.callbacks.onUnavailable(error));
				this.watchers.push(watcher);
			} catch (error) { this.callbacks.onUnavailable(error instanceof Error ? error : new Error(String(error))); }
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
