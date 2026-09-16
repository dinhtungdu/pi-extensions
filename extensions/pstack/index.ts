import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getAgentDir,
	parseFrontmatter,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { PACKAGE_FOOTER_STATUS_KEYS } from "../footer-status.js";

const MODE_ENTRY = "pi-extensions-pstack-mode";
const TASK_WIDGET_KEY = "pi-extensions-pstack-tasks";
const TASK_COMPLETE_MESSAGE = "pi-extensions-pstack-batch-complete";
const STATUS_KEY = PACKAGE_FOOTER_STATUS_KEYS.pstack;
const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_OUTSTANDING_TASKS = 16;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL_PATH = join(PACKAGE_ROOT, "skills", "pstack", "poteto-mode", "SKILL.md");
const PORTABILITY_PATH = join(PACKAGE_ROOT, "skills", "pstack", "poteto-mode", "references", "pi-port.md");
const AGENT_DIR = join(PACKAGE_ROOT, "agents", "pstack");

export const PSTACK_ROLE_NAMES = [
	"feature, refactoring",
	"bug-fix",
	"perf-issue",
	"hillclimb",
	"judgment and prose",
	"hardest tasks",
	"how explorer",
	"how explainer",
	"why investigators",
	"why synthesizer",
	"reflect tooling",
	"reflect judgment, divergent, synthesizer",
	"arena runners",
	"arena cross-judge pool",
	"swarm workers",
	"architect runners",
	"interrogate reviewers",
] as const;

type PstackRole = (typeof PSTACK_ROLE_NAMES)[number];
type RoleValue = string | string[];

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

interface PstackConfig {
	version: 1;
	roles: Record<PstackRole, RoleValue>;
}

interface AgentDefinition {
	name: string;
	description: string;
	tools?: string[];
	prompt: string;
}

interface PreparedTask {
	task: TaskInput;
	agent: AgentDefinition;
	model?: string;
}

interface ChildResult {
	agent: string;
	task: string;
	model?: string;
	exitCode: number;
	output: string;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	usage: Usage;
}

type BackgroundTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface BackgroundTask {
	id: string;
	batchId: string;
	prepared: PreparedTask;
	status: BackgroundTaskStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	latest: string;
	controller: AbortController;
	cancelRequested: boolean;
	result?: ChildResult;
	completion?: Promise<void>;
	generation: number;
}

interface BackgroundBatch {
	id: string;
	taskIds: string[];
	notified: boolean;
	generation: number;
}

interface ChildMessage {
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: Usage;
}

interface ModeEntry {
	type?: string;
	customType?: string;
	data?: unknown;
}

interface AgentFrontmatter extends Record<string, unknown> {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
}

const TaskSchema = Type.Object(
	{
		agent: Type.String({ minLength: 1, description: "Bundled agent name: poteto-agent or comment-sicko." }),
		task: Type.String({ minLength: 1, description: "Self-contained delegated task with file pointers and authority limits." }),
		role: Type.Optional(Type.String({ description: "Role configured by /setup-pstack or pstack_config." })),
		model: Type.Optional(Type.String({ description: "One listed Pi provider/model override." })),
		readonly: Type.Optional(Type.Boolean({ description: "Restrict the child to read, grep, find, and ls." })),
	},
	{ additionalProperties: false },
);

const SubagentParams = Type.Object(
	{
		agent: Type.Optional(TaskSchema.properties.agent),
		task: Type.Optional(TaskSchema.properties.task),
		role: Type.Optional(TaskSchema.properties.role),
		model: Type.Optional(TaskSchema.properties.model),
		readonly: Type.Optional(TaskSchema.properties.readonly),
		tasks: Type.Optional(Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS })),
	},
	{ additionalProperties: false },
);

type TaskInput = Static<typeof TaskSchema>;
type SubagentInput = Static<typeof SubagentParams>;

const ConfigParams = Type.Object(
	{
		action: Type.String({ description: "get, list-models, set, or reset" }),
		role: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		models: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: MAX_TASKS })),
	},
	{ additionalProperties: false },
);

type ConfigInput = Static<typeof ConfigParams>;

const TasksParams = Type.Object(
	{
		action: Type.String({ description: "list, get, or cancel" }),
		id: Type.Optional(Type.String({ description: "Batch or task ID for get/cancel." })),
	},
	{ additionalProperties: false },
);

