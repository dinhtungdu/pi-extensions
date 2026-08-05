import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	boundedControlResult,
	isActiveManagerTask,
	type ManagerProjectCatalogueEntry,
	type ManagerTaskCatalogueEntry,
	type PiManagerControlRequest,
	type PiSessionControlResult,
} from "./controls.js";
import { managerProjectCatalogue, managerTaskCatalogue } from "./manager-task-summary.js";

const STATUS_TIMEOUT_MS = 2_000;
const VALIDATE_TIMEOUT_MS = 30_000;
export const MANAGER_CONTROL_PROCESS_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_RECONCILE_BATCH_TASKS = 50;
const MAX_FAILED_TASK_IDS = 10;
const HERDR_LOCATOR = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const MANAGER_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ManagerProcessResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ManagerControlDependencies {
	run?: (executable: string, args: string[], options: { cwd: string; timeout: number; signal?: AbortSignal }) => Promise<ManagerProcessResult>;
	environment?: NodeJS.ProcessEnv;
}

async function isFile(path: string): Promise<boolean> {
	return stat(path).then((entry) => entry.isFile(), () => false);
}

function defaultRun(
	executable: string,
	args: string[],
	options: { cwd: string; timeout: number; signal?: AbortSignal },
): Promise<ManagerProcessResult> {
	return new Promise((resolveResult) => {
		execFile(executable, args, {
			cwd: options.cwd,
			encoding: "utf8",
			maxBuffer: MAX_OUTPUT_BYTES,
			timeout: options.timeout,
			windowsHide: true,
			signal: options.signal,
		}, (error, stdout, stderr) => {
			resolveResult({
				code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
				stdout,
				stderr: stderr || error?.message || "",
			});
		});
	});
}

