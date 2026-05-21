/**
 * Adds a Cloudflare-Codemode-style tool for pi.
 *
 * The sandbox is local Node.js worker/vm isolation, not Cloudflare Workers.
 * It is meant to reduce accidents and stop infinite loops, not run hostile code.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	formatSize,
	truncateHead,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
	type TruncationResult,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_LOGS = 100;
const MAX_LOG_CHARS = 2_000;
const MAX_PREVIEW_CHARS = 2_000;

const CODEMODE_TYPES = `
declare const codemode: {
  read(input: { path: string; offset?: number; limit?: number }): Promise<string>;
  bash(input: { command: string; timeout?: number }): Promise<string>;
  edit(input: { path: string; edits: Array<{ oldText: string; newText: string }> }): Promise<string>;
  write(input: { path: string; content: string }): Promise<string>;
  grep(input: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<string>;
  find(input: { pattern: string; path?: string; limit?: number }): Promise<string>;
  ls(input?: { path?: string; limit?: number }): Promise<string>;
};
`;

const CodeModeParams = Type.Object({
	code: Type.String({
		description:
			"JavaScript async arrow function or function body. It runs with a codemode object exposing active pi built-in tools. Example: async () => { const files = await codemode.ls({ path: '.' }); return files; }",
	}),
	timeoutMs: Type.Optional(
		Type.Number({
			description: `Execution timeout in ms. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
		}),
	),
});

type CodeModeParams = Static<typeof CodeModeParams>;
type BuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
type BuiltinToolDefinition = ToolDefinition<any, any, any>;

interface NestedToolCallSummary {
	id: number;
	tool: string;
	input: string;
	ok: boolean;
	durationMs: number;
	preview?: string;
	error?: string;
}

interface CodeModeDetails {
	ok: boolean;
	timeoutMs: number;
	logs: string[];
	toolCalls: NestedToolCallSummary[];
	output: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

type WorkerToHostMessage =
	| { type: "tool_call"; id: number; tool: string; input: unknown }
	| { type: "log"; level: "log" | "warn" | "error"; text: string }
	| { type: "done"; result: unknown }
	| { type: "error"; error: string };

type HostToWorkerMessage =
	| { type: "tool_result"; id: number; result: unknown }
	| { type: "tool_error"; id: number; error: string };

const TOOL_BUILDERS: Record<BuiltinToolName, (cwd: string) => BuiltinToolDefinition> = {
	read: createReadToolDefinition,
	bash: createBashToolDefinition,
	edit: createEditToolDefinition,
	write: createWriteToolDefinition,
	grep: createGrepToolDefinition,
	find: createFindToolDefinition,
	ls: createLsToolDefinition,
};

const BUILTIN_TOOL_NAMES = Object.keys(TOOL_BUILDERS) as BuiltinToolName[];

const WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

const pending = new Map();
let nextCallId = 1;

function toSafeValue(value, seen = new WeakSet(), depth = 0) {
	if (value === null || value === undefined) return value;
	const valueType = typeof value;
	if (valueType === "string" || valueType === "number" || valueType === "boolean") return value;
	if (valueType === "bigint") return value.toString();
	if (valueType === "function" || valueType === "symbol") return String(value);
	if (depth > 8) return "[MaxDepth]";
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack };
	}
	if (typeof value === "object") {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		if (Array.isArray(value)) return value.map((item) => toSafeValue(item, seen, depth + 1));
		const result = {};
		for (const key of Object.keys(value)) {
			result[key] = toSafeValue(value[key], seen, depth + 1);
		}
		return result;
	}
	return String(value);
}

function stringify(value) {
	try {
		if (typeof value === "string") return value;
		return JSON.stringify(toSafeValue(value));
	} catch (error) {
		return String(value);
	}
}

function emitLog(level, args) {
	parentPort.postMessage({ type: "log", level, text: args.map(stringify).join(" ") });
}

function callTool(tool, input) {
	const id = nextCallId++;
	parentPort.postMessage({ type: "tool_call", id, tool, input: input ?? {} });
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
	});
}

function hardenFunction(fn) {
	Object.defineProperty(fn, "constructor", { value: undefined });
	Object.setPrototypeOf(fn, null);
	return Object.freeze(fn);
}

parentPort.on("message", (message) => {
	const pendingCall = pending.get(message.id);
	if (!pendingCall) return;
	pending.delete(message.id);
	if (message.type === "tool_result") pendingCall.resolve(message.result);
	if (message.type === "tool_error") pendingCall.reject(new Error(message.error));
});

const toolFunctions = new Map();
const codemode = new Proxy(Object.freeze(Object.create(null)), {
	get(_target, property) {
		if (typeof property !== "string" || property === "then") return undefined;
		if (!toolFunctions.has(property)) {
			toolFunctions.set(property, hardenFunction((input) => callTool(property, input)));
		}
		return toolFunctions.get(property);
	},
	set() {
		return false;
	},
});

const sandbox = Object.assign(Object.create(null), {
	codemode,
	constructor: undefined,
	globalThis: undefined,
	self: undefined,
	window: undefined,
	console: Object.freeze(Object.assign(Object.create(null), {
		log: hardenFunction((...args) => emitLog("log", args)),
		warn: hardenFunction((...args) => emitLog("warn", args)),
		error: hardenFunction((...args) => emitLog("error", args)),
	})),
});

const context = vm.createContext(sandbox, {
	name: "pi-codemode",
	codeGeneration: { strings: false, wasm: false },
});

async function main() {
	try {
		const source = [
			'"use strict";',
			'(function(){ return (' + workerData.code + '); }).call(undefined)',
		].join(String.fromCharCode(10));
		const script = new vm.Script(source, {
			filename: "pi-codemode.js",
			displayErrors: true,
		});
		const fn = script.runInContext(context, { timeout: 1000, displayErrors: true });
		if (typeof fn !== "function") {
			throw new Error("codemode code must evaluate to a function");
		}
		const result = await fn();
		parentPort.postMessage({ type: "done", result: toSafeValue(result) });
	} catch (error) {
		parentPort.postMessage({ type: "error", error: stringify(toSafeValue(error)) });
	}
}

void main();
`;

function stripCodeFence(input: string): string {
	const trimmed = input.trim();
	const match = trimmed.match(/^```(?:javascript|js|typescript|ts)?\s*\n([\s\S]*?)\n```$/i);
	return match ? match[1].trim() : trimmed;
}

function normalizeCode(input: string): string {
	const code = stripCodeFence(input);
	if (/^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(code)) return code;
	if (/^(?:async\s+)?function\b/.test(code)) return code;
	return `async () => {\n${code}\n}`;
}

function clampTimeout(timeoutMs: number | undefined): number {
	if (!Number.isFinite(timeoutMs ?? DEFAULT_TIMEOUT_MS)) return DEFAULT_TIMEOUT_MS;
	return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(timeoutMs ?? DEFAULT_TIMEOUT_MS)));
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.stack ?? error.message;
	return String(error);
}

function compactString(input: string, maxChars: number): string {
	if (input.length <= maxChars) return input;
	return `${input.slice(0, maxChars)}… [truncated ${input.length - maxChars} chars]`;
}

function previewValue(value: unknown): string {
	try {
		return compactString(typeof value === "string" ? value : JSON.stringify(value), MAX_PREVIEW_CHARS);
	} catch {
		return compactString(String(value), MAX_PREVIEW_CHARS);
	}
}

function toolResultToSandboxValue(result: AgentToolResult<unknown>): unknown {
	const textParts = result.content.filter((part): part is { type: "text"; text: string } => part.type === "text");
	if (textParts.length === result.content.length) {
		return textParts.map((part) => part.text).join("\n");
	}

	return {
		content: result.content,
		details: result.details,
	};
}

function validationError(schema: TSchema, input: unknown): string | undefined {
	if (Check(schema, input)) return undefined;
	const errors = [...Errors(schema, input)]
		.slice(0, 5)
		.map((error) => `${error.instancePath || "/"} ${error.message}`);
	return errors.join("; ") || "input does not match schema";
}

function executableTools(pi: ExtensionAPI, ctx: ExtensionContext): Map<string, BuiltinToolDefinition> {
	const activeTools = new Set(pi.getActiveTools());
	const tools = new Map<string, BuiltinToolDefinition>();

	for (const name of BUILTIN_TOOL_NAMES) {
		if (activeTools.has(name)) {
			tools.set(name, TOOL_BUILDERS[name](ctx.cwd));
		}
	}

	return tools;
}

async function writeFullOutput(output: string): Promise<string> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-codemode-"));
	const outputPath = join(tempDir, "output.json");
	await withFileMutationQueue(outputPath, async () => {
		await writeFile(outputPath, output, "utf8");
	});
	return outputPath;
}

async function formatOutput(payload: unknown): Promise<{
	content: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}> {
	const output = JSON.stringify(payload, null, "\t");
	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) {
		return { content: output };
	}

	const fullOutputPath = await writeFullOutput(output);
	const content = `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
		truncation.outputBytes,
	)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${fullOutputPath}]`;

	return { content, truncation, fullOutputPath };
}

async function runInWorker(
	code: string,
	tools: Map<string, BuiltinToolDefinition>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	onToolCall: (message: { id: number; tool: string; input: unknown }) => Promise<unknown>,
	onLog: (level: "log" | "warn" | "error", text: string) => void,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timedOut = false;
		let aborted = false;
		const worker = new Worker(WORKER_SOURCE, {
			eval: true,
			workerData: { code },
		});

		const cleanup = () => {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", abort);
			worker.removeAllListeners();
		};

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
			void worker.terminate();
		};

		const abort = () => {
			aborted = true;
			void worker.terminate();
			finish(() => reject(new Error("codemode aborted")));
		};

		const timeoutId = setTimeout(() => {
			timedOut = true;
			void worker.terminate();
			finish(() => reject(new Error(`codemode timed out after ${timeoutMs}ms`)));
		}, timeoutMs);

		signal?.addEventListener("abort", abort, { once: true });

		worker.on("message", (message: WorkerToHostMessage) => {
			if (settled) return;

			if (message.type === "log") {
				onLog(message.level, message.text);
				return;
			}

			if (message.type === "tool_call") {
				if (!tools.has(message.tool)) {
					worker.postMessage({
						type: "tool_error",
						id: message.id,
						error: `Unknown or inactive codemode tool '${message.tool}'. Active codemode tools: ${[...tools.keys()].join(", ") || "none"}`,
					} satisfies HostToWorkerMessage);
					return;
				}

				void onToolCall(message)
					.then((result) => {
						if (!settled) worker.postMessage({ type: "tool_result", id: message.id, result } satisfies HostToWorkerMessage);
					})
					.catch((error) => {
						if (!settled) worker.postMessage({ type: "tool_error", id: message.id, error: errorMessage(error) } satisfies HostToWorkerMessage);
					});
				return;
			}

			if (message.type === "done") {
				finish(() => resolve(message.result));
				return;
			}

			if (message.type === "error") {
				finish(() => reject(new Error(message.error)));
			}
		});

		worker.on("error", (error) => {
			finish(() => reject(error));
		});

		worker.on("exit", (code) => {
			if (settled) return;
			if (timedOut || aborted) return;
			finish(() => reject(new Error(`codemode worker exited with code ${code}`)));
		});
	});
}

export default function codeMode(pi: ExtensionAPI) {
	pi.registerTool<typeof CodeModeParams, CodeModeDetails>({
		name: "codemode",
		label: "Code Mode",
		description: `Execute JavaScript that orchestrates active pi built-in tools, Cloudflare Codemode-style. Write an async arrow function that calls codemode.* and returns a JSON-serializable result. Only active built-in pi tools are exposed; network, fs, process, require, and import APIs are not provided except through tools. Local vm isolation is not a hostile-code security boundary. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(
			DEFAULT_MAX_BYTES,
		)}. Available method types:${CODEMODE_TYPES}`,
		promptSnippet: "Execute JavaScript to orchestrate active pi built-in tools in one sandboxed code step",
		promptGuidelines: [
			"Use codemode when a task needs loops, conditionals, result composition, or several dependent built-in tool calls.",
			"Do not use codemode for a simple single tool call; call the normal pi tool directly.",
			"codemode code must be JavaScript, not TypeScript; return a JSON-serializable value.",
		],
		parameters: CodeModeParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const timeoutMs = clampTimeout(params.timeoutMs);
			const tools = executableTools(pi, ctx);
			if (tools.size === 0) {
				throw new Error("codemode has no active built-in pi tools to expose");
			}

			const logs: string[] = [];
			const toolCalls: NestedToolCallSummary[] = [];

			const result = await runInWorker(
				normalizeCode(params.code),
				tools,
				timeoutMs,
				signal,
				async (message) => {
					const tool = tools.get(message.tool);
					if (!tool) throw new Error(`Unknown or inactive codemode tool '${message.tool}'`);

					const invalid = validationError(tool.parameters, message.input);
					if (invalid) throw new Error(`${message.tool} input invalid: ${invalid}`);

					const startedAt = Date.now();
					const summary: NestedToolCallSummary = {
						id: message.id,
						tool: message.tool,
						input: previewValue(message.input),
						ok: false,
						durationMs: 0,
					};
					toolCalls.push(summary);
					onUpdate?.(partialResult(`Running ${message.tool}…`, timeoutMs, logs, toolCalls));

					try {
						const nestedResult = await tool.execute(
							`codemode:${message.id}`,
							message.input,
							signal,
							undefined,
							ctx,
						);
						const sandboxValue = toolResultToSandboxValue(nestedResult);
						summary.ok = true;
						summary.durationMs = Date.now() - startedAt;
						summary.preview = previewValue(sandboxValue);
						onUpdate?.(partialResult(`Finished ${message.tool}`, timeoutMs, logs, toolCalls));
						return sandboxValue;
					} catch (error) {
						summary.durationMs = Date.now() - startedAt;
						summary.error = errorMessage(error);
						onUpdate?.(partialResult(`Failed ${message.tool}`, timeoutMs, logs, toolCalls));
						throw error;
					}
				},
				(level, text) => {
					if (logs.length >= MAX_LOGS) return;
					logs.push(compactString(`[${level}] ${text}`, MAX_LOG_CHARS));
					onUpdate?.(partialResult("Console output", timeoutMs, logs, toolCalls));
				},
			);

			const output = await formatOutput({ result: result === undefined ? "[undefined]" : result, logs, toolCalls });

			return {
				content: [{ type: "text", text: output.content }],
				details: {
					ok: true,
					timeoutMs,
					logs,
					toolCalls,
					output: output.content,
					truncation: output.truncation,
					fullOutputPath: output.fullOutputPath,
				},
			};
		},

		renderCall(args, theme) {
			const firstLine = stripCodeFence(args.code).split("\n").find((line) => line.trim())?.trim() ?? "";
			let text = theme.fg("toolTitle", theme.bold("codemode "));
			text += theme.fg("dim", compactString(firstLine, 80));
			if (args.timeoutMs) text += theme.fg("muted", ` timeout=${args.timeoutMs}ms`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as CodeModeDetails | undefined;
			if (isPartial) {
				return new Text(theme.fg("warning", details?.output ?? "Running codemode…"), 0, 0);
			}

			const calls = details?.toolCalls.length ?? 0;
			let text = theme.fg("success", `✓ codemode (${calls} nested tool call${calls === 1 ? "" : "s"})`);
			if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)");
			if (details?.fullOutputPath) text += theme.fg("dim", `\nFull output: ${details.fullOutputPath}`);

			if (expanded && details) {
				for (const log of details.logs) {
					text += `\n${theme.fg("dim", log)}`;
				}
				for (const call of details.toolCalls) {
					const status = call.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
					text += `\n${status} ${theme.fg("accent", call.tool)} ${theme.fg("dim", `${call.durationMs}ms`)}`;
					if (call.error) text += ` ${theme.fg("error", compactString(call.error, 120))}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}

function partialResult(
	message: string,
	timeoutMs: number,
	logs: string[],
	toolCalls: NestedToolCallSummary[],
): AgentToolResult<CodeModeDetails> {
	return {
		content: [{ type: "text", text: message }],
		details: {
			ok: false,
			timeoutMs,
			logs: [...logs],
			toolCalls: [...toolCalls],
			output: message,
		},
	};
}