type TasksInput = Static<typeof TasksParams>;

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(target: Usage, value: Usage | undefined): void {
	if (!value) return;
	target.input += value.input ?? 0;
	target.output += value.output ?? 0;
	target.cacheRead += value.cacheRead ?? 0;
	target.cacheWrite += value.cacheWrite ?? 0;
	target.totalTokens += value.totalTokens ?? 0;
	target.cost.input += value.cost?.input ?? 0;
	target.cost.output += value.cost?.output ?? 0;
	target.cost.cacheRead += value.cost?.cacheRead ?? 0;
	target.cost.cacheWrite += value.cost?.cacheWrite ?? 0;
	target.cost.total += value.cost?.total ?? 0;
}

function configPath(): string {
	return join(getAgentDir(), "pstack", "models.json");
}

function defaultConfig(): PstackConfig {
	return {
		version: 1,
		roles: Object.fromEntries(PSTACK_ROLE_NAMES.map((role) => [role, "inherit-parent"])) as Record<
			PstackRole,
			RoleValue
		>,
	};
}

function parseConfig(value: unknown): PstackConfig {
	const config = defaultConfig();
	if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return config;
	const roles = (value as { roles?: unknown }).roles;
	if (!roles || typeof roles !== "object" || Array.isArray(roles)) return config;
	for (const role of PSTACK_ROLE_NAMES) {
		const candidate = (roles as Record<string, unknown>)[role];
		if (typeof candidate === "string" && candidate.trim()) config.roles[role] = candidate;
		if (Array.isArray(candidate) && candidate.length > 0 && candidate.every((item) => typeof item === "string" && item.trim())) {
			config.roles[role] = [...candidate];
		}
	}
	return config;
}

async function readConfig(): Promise<PstackConfig> {
	try {
		return parseConfig(JSON.parse(await readFile(configPath(), "utf8")));
	} catch {
		return defaultConfig();
	}
}

async function writeConfig(config: PstackConfig): Promise<void> {
	const target = configPath();
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(config, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, target);
}

let configMutationQueue = Promise.resolve();

function mutateConfig(update: (config: PstackConfig) => PstackConfig): Promise<PstackConfig> {
	const operation = configMutationQueue.then(async () => {
		const config = update(await readConfig());
		await writeConfig(config);
		return config;
	});
	configMutationQueue = operation.then(() => undefined, () => undefined);
	return operation;
}

function parseTools(value: unknown): string[] | undefined {
	const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = values.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
	return tools.length ? tools : undefined;
}

async function loadAgents(): Promise<AgentDefinition[]> {
	const agents: AgentDefinition[] = [];
	for (const entry of await readdir(AGENT_DIR, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const content = await readFile(join(AGENT_DIR, entry.name), "utf8");
		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseTools(frontmatter.tools),
			prompt: body.trim(),
		});
	}
	return agents;
}

function configuredModels(config: PstackConfig, role: string | undefined): string[] {
	if (!role || !PSTACK_ROLE_NAMES.includes(role as PstackRole)) return [];
	const value = config.roles[role as PstackRole];
	return typeof value === "string" ? [value] : value;
}

function availableModels(ctx: ExtensionContext): string[] {
	const models = ctx.scopedModels.length ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
	const available = new Set(models.map((model) => `${model.provider}/${model.id}`));
	if (ctx.model) available.add(`${ctx.model.provider}/${ctx.model.id}`);
	return [...available];
}

function validateModels(models: string[], available: string[]): void {
	const choices = new Set(["inherit-parent", "auto", ...available]);
	const invalid = models.filter((model) => !choices.has(model));
	if (invalid.length) throw new Error(`Unknown Pi model: ${invalid.join(", ")}. Use pstack_config action=list-models.`);
}

function modelForTask(task: TaskInput, index: number, config: PstackConfig, parentModel: string | undefined): string | undefined {
	if (task.model) return task.model === "auto" ? undefined : task.model === "inherit-parent" ? parentModel : task.model;
	const configured = configuredModels(config, task.role);
	if (!configured.length) return parentModel;
	const selected = configured[index % configured.length];
	return selected === "auto" ? undefined : selected === "inherit-parent" ? parentModel : selected;
}