function parseJson(stdout: string, description: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		throw new Error(`${description} returned malformed JSON.`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${description} returned malformed JSON.`);
	}
	return value as Record<string, unknown>;
}

function failureMessage(result: ManagerProcessResult, fallback: string): string {
	return (result.stderr.trim() || fallback).slice(0, 2_000);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function isPullRequestNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isReconcilePullRequestSuccess(output: Record<string, unknown>, taskId: string): boolean {
	if (output.ok !== true || output.command !== "task-reconcile-pr" || output.task_id !== taskId) return false;
	const baseKeys = ["ok", "command", "task_id", "state", "archived"] as const;
	if (output.state === "not-found") return output.archived === false && hasExactKeys(output, baseKeys);
	if (output.state === "open" || output.state === "closed") {
		return output.archived === false && typeof output.url === "string" && output.url.length > 0 &&
			isPullRequestNumber(output.number) && hasExactKeys(output, [...baseKeys, "url", "number"]);
	}
	if (output.state !== "merged" || output.archived !== true) return false;
	return typeof output.url === "string" && output.url.length > 0 && isPullRequestNumber(output.number) &&
		typeof output.merged_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(output.merged_at) &&
		typeof output.merge_commit === "string" && /^[a-f0-9]{40,64}$/i.test(output.merge_commit) &&
		(output.checkout_mode === undefined || typeof output.checkout_mode === "string" && output.checkout_mode.length > 0) &&
		(output.slot_state === undefined || output.slot_state === null || typeof output.slot_state === "string") &&
		(output.replay === undefined || typeof output.replay === "boolean") &&
		hasOnlyKeys(output, [...baseKeys, "url", "number", "merged_at", "merge_commit", "checkout_mode", "slot_state", "replay"]);
}

interface ReconcilePullRequestBatchSuccess extends Record<string, unknown> {
	ok: true;
	command: "task-reconcile-pr";
	scope: "all";
	scanned: number;
	results: Array<Record<string, unknown>>;
	summary: { merged: number; open: number; closed: number; not_found: number; failed: number };
}

function isReconcilePullRequestBatchSuccess(output: Record<string, unknown>): output is ReconcilePullRequestBatchSuccess {
	if (output.ok !== true || output.command !== "task-reconcile-pr" || output.scope !== "all" ||
		!Number.isSafeInteger(output.scanned) || (output.scanned as number) < 0 ||
		(output.scanned as number) > MAX_RECONCILE_BATCH_TASKS || !Array.isArray(output.results) ||
		output.results.length !== output.scanned || !hasExactKeys(output, ["ok", "command", "scope", "scanned", "results", "summary"])) {
		return false;
	}
	if (!output.summary || typeof output.summary !== "object" || Array.isArray(output.summary)) return false;
	const summary = output.summary as Record<string, unknown>;
	const summaryKeys = ["merged", "open", "closed", "not_found", "failed"] as const;
	if (!hasExactKeys(summary, summaryKeys) || summaryKeys.some((key) =>
		!Number.isSafeInteger(summary[key]) || (summary[key] as number) < 0 || (summary[key] as number) > MAX_RECONCILE_BATCH_TASKS)) {
		return false;
	}
	const taskIds = new Set<string>();
	const counts = { merged: 0, open: 0, closed: 0, not_found: 0, failed: 0 };
	for (const value of output.results) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const result = value as Record<string, unknown>;
		if ("ok" in result || "command" in result || typeof result.task_id !== "string" ||
			!MANAGER_TASK_ID.test(result.task_id) || taskIds.has(result.task_id)) return false;
		taskIds.add(result.task_id);
		if (result.state === "error") {
			if (result.archived !== false || typeof result.error !== "string" || result.error.length === 0 || result.error.length > 500 ||
				!hasExactKeys(result, ["task_id", "state", "archived", "error"])) return false;
			counts.failed++;
			continue;
		}
		if (!isReconcilePullRequestSuccess({ ok: true, command: "task-reconcile-pr", ...result }, result.task_id)) return false;
		if (result.state === "merged" || result.state === "open" || result.state === "closed") counts[result.state]++;
		else if (result.state === "not-found") counts.not_found++;
		else return false;
	}
	return summary.merged === counts.merged && summary.open === counts.open && summary.closed === counts.closed &&
		summary.not_found === counts.not_found && summary.failed === counts.failed;
}

function formatReconcilePullRequestBatch(output: ReconcilePullRequestBatchSuccess): string {
	const summary = output.summary;
	let message = `Reconciled ${output.scanned} tasks: ${summary.merged} merged, ${summary.open} open, ${summary.closed} closed, ` +
		`${summary.not_found} not found, ${summary.failed} failed.`;
	const failedTaskIds = output.results.filter((result) => result.state === "error").map((result) => result.task_id as string);
	if (failedTaskIds.length > 0) {
		const shown = failedTaskIds.slice(0, MAX_FAILED_TASK_IDS).map((taskId) => `@${taskId}`).join(", ");
		const hidden = failedTaskIds.length - MAX_FAILED_TASK_IDS;
		message += ` Failed: ${shown}${hidden > 0 ? `, … ${hidden} more` : ""}.`;
	}
	return message;
}

function isProtectedManagerEnvironment(environment: NodeJS.ProcessEnv): boolean {
	return environment.HERDR_ENV === "1" && environment.THE_MANAGER_ROLE !== "worker" &&
		typeof environment.HERDR_WORKSPACE_ID === "string" && HERDR_LOCATOR.test(environment.HERDR_WORKSPACE_ID) &&
		typeof environment.HERDR_PANE_ID === "string" && HERDR_LOCATOR.test(environment.HERDR_PANE_ID) &&
		typeof environment.HERDR_SOCKET_PATH === "string" && !environment.HERDR_SOCKET_PATH.includes("\0") &&
		isAbsolute(environment.HERDR_SOCKET_PATH);
}

export class ManagerControlExecutor {
	private constructor(
		private readonly root: string,
		private readonly run: NonNullable<ManagerControlDependencies["run"]>,
	) {}

	static async create(
		root: string,
		dependencies: ManagerControlDependencies = {},
	): Promise<ManagerControlExecutor | undefined> {
		if (!isProtectedManagerEnvironment(dependencies.environment ?? process.env)) return undefined;
		const canonicalRoot = resolve(root);
		const manager = join(canonicalRoot, "bin", "manager.mjs");
		const runtime = join(canonicalRoot, "bin", "manager-runtime.mjs");
		if (!await isFile(manager) || !await isFile(runtime) || !await isFile(join(canonicalRoot, "data", "PROJECTS.md"))) {
			return undefined;
		}
		const executor = new ManagerControlExecutor(canonicalRoot, dependencies.run ?? defaultRun);
		await executor.validateRuntime();
		return executor;
	}

	async executePresentationControl(command: string, signal?: AbortSignal): Promise<PiSessionControlResult> {
		if (command !== "github-status-refresh") return { ok: false, message: "Unsupported manager presentation control." };
		try {
			await this.validateRuntime(signal);
			if (signal?.aborted) return { ok: false, message: "Manager presentation control was aborted." };
			const manager = join(this.root, "bin", "manager.mjs");
			const result = await this.run(process.execPath, [manager, command, "--root", this.root], {
				cwd: this.root,
				timeout: MANAGER_CONTROL_PROCESS_TIMEOUT_MS,
				signal,
			});
			if (signal?.aborted) return { ok: false, message: "Manager presentation control was aborted." };
			if (result.code !== 0) {
				return boundedControlResult({ ok: false, message: failureMessage(result, `Manager control failed with exit ${result.code}.`) });
			}
			return { ok: true, message: "Manager control completed." };
		} catch (error) {
			return boundedControlResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
		}
	}

	async execute(
		request: PiManagerControlRequest,
		tasks: readonly ManagerTaskCatalogueEntry[],
		projects: readonly ManagerProjectCatalogueEntry[] = [],
		deliverAsk?: (message: string) => void | Promise<void>,
	): Promise<PiSessionControlResult> {
		if (request.action === "ask") return this.executeAsk(request, tasks, projects, deliverAsk);
		const tasklessReconcile = request.action === "reconcile-pr" && request.taskId === undefined;
		const task = tasklessReconcile ? undefined : tasks.find((candidate) => candidate.taskId === request.taskId);
		if (!tasklessReconcile && !task) {
			return { ok: false, message: "Select a task from this manager session's current autocomplete catalogue." };
		}
		try {
			await this.validateRuntime();
			const manager = join(this.root, "bin", "manager.mjs");
			const taskPath = task ? join(this.root, "data", "tasks", `${task.taskId}.md`) : undefined;
			let args: string[];
			if (request.action === "reconcile-pr") {
				args = [manager, "task-reconcile-pr", "--root", this.root, ...(taskPath ? ["--task", taskPath] : [])];
			} else {
				if (!task || !taskPath) return { ok: false, message: "The selected task is no longer available." };
				args = request.action === "archive"
					? [manager, "task-archive", "--root", this.root, "--task", taskPath, "--activity-clear", "yes",
						"--evidence", `User explicitly archived ${task.project} task ${task.taskId} without merging via Discord /m command.`,
						"--completion-authorized", "yes"]
					: request.action === "merge-and-archive"
						? [manager, "task-merge-and-archive", "--root", this.root, "--task", taskPath, "--activity-clear", "yes",
							"--evidence", `User explicitly merged ${task.project} task ${task.taskId} locally and archived it via Discord /m command.`]
						: [manager, request.action === "handoff" ? "handoff-start" : "handoff-return",
							"--root", this.root, "--task", taskPath];
			}
			const result = await this.run(process.execPath, args, { cwd: this.root, timeout: MANAGER_CONTROL_PROCESS_TIMEOUT_MS });
			if (result.code !== 0) return boundedControlResult({ ok: false, message: failureMessage(result, `${request.action} failed with exit ${result.code}.`) });
			const output = parseJson(result.stdout, request.action);
			if (request.action === "reconcile-pr") {
				if (tasklessReconcile) {
					if (!isReconcilePullRequestBatchSuccess(output)) {
						return { ok: false, message: "reconcile-pr returned conflicting manager output." };
					}
					return { ok: true, message: formatReconcilePullRequestBatch(output) };
				}
				if (!task || !isReconcilePullRequestSuccess(output, task.taskId)) {
					return { ok: false, message: "reconcile-pr returned conflicting manager output." };
				}
				const message = output.state === "merged" ? `PR #${output.number} merged; @${task.taskId} archived without local merge.`
					: output.state === "not-found" ? `No pull request found for @${task.taskId}.`
						: `PR #${output.number} is ${output.state}: ${output.url}`;
				return { ok: true, message };
			}
			if (!task) return { ok: false, message: `${request.action} returned conflicting manager output.` };
			const expectedCommand = request.action === "handoff" ? "handoff-start"
				: request.action === "takeback" ? "handoff-return"
					: request.action === "archive" ? "task-archive" : "task-merge-and-archive";
			const validState = request.action === "handoff" ? output.state === "direct" && typeof output.worker_session === "string"
				: request.action === "takeback" ? output.state === "return-requested" && typeof output.worker_session === "string"
					: output.archived === true && typeof output.checkout_mode === "string" &&
						(output.slot_state === null || typeof output.slot_state === "string");
			if (output.ok !== true || output.command !== expectedCommand || output.task_id !== task.taskId ||
				typeof output.replay !== "boolean" || !validState) {
				return { ok: false, message: `${request.action} returned conflicting manager output.` };
			}
			const message = request.action === "handoff" ? `Direct handoff started for @${task.taskId}.`
				: request.action === "takeback" ? `Return summary requested from @${task.taskId}.`
					: request.action === "archive" ? `@${task.taskId} archived without merging.`
						: `@${task.taskId} merged locally and archived.`;
			return { ok: true, message };
		} catch (error) {
			return boundedControlResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
		}
	}

	private async executeAsk(
		request: Extract<PiManagerControlRequest, { action: "ask" }>,
		tasks: readonly ManagerTaskCatalogueEntry[],
		projects: readonly ManagerProjectCatalogueEntry[],
		deliverAsk?: (message: string) => void | Promise<void>,
	): Promise<PiSessionControlResult> {
		const trimmedRequest = request.request.trim();
		if (!trimmedRequest || trimmedRequest.length > 2_000) {
			return { ok: false, message: "Manager requests must contain 1-2000 characters after trimming." };
		}
		const projectTarget = request.target.startsWith("project:") ? request.target.slice("project:".length) : undefined;
		const taskTarget = request.target.startsWith("task:") ? request.target.slice("task:".length) : undefined;
		if (projectTarget) {
			if (!projects.some((project) => project.projectId === projectTarget)) {
				return { ok: false, message: "Select a target from this manager session's current autocomplete catalogue." };
			}
		} else if (taskTarget) {
			if (!tasks.some((task) => task.taskId === taskTarget && isActiveManagerTask(task))) {
				return { ok: false, message: "Select a target from this manager session's current autocomplete catalogue." };
			}
		} else return { ok: false, message: "Select a target from this manager session's current autocomplete catalogue." };
		if (!deliverAsk) return { ok: false, message: "The verified manager client cannot deliver requests." };
		try {
			await this.validateRuntime();
			const canonical = await this.readCanonicalCatalogues();
			let context: string;
			let label: string;
			if (projectTarget) {
				if (!canonical.projects.some((project) => project.projectId === projectTarget)) {
					return { ok: false, message: "The selected project is no longer configured." };
				}
				context = `Project: ${projectTarget}`;
				label = `project ${projectTarget}`;
			} else {
				const task = canonical.tasks.find((candidate) => candidate.taskId === taskTarget && isActiveManagerTask(candidate));
				if (!task || !canonical.projects.some((project) => project.projectId === task.project)) {
					return { ok: false, message: "The selected task is no longer an active task in a configured project." };
				}
				context = `Project: ${task.project}\nTask: ${task.taskId}`;
				label = `task ${task.taskId}`;
			}
			await deliverAsk(`${context}\n\n${trimmedRequest}`);
			return { ok: true, message: `Request sent to ${label}.` };
		} catch (error) {
			return boundedControlResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
		}
	}

	private async readCanonicalCatalogues(): Promise<{
		tasks: ManagerTaskCatalogueEntry[];
		projects: ManagerProjectCatalogueEntry[];
	}> {
		const manager = join(this.root, "bin", "manager.mjs");
		const statusResult = await this.run(process.execPath, [manager, "status", "--root", this.root], {
			cwd: this.root,
			timeout: STATUS_TIMEOUT_MS,
		});
		if (statusResult.code !== 0) {
			throw new Error(failureMessage(statusResult, `manager status failed with exit ${statusResult.code}.`));
		}
		if (Buffer.byteLength(statusResult.stdout) > MAX_OUTPUT_BYTES) throw new Error("manager status output is too large");
		const projectPath = join(this.root, "data", "PROJECTS.md");
		const projectStat = await stat(projectPath);
		if (!projectStat.isFile() || projectStat.size > MAX_OUTPUT_BYTES) throw new Error("the-manager project registry is invalid or too large");
		const projectsContent = await readFile(projectPath, "utf8");
		return {
			tasks: managerTaskCatalogue(parseJson(statusResult.stdout, "manager status")),
			projects: managerProjectCatalogue(projectsContent),
		};
	}

	private async validateRuntime(signal?: AbortSignal): Promise<void> {
		const runtime = join(this.root, "bin", "manager-runtime.mjs");
		const result = await this.run(process.execPath, [runtime, "--root", this.root, "validate"], {
			cwd: this.root,
			timeout: VALIDATE_TIMEOUT_MS,
			signal,
		});
		if (result.code !== 0) throw new Error(failureMessage(result, `manager runtime validation failed with exit ${result.code}.`));
		const output = parseJson(result.stdout, "manager runtime validation");
		if (output.valid !== true) throw new Error("manager runtime validation returned conflicting JSON.");
	}
}
