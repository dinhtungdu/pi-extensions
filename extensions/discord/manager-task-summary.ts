import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
	isManagerTaskCatalogue,
	MAX_MANAGER_TASK_CATALOGUE_ITEMS,
	type ManagerTaskCatalogueEntry,
} from "./controls.js";

const STATUS_TIMEOUT_MS = 2_000;
const STATUS_MAX_BYTES = 1_048_576;
const REFRESH_DEBOUNCE_MS = 100;
export const MAX_PROJECT_SUMMARY_LENGTH = 2_000;

interface ManagerTaskStatus {
	task_id: string;
	title?: string;
	project: string;
	status: string;
	current_action: string;
	current_run: string;
}

interface ManagerStatus {
	ok: true;
	command: "status";
	schema_version: 1;
	summary: {
		tasks: number;
		pending_events: number;
		ready_tasks: number;
		orphan_events: number;
	};
	tasks: ManagerTaskStatus[];
}

export interface ManagerTaskSummaryCallbacks {
	onSummary(summary: string): void;
	onTaskCatalogue?(catalogue: ManagerTaskCatalogueEntry[]): void;
	onError(error: Error): void;
}

export interface ManagerTaskSummaryDependencies {
	readStatus?: (root: string) => Promise<unknown>;
	watchDirectory?: (path: string, listener: () => void) => FSWatcher;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseManagerStatus(value: unknown): ManagerStatus {
	if (!isRecord(value) || value.ok !== true || value.command !== "status" || value.schema_version !== 1 ||
		!isRecord(value.summary) || !Array.isArray(value.tasks)) {
		throw new Error("the-manager status returned an unsupported response");
	}
	for (const key of ["tasks", "pending_events", "ready_tasks", "orphan_events"]) {
		if (typeof value.summary[key] !== "number") throw new Error("the-manager status returned an invalid summary");
	}
	const tasks = value.tasks.map((task) => {
		if (!isRecord(task) || typeof task.task_id !== "string" || typeof task.project !== "string" ||
			typeof task.status !== "string" || typeof task.current_action !== "string" || typeof task.current_run !== "string" ||
			(task.title !== undefined && typeof task.title !== "string")) {
			throw new Error("the-manager status returned an invalid task");
		}
		return {
			task_id: task.task_id,
			...(typeof task.title === "string" ? { title: task.title } : {}),
			project: task.project,
			status: task.status,
			current_action: task.current_action,
			current_run: task.current_run,
		};
	});
	return {
		ok: true,
		command: "status",
		schema_version: 1,
		summary: value.summary as ManagerStatus["summary"],
		tasks,
	};
}

function compact(value: string, maximum = 80): string {
	const safe = value.replaceAll("@", "@\u200b").replaceAll(/[\r\n\t]+/g, " ").trim();
	return safe.length <= maximum ? safe : `${safe.slice(0, maximum - 1)}…`;
}

const MARKDOWN_CHARACTERS = new Set("\\`*_{}[]()~|>");
const HUMANIZED_NAMES: Record<string, string> = {
	api: "API",
	cli: "CLI",
	github: "GitHub",
	id: "ID",
	pi: "Pi",
	pr: "PR",
	ui: "UI",
	ux: "UX",
	wc: "WC",
	woocommerce: "WooCommerce",
	wordpress: "WordPress",
};

function humanizeIdentifier(value: string): string {
	const identifier = compact(value, 120);
	const known = HUMANIZED_NAMES[identifier.toLowerCase()];
	if (known) return known;
	return identifier
		.split(/[-_./]+/)
		.filter(Boolean)
		.map((word) => HUMANIZED_NAMES[word.toLowerCase()] ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
		.join(" ") || "Unknown";
}

function markdownText(value: string, maximum: number): string {
	return [...compact(value, maximum)].map((character) => MARKDOWN_CHARACTERS.has(character) ? `\\${character}` : character).join("");
}

function normalizedStatus(value: string): string {
	return compact(value, 32).toLowerCase() || "other";
}

function statusIcon(status: string): string {
	if (status === "active") return "🟡";
	if (status === "ready") return "✅";
	if (status === "planning") return "⚪";
	if (status === "blocked") return "⛔";
	if (status === "paused") return "⏸️";
	return "🔹";
}

function activeTaskDetail(task: ManagerTaskStatus): string | undefined {
	const action = compact(task.current_action, 40).replaceAll("`", "'");
	const runOrdinal = /(?:^|[-_])(\d+)$/.exec(task.current_run)?.[1];
	const parts = [action && action !== "none" ? action : undefined, runOrdinal ? `run ${runOrdinal}` : undefined]
		.filter((part): part is string => Boolean(part));
	return parts.length ? `  \`${parts.join(" · ")}\`` : undefined;
}

function taskLines(task: ManagerTaskStatus, status: string): string[] {
	const project = markdownText(humanizeIdentifier(task.project), 64);
	const rawTitle = task.title?.trim() || humanizeIdentifier(task.task_id);
	const lines = [`${statusIcon(status)} **${project}** — ${markdownText(rawTitle, 180)}`];
	if (status === "active") {
		const detail = activeTaskDetail(task);
		if (detail) lines.push(detail);
	}
	return lines;
}

function sectionLabel(status: string): string {
	return humanizeIdentifier(status);
}

export function managerTaskCatalogue(value: unknown): ManagerTaskCatalogueEntry[] {
	const status = parseManagerStatus(value);
	const catalogueText = (text: string, maximum: number) => {
		const normalized = text.replaceAll(/[\r\n\t]+/g, " ").trim();
		return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
	};
	const catalogue = status.tasks.slice(0, MAX_MANAGER_TASK_CATALOGUE_ITEMS).map((task) => ({
		taskId: task.task_id,
		project: catalogueText(task.project, 100),
		title: catalogueText(task.title?.trim() || humanizeIdentifier(task.task_id), 200),
		status: catalogueText(task.status, 32),
	}));
	if (!isManagerTaskCatalogue(catalogue)) throw new Error("the-manager status returned an invalid task catalogue");
	return catalogue;
}

export function formatManagerTaskSummary(value: unknown): string {
	const status = parseManagerStatus(value);
	const groups = new Map<string, ManagerTaskStatus[]>();
	for (const task of status.tasks) {
		const key = normalizedStatus(task.status);
		const group = groups.get(key) ?? [];
		group.push(task);
		groups.set(key, group);
	}
	const orderedStatuses = ["active", "ready", ...[...groups.keys()].filter((key) => key !== "active" && key !== "ready")]
		.filter((key) => groups.has(key));
	const orderedTasks = orderedStatuses.flatMap((key) => groups.get(key)!.map((task) => ({ status: key, task })));
	const activeCount = groups.get("active")?.length ?? 0;
	const readyCount = groups.get("ready")?.length ?? 0;
	const lines = [`📋 **Tasks** · ${status.summary.tasks} total · ${activeCount} active · ${readyCount} ready`];
	let renderedTasks = 0;
	let previousStatus: string | undefined;

	for (const entry of orderedTasks) {
		const section = entry.status === previousStatus ? [] : ["", `**${markdownText(sectionLabel(entry.status), 40)}**`];
		const renderedLines = taskLines(entry.task, entry.status);
		const candidate = [...lines, ...section, ...renderedLines];
		const remainingAfter = orderedTasks.length - renderedTasks - 1;
		const reserve = remainingAfter > 0 ? `… ${remainingAfter} more tasks` : undefined;
		if ([...candidate, ...(reserve ? [reserve] : [])].join("\n").length > MAX_PROJECT_SUMMARY_LENGTH) {
			const omitted = `… ${orderedTasks.length - renderedTasks} more tasks`;
			if ([...lines, omitted].join("\n").length <= MAX_PROJECT_SUMMARY_LENGTH) lines.push(omitted);
			break;
		}
		lines.push(...section, ...renderedLines);
		previousStatus = entry.status;
		renderedTasks++;
	}
	return lines.join("\n");
}

async function defaultReadStatus(root: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			[join(root, "bin", "manager.mjs"), "status", "--root", root],
			{ cwd: root, encoding: "utf8", maxBuffer: STATUS_MAX_BYTES, timeout: STATUS_TIMEOUT_MS, windowsHide: true },
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(`Cannot read the-manager task status: ${stderr.trim() || error.message}`));
					return;
				}
				try {
					resolve(JSON.parse(stdout) as unknown);
				} catch (parseError) {
					reject(new Error(`Cannot parse the-manager task status: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
				}
			},
		);
	});
}

async function isDirectory(path: string): Promise<boolean> {
	return stat(path).then((entry) => entry.isDirectory(), () => false);
}

async function isFile(path: string): Promise<boolean> {
	return stat(path).then((entry) => entry.isFile(), () => false);
}

export class ManagerTaskSummaryProducer {
	private readonly watchers: FSWatcher[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private refreshing = false;
	private refreshRequested = false;
	private stopped = true;

	private constructor(
		private readonly root: string,
		private readonly callbacks: ManagerTaskSummaryCallbacks,
		private readonly dependencies: Required<ManagerTaskSummaryDependencies>,
	) {}

	static async create(
		root: string,
		callbacks: ManagerTaskSummaryCallbacks,
		dependencies: ManagerTaskSummaryDependencies = {},
	): Promise<ManagerTaskSummaryProducer | undefined> {
		const tasks = join(root, "data", "tasks");
		if (!await isFile(join(root, "bin", "manager.mjs")) || !await isDirectory(tasks)) return undefined;
		return new ManagerTaskSummaryProducer(root, callbacks, {
			readStatus: dependencies.readStatus ?? defaultReadStatus,
			watchDirectory: dependencies.watchDirectory ?? ((path, listener) => watch(path, listener)),
		});
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		for (const directory of [join(this.root, "data", "tasks"), join(this.root, ".manager", "events")]) {
			try {
				const watcher = this.dependencies.watchDirectory(directory, () => this.requestRefresh());
				watcher.on("error", (error) => this.callbacks.onError(error));
				this.watchers.push(watcher);
			} catch (error) {
				if (directory.endsWith(join(".manager", "events"))) continue;
				this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
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
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.refresh();
		}, delay);
		this.timer.unref();
	}

	private async refresh(): Promise<void> {
		if (this.refreshing) {
			this.refreshRequested = true;
			return;
		}
		this.refreshing = true;
		try {
			do {
				this.refreshRequested = false;
				try {
					const status = await this.dependencies.readStatus(this.root);
					const summary = formatManagerTaskSummary(status);
					const catalogue = managerTaskCatalogue(status);
					if (!this.stopped) {
						this.callbacks.onSummary(summary);
						this.callbacks.onTaskCatalogue?.(catalogue);
					}
				} catch (error) {
					if (!this.stopped) this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
				}
			} while (!this.stopped && this.refreshRequested);
		} finally {
			this.refreshing = false;
		}
	}
}