function limitBytes(text: string, limit: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= limit) return text;
	let end = limit;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}\n\n[Output truncated to ${limit} bytes.]`;
}

function childFailed(result: ChildResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || !result.output;
}

function childFailure(result: ChildResult): string {
	return result.errorMessage || result.stderr || result.output || `Child exited ${result.exitCode} without an assistant result.`;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const executable = basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable)
		? { command: "pi", args }
		: { command: process.execPath, args };
}

function latestLine(text: string): string {
	const line = text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1) ?? "";
	return [...line].slice(-120).join("");
}

function processJsonLine(
	line: string,
	result: ChildResult,
	stream: { draft: string },
	onProgress?: (status: string) => void,
): void {
	if (!line.trim()) return;
	try {
		const event = JSON.parse(line) as {
			type?: string;
			message?: ChildMessage;
			assistantMessageEvent?: { type?: string; delta?: string; content?: string };
			toolName?: string;
			isError?: boolean;
			attempt?: number;
			maxAttempts?: number;
		};
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update?.type === "text_start") stream.draft = "";
			if (update?.type === "text_delta" && update.delta) {
				stream.draft = [...stream.draft, ...update.delta].slice(-2_000).join("");
				const status = latestLine(stream.draft);
				if (status) onProgress?.(status);
			}
			if (update?.type === "text_end" && update.content) onProgress?.(latestLine(update.content));
			if (update?.type === "thinking_start") onProgress?.("thinking");
			return;
		}
		if (event.type === "tool_execution_start" && event.toolName) {
			onProgress?.(`running ${event.toolName}`);
			return;
		}
		if (event.type === "tool_execution_end" && event.toolName) {
			onProgress?.(`${event.toolName} ${event.isError ? "failed" : "finished"}`);
			return;
		}
		if (event.type === "compaction_start") {
			onProgress?.("compacting context");
			return;
		}
		if (event.type === "auto_retry_start") {
			onProgress?.(`retrying ${event.attempt ?? "?"}/${event.maxAttempts ?? "?"}`);
			return;
		}
		if (event.type !== "message_end" || event.message?.role !== "assistant") return;
		const message = event.message;
		const output = message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
		if (output) {
			result.output = limitBytes(output, MAX_OUTPUT_BYTES);
			onProgress?.(latestLine(output));
		}
		if (message.model) result.model = message.model;
		if (message.stopReason) result.stopReason = message.stopReason;
		if (message.errorMessage) result.errorMessage = message.errorMessage;
		addUsage(result.usage, message.usage);
	} catch {
		// Ignore malformed or unrelated child output; process exit remains authoritative.
	}
}

async function runChild(
	parentCwd: string,
	task: TaskInput,
	agent: AgentDefinition,
	model: string | undefined,
	signal: AbortSignal | undefined,
	onProgress?: (status: string) => void,
): Promise<ChildResult> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-pstack-"));
	const promptPath = join(temporaryDirectory, "agent.md");
	const authority = [
		"Follow the user, repository, and active task authority in this working directory.",
		"Do not push, create or alter pull requests, merge, deploy, delete user data, or mutate infrastructure unless the parent task grants that exact action.",
		"When a Manager or supervisor owns canonical task state, never mutate it. Return evidence to the parent task lead.",
		"Parallel children may write only in explicitly isolated worktrees or disjoint scratch paths. Otherwise remain read-only.",
	].join("\n");
	await writeFile(
		promptPath,
		`${agent.prompt}\n\nRead ${PORTABILITY_PATH} before working.\n\n${authority}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	const args = [
		"--mode",
		"json",
		"--print",
		"--no-session",
		"--offline",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--append-system-prompt",
		promptPath,
	];
	if (model) args.push("--model", model);
	const tools = task.readonly ? ["read", "grep", "find", "ls"] : agent.tools;
	if (tools?.length) args.push("--tools", tools.join(","));
	args.push(`Delegated task:\n${task.task}`);
	const result: ChildResult = {
		agent: agent.name,
		task: task.task,
		model,
		exitCode: 1,
		output: "",
		stderr: "",
		usage: emptyUsage(),
	};

	try {
		const stream = { draft: "" };
		await new Promise<void>((resolveProcess) => {
			const invocation = piInvocation(args);
			const child = spawn(invocation.command, invocation.args, {
				cwd: parentCwd,
				detached: process.platform !== "win32",
				env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("THE_MANAGER_"))),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let settled = false;
			let aborted = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const processGroupAlive = () => {
				if (process.platform === "win32" || !child.pid) return false;
				try {
					process.kill(-child.pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			const finish = (exitCode: number) => {
				if (settled) return;
				settled = true;
				if (aborted && processGroupAlive()) kill("SIGKILL");
				if (killTimer) clearTimeout(killTimer);
				signal?.removeEventListener("abort", abort);
				if (stdout.trim()) processJsonLine(stdout, result, stream, onProgress);
				result.exitCode = exitCode;
				if (aborted) result.stopReason = "aborted";
				resolveProcess();
			};
			const kill = (killSignal: NodeJS.Signals) => {
				if (process.platform === "win32" && child.pid) {
					const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
					killer.once("error", () => child.kill(killSignal));
					return;
				}
				if (child.pid) {
					try {
						process.kill(-child.pid, killSignal);
						return;
					} catch {
						// The process may have exited between the abort and signal.
					}
				}
				child.kill(killSignal);
			};
			const abort = () => {
				aborted = true;
				kill("SIGTERM");
				killTimer = setTimeout(() => kill("SIGKILL"), 5_000);
				killTimer.unref();
			};
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
				const lines = stdout.split("\n");
				stdout = lines.pop() ?? "";
				for (const line of lines) processJsonLine(line, result, stream, onProgress);
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				result.stderr = limitBytes(result.stderr + chunk, MAX_STDERR_BYTES);
			});
			child.once("error", (error) => {
				result.stderr = limitBytes(`${result.stderr}${error.message}`, MAX_STDERR_BYTES);
				finish(1);
			});
			child.once("close", (code) => finish(code ?? 1));
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		});
		return result;
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

export function latestPotetoMode(entries: ModeEntry[]): boolean {
	let enabled = false;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY) continue;
		enabled = Boolean((entry.data as { enabled?: unknown } | undefined)?.enabled);
	}
	return enabled;
}

