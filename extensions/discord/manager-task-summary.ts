import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

const STATUS_TIMEOUT_MS = 2_000;
const STATUS_MAX_BYTES = 1_048_576;
const REFRESH_DEBOUNCE_MS = 100;
export const MAX_PROJECT_SUMMARY_LENGTH = 2_000;

interface ManagerTaskStatus {
	task_id: string;
	project: string;
	status: string;
	current_run: string;
	pending_events: unknown[];
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
			typeof task.status !== "string" || typeof task.current_run !== "string" || !Array.isArray(task.pending_events)) {
			throw new Error("the-manager status returned an invalid task");
		}
		return {
			task_id: task.task_id,
			project: task.project,
			status: task.status,
			current_run: task.current_run,
			pending_events: task.pending_events,
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

export function formatManagerTaskSummary(value: unknown): string {
	const status = parseManagerStatus(value);
	const { summary } = status;
	const header = summary.tasks === 0
		? "📋 the-manager · no active tasks"
		: `📋 the-manager · ${summary.tasks} tasks · ${summary.ready_tasks} ready · ${summary.pending_events} pending`;
	const lines = [header];
	for (let index = 0; index < status.tasks.length; index++) {
		const task = status.tasks[index]!;
		const events = task.pending_events.length ? ` · ${task.pending_events.length} events` : "";
		const run = task.current_run && task.current_run !== "none" ? ` · ${compact(task.current_run, 48)}` : "";
		const line = `• ${compact(task.project, 48)}/${compact(task.task_id)} · ${compact(task.status, 24)}${run}${events}`;
		const remaining = status.tasks.length - index;
		const omitted = `… ${remaining} more`;
		if ([...lines, line].join("\n").length > MAX_PROJECT_SUMMARY_LENGTH) {
			if ([...lines, omitted].join("\n").length <= MAX_PROJECT_SUMMARY_LENGTH) lines.push(omitted);
			break;
		}
		lines.push(line);
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
					const summary = formatManagerTaskSummary(await this.dependencies.readStatus(this.root));
					if (!this.stopped) this.callbacks.onSummary(summary);
				} catch (error) {
					if (!this.stopped) this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
				}
			} while (!this.stopped && this.refreshRequested);
		} finally {
			this.refreshing = false;
		}
	}
}
