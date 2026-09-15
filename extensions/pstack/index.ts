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
import { Type, type Static } from "typebox";
import { PACKAGE_FOOTER_STATUS_KEYS } from "../footer-status.js";

const MODE_ENTRY = "pi-extensions-pstack-mode";
const STATUS_KEY = PACKAGE_FOOTER_STATUS_KEYS.pstack;
const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
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

function combinedUsage(results: ChildResult[]): Usage {
	const usage = emptyUsage();
	for (const result of results) addUsage(usage, result.usage);
	return usage;
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

function processJsonLine(line: string, result: ChildResult): boolean {
	if (!line.trim()) return false;
	try {
		const event = JSON.parse(line) as { type?: string; message?: ChildMessage };
		if (event.type !== "message_end" || event.message?.role !== "assistant") return false;
		const message = event.message;
		const output = message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
		if (output) result.output = limitBytes(output, MAX_OUTPUT_BYTES);
		if (message.model) result.model = message.model;
		if (message.stopReason) result.stopReason = message.stopReason;
		if (message.errorMessage) result.errorMessage = message.errorMessage;
		addUsage(result.usage, message.usage);
		return true;
	} catch {
		return false;
	}
}

async function runChild(
	parentCwd: string,
	task: TaskInput,
	agent: AgentDefinition,
	model: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((result: ChildResult) => void) | undefined,
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
		await new Promise<void>((resolveProcess) => {
			const invocation = piInvocation(args);
			const child = spawn(invocation.command, invocation.args, {
				cwd: parentCwd,
				env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("THE_MANAGER_"))),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let settled = false;
			let aborted = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const finish = (exitCode: number) => {
				if (settled) return;
				settled = true;
				if (killTimer) clearTimeout(killTimer);
				signal?.removeEventListener("abort", abort);
				if (stdout.trim()) processJsonLine(stdout, result);
				result.exitCode = exitCode;
				if (aborted) result.stopReason = "aborted";
				resolveProcess();
			};
			const abort = () => {
				aborted = true;
				child.kill("SIGTERM");
				killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
				killTimer.unref();
			};
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
				const lines = stdout.split("\n");
				stdout = lines.pop() ?? "";
				for (const line of lines) if (processJsonLine(line, result)) onUpdate?.(result);
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

async function mapLimited<T>(
	items: T[],
	signal: AbortSignal | undefined,
	fn: (item: T, index: number) => Promise<ChildResult>,
): Promise<ChildResult[]> {
	const results: ChildResult[] = [];
	let next = 0;
	let failure: { error: unknown } | undefined;
	await Promise.all(
		Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, async () => {
			while (next < items.length && !signal?.aborted && !failure) {
				const index = next++;
				try {
					results[index] = await fn(items[index], index);
				} catch (error) {
					failure ??= { error };
				}
			}
		}),
	);
	if (failure) throw failure.error;
	return results;
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

	pi.on("session_start", (_event, ctx) => restoreMode(ctx));
	pi.on("session_tree", (_event, ctx) => restoreMode(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
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
		description: `Run bundled pstack agents in isolated local Pi processes. Provide agent+task, or tasks for up to ${MAX_TASKS} parallel tasks (${MAX_CONCURRENCY} at once). Set readonly=true for analysis/review. Parallel writes require isolated worktrees or disjoint scratch paths. Children stay in the parent working directory.`,
		parameters: SubagentParams,
		async execute(_id, params: SubagentInput, signal, onUpdate, ctx) {
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
			const run = (item: PreparedTask, update?: (result: ChildResult) => void) =>
				runChild(ctx.cwd, item.task, item.agent, item.model, signal, update);
			const emit = (results: ChildResult[]) => onUpdate?.({
				content: [{ type: "text", text: results.map((result) => `${result.agent}: ${result.output || "(running...)"}`).join("\n\n") }],
				details: { results },
			});

			if (params.tasks?.length) {
				const updates: ChildResult[] = [];
				const results = await mapLimited(prepared, signal, async (item, index) => run(item, (update) => {
					updates[index] = update;
					emit(updates.filter(Boolean));
				}));
				if (signal?.aborted) throw new Error("Subagent parallel run cancelled.");
				const report = results.map((result) => `### ${result.agent} ${childFailed(result) ? "failed" : "completed"}\n\n${limitBytes(childFailed(result) ? childFailure(result) : result.output, MAX_OUTPUT_BYTES)}`).join("\n\n---\n\n");
				return { content: [{ type: "text", text: limitBytes(report, MAX_OUTPUT_BYTES) }], details: { mode: "parallel", results }, usage: combinedUsage(results) };
			}

			const result = await run(prepared[0], (update) => emit([update]));
			if (childFailed(result)) throw new Error(`Subagent failed: ${childFailure(result)}`);
			return { content: [{ type: "text", text: limitBytes(result.output, MAX_OUTPUT_BYTES) }], details: { mode: "single", results: [result] }, usage: result.usage };
		},
	});
}