export default function pstackExtension(pi: ExtensionAPI): void {
	let potetoMode = false;
	let generation = 0;
	let nextBatchId = 1;
	let runningTasks = 0;
	let sessionActive = false;
	let taskContext: ExtensionContext | undefined;
	let renderTimer: ReturnType<typeof setTimeout> | undefined;
	const tasks = new Map<string, BackgroundTask>();
	const batches = new Map<string, BackgroundBatch>();
	const queue: BackgroundTask[] = [];

	function isTerminal(task: BackgroundTask): boolean {
		return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
	}

	function publicTask(task: BackgroundTask, includeResult = false): Record<string, unknown> {
		return {
			id: task.id,
			batchId: task.batchId,
			agent: task.prepared.agent.name,
			task: limitBytes(task.prepared.task.task, 2_000),
			model: task.prepared.model,
			readonly: task.prepared.task.readonly === true,
			status: task.status,
			latest: task.latest,
			createdAt: task.createdAt,
			startedAt: task.startedAt,
			finishedAt: task.finishedAt,
			...(includeResult ? { result: task.result } : {}),
		};
	}

	function batchStatus(batch: BackgroundBatch): string {
		const batchTasks = batch.taskIds.map((id) => tasks.get(id)).filter((task): task is BackgroundTask => Boolean(task));
		if (batchTasks.some((task) => !isTerminal(task))) return "running";
		if (batchTasks.some((task) => task.status === "failed")) return "failed";
		if (batchTasks.some((task) => task.status === "cancelled")) return "cancelled";
		return "completed";
	}

	function batchReport(batch: BackgroundBatch): string {
		const status = batchStatus(batch);
		const sections = [`Pstack batch ${batch.id} ${status}.`];
		for (const id of batch.taskIds) {
			const task = tasks.get(id);
			if (!task) continue;
			if (!task.result) {
				sections.push(`- ${task.id} ${task.prepared.agent.name}: ${task.status}${task.latest ? ` — ${task.latest}` : ""}`);
				continue;
			}
			const label = task.status === "completed" ? "completed" : task.status;
			const output = task.status === "completed" ? task.result.output : childFailure(task.result);
			sections.push(`### ${task.prepared.agent.name} ${label} (${task.id})\n\n${output || "(no output)"}`);
		}
		return limitBytes(sections.join("\n\n"), MAX_OUTPUT_BYTES);
	}

	function renderTasks(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const outstanding = [...tasks.values()].filter((task) => !isTerminal(task));
		if (!outstanding.length) {
			ctx.ui.setWidget(TASK_WIDGET_KEY, undefined);
			return;
		}
		const running = outstanding.filter((task) => task.status === "running").length;
		const queued = outstanding.length - running;
		const lines = [`pstack: ${running} running${queued ? ` · ${queued} queued` : ""}`];
		for (const task of outstanding) {
			const elapsed = Math.floor((Date.now() - (task.startedAt ?? task.createdAt)) / 1_000);
			const glyph = task.status === "running" ? "↻" : "…";
			const status = task.cancelRequested ? "cancelling" : task.latest || task.status;
			lines.push(`${glyph} ${task.id} ${task.prepared.agent.name} · ${status} · ${elapsed}s`);
		}
		ctx.ui.setWidget(TASK_WIDGET_KEY, lines, { placement: "belowEditor" });
	}

	function scheduleRender(): void {
		if (!sessionActive || !taskContext?.hasUI || renderTimer) return;
		const scheduledGeneration = generation;
		renderTimer = setTimeout(() => {
			renderTimer = undefined;
			if (sessionActive && scheduledGeneration === generation && taskContext) renderTasks(taskContext);
		}, 100);
		renderTimer.unref();
	}

	function notifyBatch(batch: BackgroundBatch): void {
		if (batch.notified || batch.generation !== generation || !sessionActive) return;
		const batchTasks = batch.taskIds.map((id) => tasks.get(id)).filter((task): task is BackgroundTask => Boolean(task));
		if (!batchTasks.length || batchTasks.some((task) => !isTerminal(task))) return;
		batch.notified = true;
		const status = batchStatus(batch);
		try {
			pi.sendMessage(
				{
					customType: TASK_COMPLETE_MESSAGE,
					content: batchReport(batch),
					display: true,
					details: { batchId: batch.id, status, tasks: batchTasks.map((task) => publicTask(task)) },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (error) {
			console.error("[pstack] completion notification failed:", error);
		}
	}

	function failedResult(task: BackgroundTask, error: unknown): ChildResult {
		const message = error instanceof Error ? error.message : String(error);
		return {
			agent: task.prepared.agent.name,
			task: task.prepared.task.task,
			model: task.prepared.model,
			exitCode: 1,
			output: "",
			stderr: message,
			stopReason: task.cancelRequested ? "aborted" : "error",
			errorMessage: task.cancelRequested ? "Cancelled." : message,
			usage: emptyUsage(),
		};
	}

	function settleTask(task: BackgroundTask, result: ChildResult): void {
		if (task.generation !== generation || isTerminal(task)) return;
		task.result = result;
		task.finishedAt = Date.now();
		task.status = task.cancelRequested || result.stopReason === "aborted"
			? "cancelled"
			: childFailed(result) ? "failed" : "completed";
		task.latest = task.status;
		runningTasks = Math.max(0, runningTasks - 1);
		scheduleRender();
		const batch = batches.get(task.batchId);
		if (batch) notifyBatch(batch);
		pumpQueue();
	}

	function startTask(task: BackgroundTask): void {
		task.status = "running";
		task.startedAt = Date.now();
		task.latest = "starting";
		runningTasks++;
		task.completion = runChild(
			taskContext?.cwd ?? process.cwd(),
			task.prepared.task,
			task.prepared.agent,
			task.prepared.model,
			task.controller.signal,
			(status) => {
				if (task.generation !== generation || task.status !== "running") return;
				task.latest = status;
				scheduleRender();
			},
		).then(
			(result) => settleTask(task, result),
			(error) => settleTask(task, failedResult(task, error)),
		);
	}

	function pumpQueue(): void {
		if (!sessionActive) return;
		while (runningTasks < MAX_CONCURRENCY && queue.length) {
			const task = queue.shift()!;
			if (!isTerminal(task)) startTask(task);
		}
		scheduleRender();
	}

	function cancelTask(task: BackgroundTask): boolean {
		if (isTerminal(task)) return false;
		task.cancelRequested = true;
		task.latest = "cancelling";
		if (task.status === "queued") {
			task.status = "cancelled";
			task.finishedAt = Date.now();
			task.result = failedResult(task, new Error("Cancelled before start."));
			const batch = batches.get(task.batchId);
			if (batch) notifyBatch(batch);
		} else {
			task.controller.abort();
		}
		scheduleRender();
		return true;
	}

	async function shutdownTasks(ctx: ExtensionContext): Promise<void> {
		sessionActive = false;
		if (renderTimer) {
			clearTimeout(renderTimer);
			renderTimer = undefined;
		}
		for (const task of tasks.values()) cancelTask(task);
		const completions = [...tasks.values()].flatMap((task) => task.completion ? [task.completion] : []);
		if (completions.length) {
			await new Promise<void>((resolveShutdown) => {
				const timeout = setTimeout(resolveShutdown, 5_250);
				void Promise.allSettled(completions).then(() => {
					clearTimeout(timeout);
					resolveShutdown();
				});
			});
		}
		generation++;
		runningTasks = 0;
		queue.length = 0;
		tasks.clear();
		batches.clear();
		taskContext = undefined;
		if (ctx.hasUI) ctx.ui.setWidget(TASK_WIDGET_KEY, undefined);
	}

	function syncMode(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, potetoMode ? "🥔 poteto" : undefined);
	}

	function restoreMode(ctx: ExtensionContext): void {
		potetoMode = latestPotetoMode(ctx.sessionManager.getBranch() as ModeEntry[]);
		syncMode(ctx);
	}

	function setMode(ctx: ExtensionContext, enabled: boolean): void {
		potetoMode = enabled;
		pi.appendEntry(MODE_ENTRY, { enabled });
		syncMode(ctx);
	}

	pi.registerMessageRenderer(TASK_COMPLETE_MESSAGE, (message, _options, theme) => {
		const status = (message.details as { status?: string } | undefined)?.status;
		const content = typeof message.content === "string"
			? message.content
			: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		const [heading, ...body] = content.split("\n");
		return new Text(`${theme.fg(status === "completed" ? "success" : "warning", heading)}${body.length ? `\n${body.join("\n")}` : ""}`, 0, 0);
	});

	pi.on("session_start", (_event, ctx) => {
		generation++;
		sessionActive = true;
		taskContext = ctx;
		restoreMode(ctx);
	});
	pi.on("session_before_tree", async (_event, ctx) => {
		await shutdownTasks(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		sessionActive = true;
		taskContext = ctx;
		restoreMode(ctx);
		scheduleRender();
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		await shutdownTasks(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (event.source !== "extension") {
			const activation = event.text.match(/^\/skill:poteto-mode(?:\s+([\s\S]*))?$/);
			if (activation) setMode(ctx, !/^(off|disable|stop)$/i.test(activation[1]?.trim() ?? ""));
		}
		return { action: "continue" } as const;
	});

	pi.on("before_agent_start", (event) => {
		if (!potetoMode) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\nPoteto Mode is enabled for this Pi session. Read and follow ${SKILL_PATH}. Read ${PORTABILITY_PATH} first; its Pi capability and authority rules override incompatible upstream wording.`,
		};
	});

	pi.registerCommand("poteto-mode", {
		description: "Enable sticky Poteto Mode for this session, or disable it with /poteto-mode off",
		getArgumentCompletions: (prefix) => "off".startsWith(prefix) ? [{ value: "off", label: "off" }] : null,
		handler: async (args, ctx) => {
			const task = args.trim();
			if (/^(off|disable|stop)$/i.test(task)) {
				setMode(ctx, false);
				ctx.ui.notify("Poteto Mode disabled for this session.", "info");
				return;
			}
			setMode(ctx, true);
			const message = task || "Poteto Mode enabled. Assess the current task and follow the matching playbook.";
			pi.sendUserMessage(message, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});

	pi.registerCommand("setup-pstack", {
		description: "Configure one pstack model role from Pi's available models; use status or reset for maintenance",
		getArgumentCompletions: (prefix) => ["status", "reset"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "status") {
				ctx.ui.notify(JSON.stringify(await readConfig(), null, "\t"), "info");
				return;
			}
			if (action === "reset") {
				await mutateConfig(() => defaultConfig());
				ctx.ui.notify(`Reset pstack models to inherit the parent model: ${configPath()}`, "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Run /setup-pstack in interactive Pi, or use pstack_config.", "warning");
				return;
			}
			const role = await ctx.ui.select("Pstack role", [...PSTACK_ROLE_NAMES]);
			if (!role) return;
			const model = await ctx.ui.select(`Model for ${role}`, ["inherit-parent", ...availableModels(ctx)]);
			if (!model) return;
			await mutateConfig((config) => {
				config.roles[role as PstackRole] = model;
				return config;
			});
			ctx.ui.notify(`Saved ${role}: ${model} to ${configPath()}`, "info");
		},
	});

	pi.registerTool({
		name: "pstack_config",
		label: "Pstack Config",
		description: "List Pi models or inspect pstack role mappings. Set/reset mappings only when the user explicitly asks to configure pstack.",
		parameters: ConfigParams,
		async execute(_id, params: ConfigInput, _signal, _update, ctx) {
			const models = availableModels(ctx);
			if (params.action === "list-models") {
				return { content: [{ type: "text", text: ["inherit-parent", ...models].join("\n") }], details: { models } };
			}
			if (!["get", "set", "reset"].includes(params.action)) throw new Error("pstack_config action must be get, list-models, set, or reset.");
			let config: PstackConfig;
			if (params.action === "set") {
				if (!params.role || !PSTACK_ROLE_NAMES.includes(params.role as PstackRole)) throw new Error("pstack_config set requires a listed role.");
				const values = params.models ?? (params.model ? [params.model] : []);
				if (!values.length || (params.model && params.models)) throw new Error("pstack_config set requires exactly one of model or models.");
				validateModels(values, models);
				config = await mutateConfig((current) => {
					current.roles[params.role as PstackRole] = params.models ? [...values] : values[0];
					return current;
				});
			} else if (params.action === "reset") {
				config = await mutateConfig(() => defaultConfig());
			} else {
				config = await readConfig();
			}
			return { content: [{ type: "text", text: JSON.stringify(config, null, "\t") }], details: config };
		},
	});

	pi.registerTool({
		name: "pstack_sessions",
		label: "Pstack Sessions",
		description: "List saved Pi sessions for the current working directory without scanning other projects.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, _signal, _update, ctx) {
			const sessions = await SessionManager.list(ctx.cwd);
			const files = sessions.map((session) => session.path);
			return { content: [{ type: "text", text: files.join("\n") || "No saved Pi sessions for this working directory." }], details: { files } };
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Pstack Subagent",
		description: `Start bundled pstack agents in background Pi processes and return task IDs immediately. Provide agent+task, or tasks for up to ${MAX_TASKS} tasks (${MAX_CONCURRENCY} running at once). Set readonly=true for analysis/review. Writers keep their existing tools and working directory; the parent must avoid overlapping edits.`,
		parameters: SubagentParams,
		executionMode: "sequential",
		async execute(_id, params: SubagentInput, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Subagent start cancelled.");
			const hasSingleFields = [params.agent, params.task, params.role, params.model, params.readonly].some((value) => value !== undefined);
			if ((params.tasks?.length && hasSingleFields) || (!params.tasks?.length && (!params.agent || !params.task))) {
				throw new Error("Provide exactly one subagent mode: agent + task, or tasks.");
			}
			const single = params.tasks?.length
				? undefined
				: [{ agent: params.agent!, task: params.task!, role: params.role, model: params.model, readonly: params.readonly }];
			const agents = await loadAgents();
			const config = await readConfig();
			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const knownModels = availableModels(ctx);
			const findAgent = (name: string) => {
				const agent = agents.find((candidate) => candidate.name === name);
				if (!agent) throw new Error(`Unknown pstack agent ${JSON.stringify(name)}. Available: ${agents.map((item) => item.name).join(", ")}.`);
				return agent;
			};
			const prepare = (task: TaskInput, index: number): PreparedTask => {
				if (!task.task.trim()) throw new Error("Subagent task must not be blank.");
				if (task.role && !PSTACK_ROLE_NAMES.includes(task.role as PstackRole)) throw new Error(`Unknown pstack role: ${task.role}.`);
				const model = modelForTask(task, index, config, parentModel);
				if (model) validateModels([model], knownModels);
				return { task, agent: findAgent(task.agent), model };
			};
			const prepared = (params.tasks ?? single!).map(prepare);
			if (signal?.aborted) throw new Error("Subagent start cancelled.");
			const outstanding = [...tasks.values()].filter((task) => !isTerminal(task)).length;
			if (outstanding + prepared.length > MAX_OUTSTANDING_TASKS) {
				throw new Error(`Pstack supports at most ${MAX_OUTSTANDING_TASKS} unfinished background tasks.`);
			}
			taskContext = ctx;
			const createdAt = Date.now();
			const batchId = `b${nextBatchId++}`;
			const batch: BackgroundBatch = { id: batchId, taskIds: [], notified: false, generation };
			for (const [index, item] of prepared.entries()) {
				const task: BackgroundTask = {
					id: `${batchId}.${index + 1}`,
					batchId,
					prepared: item,
					status: "queued",
					createdAt,
					latest: "queued",
					controller: new AbortController(),
					cancelRequested: false,
					generation,
				};
				batch.taskIds.push(task.id);
				tasks.set(task.id, task);
				queue.push(task);
			}
			batches.set(batchId, batch);
			pumpQueue();
			const lines = batch.taskIds.map((id) => {
				const task = tasks.get(id)!;
				return `- ${id}: ${task.prepared.agent.name}${task.prepared.model ? ` (${task.prepared.model})` : ""}`;
			});
			return {
				content: [{ type: "text", text: `Started pstack batch ${batchId} in the background.\n${lines.join("\n")}\nUse pstack_tasks get/cancel with a batch or task ID. A completion message will arrive when the batch finishes.` }],
				details: { batchId, taskIds: batch.taskIds },
			};
		},
	});

	pi.registerTool({
		name: "pstack_tasks",
		label: "Pstack Tasks",
		description: "List, inspect, or cancel background pstack batches and tasks from this Pi session.",
		parameters: TasksParams,
		executionMode: "sequential",
		async execute(_id, params: TasksInput) {
			if (params.action === "list") {
				const summaries = [...batches.values()].map((batch) => ({
					id: batch.id,
					status: batchStatus(batch),
					tasks: batch.taskIds.map((id) => tasks.get(id)).filter((task): task is BackgroundTask => Boolean(task)).map((task) => publicTask(task)),
				}));
				const text = summaries.map((batch) => `${batch.id} ${batch.status} · ${batch.tasks.map((task) => `${task.id} ${task.status}`).join(", ")}`).join("\n");
				return { content: [{ type: "text", text: text || "No pstack tasks in this session." }], details: { batches: summaries } };
			}
			if (params.action !== "get" && params.action !== "cancel") {
				throw new Error("pstack_tasks action must be list, get, or cancel.");
			}
			if (!params.id) throw new Error(`pstack_tasks ${params.action} requires an id.`);
			const task = tasks.get(params.id);
			const batch = batches.get(params.id);
			if (!task && !batch) throw new Error(`Unknown pstack task or batch: ${params.id}.`);
			if (params.action === "get") {
				if (task) {
					const output = task.result
						? task.status === "completed" ? task.result.output : childFailure(task.result)
						: task.latest;
					return {
						content: [{ type: "text", text: limitBytes(`${task.id} ${task.status}\n\n${output || "(no output yet)"}`, MAX_OUTPUT_BYTES) }],
						details: publicTask(task, true),
					};
				}
				return {
					content: [{ type: "text", text: batchReport(batch!) }],
					details: {
						id: batch!.id,
						status: batchStatus(batch!),
						tasks: batch!.taskIds.map((id) => tasks.get(id)).filter((item): item is BackgroundTask => Boolean(item)).map((item) => publicTask(item)),
					},
				};
			}
			const targets = task ? [task] : batch!.taskIds.map((id) => tasks.get(id)).filter((item): item is BackgroundTask => Boolean(item));
			const cancelled = targets.filter((item) => cancelTask(item)).map((item) => item.id);
			pumpQueue();
			return {
				content: [{ type: "text", text: cancelled.length ? `Cancelling: ${cancelled.join(", ")}` : "All selected pstack tasks were already terminal." }],
				details: { cancelled },
			};
		},
	});
}
