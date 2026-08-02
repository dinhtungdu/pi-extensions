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
const CONTROL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const HERDR_LOCATOR = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export interface ManagerProcessResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ManagerControlDependencies {
	run?: (executable: string, args: string[], options: { cwd: string; timeout: number }) => Promise<ManagerProcessResult>;
	environment?: NodeJS.ProcessEnv;
}

async function isFile(path: string): Promise<boolean> {
	return stat(path).then((entry) => entry.isFile(), () => false);
}

function defaultRun(
	executable: string,
	args: string[],
	options: { cwd: string; timeout: number },
): Promise<ManagerProcessResult> {
	return new Promise((resolveResult) => {
		execFile(executable, args, {
			cwd: options.cwd,
			encoding: "utf8",
			maxBuffer: MAX_OUTPUT_BYTES,
			timeout: options.timeout,
			windowsHide: true,
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

	async execute(
		request: PiManagerControlRequest,
		tasks: readonly ManagerTaskCatalogueEntry[],
		projects: readonly ManagerProjectCatalogueEntry[] = [],
		deliverAsk?: (message: string) => void | Promise<void>,
	): Promise<PiSessionControlResult> {
		if (request.action === "ask") return this.executeAsk(request, tasks, projects, deliverAsk);
		const task = tasks.find((candidate) => candidate.taskId === request.taskId);
		if (!task) return { ok: false, message: "Select a task from this manager session's current autocomplete catalogue." };
		try {
			await this.validateRuntime();
			const manager = join(this.root, "bin", "manager.mjs");
			const taskPath = join(this.root, "data", "tasks", `${task.taskId}.md`);
			const args = request.action === "archive"
				? [manager, "task-archive", "--root", this.root, "--task", taskPath, "--activity-clear", "yes",
					"--evidence", `User explicitly archived ${task.project} task ${task.taskId} without merging via Discord manager command.`,
					"--completion-authorized", "yes"]
				: request.action === "merge-and-archive"
					? [manager, "task-merge-and-archive", "--root", this.root, "--task", taskPath, "--activity-clear", "yes",
						"--evidence", `User explicitly merged ${task.project} task ${task.taskId} locally and archived it via Discord manager command.`]
					: request.action === "reconcile-pr"
						? [manager, "task-reconcile-pr", "--root", this.root, "--task", taskPath]
						: [manager, request.action === "handoff" ? "handoff-start" : "handoff-return",
							"--root", this.root, "--task", taskPath];
			const result = await this.run(process.execPath, args, { cwd: this.root, timeout: CONTROL_TIMEOUT_MS });
			if (result.code !== 0) return boundedControlResult({ ok: false, message: failureMessage(result, `${request.action} failed with exit ${result.code}.`) });
			const output = parseJson(result.stdout, request.action);
			if (request.action === "reconcile-pr") {
				if (!isReconcilePullRequestSuccess(output, task.taskId)) {
					return { ok: false, message: "reconcile-pr returned conflicting manager output." };
				}
				const message = output.state === "merged" ? `PR #${output.number} merged; @${task.taskId} archived without local merge.`
					: output.state === "not-found" ? `No pull request found for @${task.taskId}.`
						: `PR #${output.number} is ${output.state}: ${output.url}`;
				return { ok: true, message };
			}
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

	private async validateRuntime(): Promise<void> {
		const runtime = join(this.root, "bin", "manager-runtime.mjs");
		const result = await this.run(process.execPath, [runtime, "--root", this.root, "validate"], {
			cwd: this.root,
			timeout: VALIDATE_TIMEOUT_MS,
		});
		if (result.code !== 0) throw new Error(failureMessage(result, `manager runtime validation failed with exit ${result.code}.`));
		const output = parseJson(result.stdout, "manager runtime validation");
		if (output.valid !== true) throw new Error("manager runtime validation returned conflicting JSON.");
	}
}
