import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { boundedControlResult, type PiSessionControlResult } from "./controls.js";

export const MANAGER_PRESENTATION_CONTROL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const VALIDATE_TIMEOUT_MS = 30_000;
const HERDR_LOCATOR = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const MANAGER_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ManagerPresentationControlDependencies {
	run?: (executable: string, args: string[], options: { cwd: string; timeout: number; signal?: AbortSignal }) => Promise<ManagerProcessResult>;
	environment?: NodeJS.ProcessEnv;
}

export interface ManagerProcessResult {
	code: number;
	stdout: string;
	stderr: string;
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
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${description} returned malformed JSON.`);
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

export class ManagerPresentationControlExecutor {
	private constructor(
		private readonly root: string,
		private readonly run: NonNullable<ManagerPresentationControlDependencies["run"]>,
	) {}

	static async create(
		root: string,
		dependencies: ManagerPresentationControlDependencies = {},
	): Promise<ManagerPresentationControlExecutor | undefined> {
		if (!isProtectedManagerEnvironment(dependencies.environment ?? process.env)) return undefined;
		const canonicalRoot = resolve(root);
		const supervisorClient = join(canonicalRoot, "bin", "manager-supervisor-client.mjs");
		const runtime = join(canonicalRoot, "bin", "manager-runtime.mjs");
		if (!await isFile(supervisorClient) || !await isFile(runtime)) return undefined;
		const executor = new ManagerPresentationControlExecutor(canonicalRoot, dependencies.run ?? defaultRun);
		await executor.validateRuntime();
		return executor;
	}

	async executeMerge(taskId: string): Promise<PiSessionControlResult> {
		if (!MANAGER_TASK_ID.test(taskId)) return { ok: false, message: "Manager action task ID is invalid." };
		try {
			await this.validateRuntime();
			const supervisorClient = join(this.root, "bin", "manager-supervisor-client.mjs");
			const taskPath = join(this.root, "data", "tasks", `${taskId}.md`);
			const result = await this.run(process.execPath, [
				supervisorClient, "task-merge-and-archive", "--root", this.root, "--task", taskPath,
				"--activity-clear", "yes", "--evidence", `User explicitly confirmed merge, push, and archive for task ${taskId} via Discord.`,
			], { cwd: this.root, timeout: MANAGER_PRESENTATION_CONTROL_TIMEOUT_MS });
			if (result.code !== 0) return boundedControlResult({
				ok: false, message: failureMessage(result, `merge-and-archive failed with exit ${result.code}.`),
			});
			const output = parseJson(result.stdout, "merge-and-archive");
			if (output.ok !== true || output.command !== "task-merge-and-archive" || output.task_id !== taskId ||
				output.archived !== true || typeof output.checkout_mode !== "string" ||
				(output.slot_state !== null && typeof output.slot_state !== "string") || output.pushed !== true ||
				typeof output.replay !== "boolean") {
				return { ok: false, message: "merge-and-archive returned conflicting manager output." };
			}
			return { ok: true, message: `@${taskId} merged, pushed, and archived.` };
		} catch (error) {
			return boundedControlResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
		}
	}

	private async validateRuntime(signal?: AbortSignal): Promise<void> {
		const runtime = join(this.root, "bin", "manager-runtime.mjs");
		const result = await this.run(process.execPath, [runtime, "--root", this.root, "validate"], {
			cwd: this.root,
			timeout: VALIDATE_TIMEOUT_MS,
			signal,
		});
		if (result.code !== 0) throw new Error(failureMessage(result, `manager runtime validation failed with exit ${result.code}.`));
		if (parseJson(result.stdout, "manager runtime validation").valid !== true) {
			throw new Error("manager runtime validation returned conflicting JSON.");
		}
	}
}
