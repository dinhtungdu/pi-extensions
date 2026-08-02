import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	boundedControlResult,
	type ManagerTaskCatalogueEntry,
	type PiManagerControlRequest,
	type PiSessionControlResult,
} from "./controls.js";

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
		catalogue: readonly ManagerTaskCatalogueEntry[],
	): Promise<PiSessionControlResult> {
		const task = catalogue.find((candidate) => candidate.taskId === request.taskId);
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
					: [manager, request.action === "handoff" ? "handoff-start" : "handoff-return",
						"--root", this.root, "--task", taskPath];
			const result = await this.run(process.execPath, args, { cwd: this.root, timeout: CONTROL_TIMEOUT_MS });
			if (result.code !== 0) return boundedControlResult({ ok: false, message: failureMessage(result, `${request.action} failed with exit ${result.code}.`) });
			const output = parseJson(result.stdout, request.action);
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
