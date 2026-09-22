#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv.includes("--mode") && process.argv.includes("--no-session")) {
	const task = process.argv.at(-1) ?? "";
	const promptIndex = process.argv.indexOf("--append-system-prompt");
	const prompt = promptIndex >= 0 ? await readFile(process.argv[promptIndex + 1], "utf8") : "";
	if (
		!prompt.includes("mutate Manager state") ||
		prompt.includes("pi-port.md") ||
		!process.argv.includes("--offline") ||
		!process.argv.includes("--no-extensions") ||
		!process.argv.includes("--no-skills") ||
		!process.argv.includes("--no-prompt-templates") ||
		Object.keys(process.env).some((key) => key.startsWith("THE_MANAGER_"))
	) {
		console.error("missing delegated authority isolation");
		process.exit(3);
	}
	const marker = task.match(/spawn-marker:([^\s]+)/)?.[1];
	if (marker) await writeFile(marker, "spawned");
	const modelIndex = process.argv.indexOf("--model");
	const thinkingIndex = process.argv.indexOf("--thinking");
	const toolsIndex = process.argv.indexOf("--tools");
	if (task.includes("assert-readonly") && process.argv[toolsIndex + 1] !== "read,grep,find,ls") {
		console.error("readonly tools not enforced");
		process.exit(6);
	}
	if (task.includes("assert-parent-model") && process.argv[modelIndex + 1] !== "test/model") {
		console.error("parent model not inherited");
		process.exit(4);
	}
	if (task.includes("assert-parent-thinking") && process.argv[thinkingIndex + 1] !== "high") {
		console.error("parent thinking not inherited");
		process.exit(5);
	}
	if (task.includes("assert-mechanical-route") && (process.argv[modelIndex + 1] !== "openai-codex/gpt-5.6-luna" || process.argv[thinkingIndex + 1] !== "medium")) {
		console.error("mechanical route not applied");
		process.exit(8);
	}
	if ((task.includes("assert-configured-route") || task.includes("assert-explicit-model")) && (process.argv[modelIndex + 1] !== "other/reviewer" || process.argv[thinkingIndex + 1] !== "low")) {
		console.error("configured or explicit model override not applied");
		process.exit(9);
	}
	if (task.includes("assert-writer") && toolsIndex >= 0) {
		console.error("writer tools should remain unrestricted");
		process.exit(7);
	}
	const descendantMarker = task.match(/descendant-marker:([^\s]+)/)?.[1];
	if (descendantMarker) {
		const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
		await writeFile(descendantMarker, String(descendant.pid));
	}
	if (task.includes("hang")) {
		if (task.includes("progress")) {
			console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "fixture-tool", toolName: "read", args: {} }));
		}
		setInterval(() => {}, 1_000);
		await new Promise(() => {});
	} else {
		const failed = task.includes("fail-child");
		const message = {
			role: "assistant",
			content: [{ type: "text", text: failed ? "fixture failure" : `child:${task.replace("Delegated task:\n", "")}` }],
			model: "test/model",
			stopReason: failed ? "error" : "stop",
			errorMessage: failed ? "fixture failure" : undefined,
			usage: {
				input: 2,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 5,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		console.log(JSON.stringify({ type: "message_end", message }));
		if (failed) {
			console.error("fixture stderr");
			process.exit(2);
		}
		process.exit(0);
	}
}

const root = resolve(import.meta.dirname, "..");
const potetoSkillPath = "skills/pstack/poteto-mode/SKILL.md";
const issuePlaybookPath = "skills/pstack/poteto-mode/playbooks/issue-implementation.md";
const prReviewPlaybookPath = "skills/pstack/poteto-mode/playbooks/pr-review.md";
const potetoSkill = await readFile(join(root, potetoSkillPath), "utf8");
assert.match(potetoSkill, /\[Issue implementation\]\(playbooks\/issue-implementation\.md\)/);
assert.match(potetoSkill, /\[Pull request review\]\(playbooks\/pr-review\.md\)/);
assert.match(potetoSkill, /Default to direct work\. Do not turn routine implementation phases, compatibility scans, test planning, or post-change review into helper tasks\./);
assert.match(potetoSkill, /Independent review is opt-in:.*explicitly requests it, or when concrete security, data-loss, concurrency, irreversible-boundary risk, or unresolved evidence-based disagreement requires independent judgment\./);
const issuePlaybook = await readFile(join(root, issuePlaybookPath), "utf8");
assert.match(issuePlaybook, /The driver supplies task context, the issue, and the path to the project's verification skill\./);
const prReviewPlaybook = await readFile(join(root, prReviewPlaybookPath), "utf8");
assert.match(prReviewPlaybook, /The driver supplies task context and the pull request target\./);
assert.ok(
	issuePlaybook.includes(
		"Read [How](../../how/SKILL.md) directly to ground current mechanics. Trace the affected entry point, callers, data, effects, constraints, and user-visible acceptance criteria. When prior work is relevant, read [Recall](../../recall/SKILL.md) directly. When historical intent affects the decision, read [Why](../../why/SKILL.md) directly.",
	),
);
assert.ok(
	issuePlaybook.includes(
		"Design directly by default. Turn the observed behavior and traced flow into the smallest empirical design: affected boundary and callers, expected observable delta, implementation units, focused checks, and live verification recipe. Read [Architect](../../architect/SKILL.md) directly only when the boundary is consequential or hard to reverse, or when materially competing boundaries require comparison.",
	),
);
assert.ok(
	issuePlaybook.includes(
		"Always inspect and review the generated code directly in its full diff and caller context against the issue, design, checks, and before/after evidence. Keep routine post-change review in the parent. Read [Interrogate](../../interrogate/SKILL.md) only when the user explicitly requests independent review, or when concrete security, data-loss, concurrency, irreversible-boundary risk, or unresolved evidence-based disagreement requires independent judgment.",
	),
);
const pack = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
assert.equal(pack.status, 0, `npm pack failed:\n${pack.stdout}\n${pack.stderr}`);
const packedFiles = new Set(JSON.parse(pack.stdout)[0].files.map(({ path }) => path));
for (const path of [potetoSkillPath, issuePlaybookPath, prReviewPlaybookPath]) assert.ok(packedFiles.has(path), `${path} missing from npm package`);

const output = await mkdtemp(join(root, ".pstack-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(output, "agent");

try {
	const compile = spawnSync(
		join(root, "node_modules", ".bin", "tsc"),
		["--noEmit", "false", "--rootDir", ".", "--outDir", output],
		{ cwd: root, encoding: "utf8" },
	);
	if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`.trim());
	await cp(join(root, "agents"), join(output, "agents"), { recursive: true });
	await cp(join(root, "skills"), join(output, "skills"), { recursive: true });

	const { PACKAGE_FOOTER_STATUS_KEYS } = await import(pathToFileURL(join(output, "extensions", "footer-status.js")));
	const { default: pstackExtension, latestPotetoMode, PSTACK_ROUTE_NAMES } = await import(
		pathToFileURL(join(output, "extensions", "pstack", "index.js"))
	);
	assert.deepEqual(PSTACK_ROUTE_NAMES, ["mechanical", "bounded", "complex", "critical"]);
	assert.equal(latestPotetoMode([]), false);
	assert.equal(
		latestPotetoMode([
			{ type: "custom", customType: "pi-extensions-pstack-mode", data: { enabled: true } },
			{ type: "custom", customType: "pi-extensions-pstack-mode", data: { enabled: false } },
		]),
		false,
	);

	function createHarness() {
		const events = new Map();
		const commands = new Map();
		const tools = new Map();
		const entries = [];
		const sent = [];
		const messages = [];
		const statuses = [];
		const notifications = [];
		const selections = [];
		const widgets = [];
		const messageWaiters = [];
		const widgetWaiters = [];
		const pi = {
			on(name, handler) {
				const handlers = events.get(name) ?? [];
				handlers.push(handler);
				events.set(name, handlers);
			},
			registerCommand(name, command) {
				commands.set(name, command);
			},
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
			registerMessageRenderer() {},
			appendEntry(customType, data) {
				entries.push({ type: "custom", customType, data });
			},
			sendUserMessage(text, options) {
				sent.push({ text, options });
			},
			sendMessage(message, options) {
				const value = { message, options };
				messages.push(value);
				for (const waiter of messageWaiters.filter((waiter) => waiter.predicate(value))) waiter.resolve(value);
			},
		};
		const ctx = {
			cwd: root,
			hasUI: true,
			model: { provider: "test", id: "model" },
			thinkingLevel: "high",
			scopedModels: [],
			modelRegistry: {
				getAvailable: () => [
					{ provider: "test", id: "model" },
					{ provider: "other", id: "reviewer" },
					{ provider: "openai-codex", id: "gpt-5.6-luna" },
					{ provider: "openai-codex", id: "gpt-5.6-terra" },
					{ provider: "openai-codex", id: "gpt-5.6-sol" },
					{ provider: "openai-codex", id: "gpt-6-astra" },
				],
			},
			sessionManager: { getBranch: () => entries },
			isIdle: () => true,
			ui: {
				setStatus: (...args) => statuses.push(args),
				setWidget: (...args) => {
					widgets.push(args);
					for (const waiter of widgetWaiters.filter((waiter) => waiter.predicate(args))) waiter.resolve(args);
				},
				notify: (...args) => notifications.push(args),
				select: async () => selections.shift(),
			},
		};
		pstackExtension(pi);

		async function emit(name, event = {}) {
			let result;
			for (const handler of events.get(name) ?? []) {
				const value = await handler({ type: name, ...event }, ctx);
				if (value !== undefined) result = value;
			}
			return result;
		}

		async function command(name, args = "") {
			return commands.get(name).handler(args, ctx);
		}

		async function tool(name, params, signal = new AbortController().signal) {
			return tools.get(name).execute("test-call", params, signal, () => {}, ctx);
		}

		function waitFor(collection, waiters, predicate, label) {
			const existing = collection.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolveWait, rejectWait) => {
				const waiter = {
					predicate,
					resolve(value) {
						clearTimeout(timeout);
						waiters.splice(waiters.indexOf(waiter), 1);
						resolveWait(value);
					},
				};
				const timeout = setTimeout(() => {
					waiters.splice(waiters.indexOf(waiter), 1);
					rejectWait(new Error(`Timed out waiting for ${label}`));
				}, 5_000);
				waiters.push(waiter);
			});
		}

		const waitForMessage = (predicate) => waitFor(messages, messageWaiters, predicate, "message");
		const waitForWidget = (predicate) => waitFor(widgets, widgetWaiters, predicate, "widget");
		return { command, commands, ctx, emit, entries, messages, notifications, selections, sent, statuses, tool, tools, waitForMessage, waitForWidget, widgets };
	}

	const harness = createHarness();
	for (const command of ["poteto-mode", "setup-pstack"]) assert.ok(harness.commands.has(command));
	for (const tool of ["pstack_config", "pstack_sessions", "subagent", "pstack_tasks"]) assert.ok(harness.tools.has(tool));
	assert.match(harness.tools.get("subagent").description, /Default to direct parent work: do not delegate routine implementation phases, compatibility scans, test planning, or post-change review\./);

	await harness.emit("session_start");
	assert.deepEqual(harness.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.pstack, undefined]);
	await harness.command("poteto-mode", "implement fixture");
	assert.deepEqual(harness.entries.at(-1).data, { enabled: true });
	assert.equal(harness.sent.at(-1).text, "implement fixture");
	assert.deepEqual(harness.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.pstack, "🥔 poteto"]);
	const injected = await harness.emit("before_agent_start", { systemPrompt: "base" });
	assert.match(injected.systemPrompt, /Poteto Mode is enabled/);
	assert.match(injected.systemPrompt, /pi-port\.md/);
	assert.equal((await harness.tool("pstack_tasks", { action: "list" })).content[0].text, "No pstack tasks in this session.");

	await harness.command("poteto-mode", "off");
	assert.deepEqual(harness.entries.at(-1).data, { enabled: false });
	assert.deepEqual(harness.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.pstack, undefined]);
	assert.equal(await harness.emit("before_agent_start", { systemPrompt: "base" }), undefined);
	await harness.emit("input", { source: "user", text: "/skill:poteto-mode fix it" });
	assert.deepEqual(harness.entries.at(-1).data, { enabled: true });
	await harness.emit("input", { source: "user", text: "/skill:poteto-mode off" });
	assert.deepEqual(harness.entries.at(-1).data, { enabled: false });
	await harness.emit("input", { source: "user", text: "/skill:poteto-mode implement this\nThen verify it" });
	assert.deepEqual(harness.entries.at(-1).data, { enabled: true });
	await harness.emit("input", { source: "user", text: "/skill:poteto-mode off" });
	await harness.emit("input", { source: "user", text: "/skill:poteto-mode fix it" });
	await harness.emit("session_before_tree");
	await harness.emit("session_tree");
	assert.deepEqual(harness.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.pstack, "🥔 poteto"]);
	await harness.emit("session_shutdown");
	assert.deepEqual(harness.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.pstack, undefined]);
	await harness.emit("session_start");

	harness.selections.push("bounded", "other/reviewer", "medium");
	await harness.command("setup-pstack");
	const config = JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR, "pstack", "models.json"), "utf8"));
	assert.equal(config.version, 2);
	assert.deepEqual(config.routes.bounded, { model: "other/reviewer", thinking: "medium" });
	const listed = await harness.tool("pstack_config", { action: "list-models" });
	assert.match(listed.content[0].text, /test\/model/);
	const sessions = await harness.tool("pstack_sessions", {});
	assert.deepEqual(sessions.details.files, []);
	await assert.rejects(
		harness.tool("pstack_config", { action: "set", route: "bounded", model: "missing/model" }),
		/Unknown Pi model/,
	);
	await Promise.all([
		harness.tool("pstack_config", { action: "set", route: "mechanical", model: "test/model" }),
		harness.tool("pstack_config", { action: "set", route: "critical", model: "other/reviewer", thinking: "xhigh" }),
	]);
	const concurrentConfig = (await harness.tool("pstack_config", { action: "get" })).details;
	assert.equal(concurrentConfig.routes.mechanical.model, "test/model");
	assert.deepEqual(concurrentConfig.routes.critical, { model: "other/reviewer", thinking: "xhigh" });
	async function runBatch(params) {
		const started = await harness.tool("subagent", params);
		assert.match(started.content[0].text, /Started pstack batch .* in the background/);
		const completion = await harness.waitForMessage(({ message }) =>
			message.customType === "pi-extensions-pstack-batch-complete" && message.details.batchId === started.details.batchId,
		);
		return { started, completion };
	}

	await harness.tool("pstack_config", { action: "set", route: "bounded", model: "other/reviewer", thinking: "low" });
	const configured = await runBatch({ agent: "poteto-agent", task: "assert-configured-route", route: "bounded" });
	const configuredTask = await harness.tool("pstack_tasks", { action: "get", id: configured.started.details.taskIds[0] });
	assert.equal(configuredTask.details.result.output, "child:assert-configured-route");
	const resetConfig = (await harness.tool("pstack_config", { action: "reset" })).details;
	assert.equal(resetConfig.routes.mechanical.model, "openai-codex/gpt-5.6-luna");

	const single = await runBatch({
		agent: "poteto-agent",
		task: "assert-policy assert-parent-model assert-parent-thinking assert-readonly",
		readonly: true,
	});
	assert.deepEqual(single.completion.options, { deliverAs: "followUp", triggerTurn: true });
	const singleTask = await harness.tool("pstack_tasks", { action: "get", id: single.started.details.taskIds[0] });
	assert.equal(singleTask.details.status, "completed");
	assert.equal(singleTask.details.result.output, "child:assert-policy assert-parent-model assert-parent-thinking assert-readonly");
	assert.equal(singleTask.details.result.usage.totalTokens, 5);
	assert.match(single.completion.message.content, /Total child usage: ↑2 ↓3/);

	const routed = await runBatch({ agent: "poteto-agent", task: "assert-mechanical-route assert-readonly", route: "mechanical", readonly: true });
	const routedTask = await harness.tool("pstack_tasks", { action: "get", id: routed.started.details.taskIds[0] });
	assert.equal(routedTask.details.result.output, "child:assert-mechanical-route assert-readonly");
	assert.equal(routedTask.details.thinking, "medium");

	const overridden = await runBatch({ agent: "poteto-agent", task: "assert-explicit-model assert-writer", model: "other/reviewer", thinking: "low" });
	const overriddenTask = await harness.tool("pstack_tasks", { action: "get", id: overridden.started.details.taskIds[0] });
	assert.equal(overriddenTask.details.result.output, "child:assert-explicit-model assert-writer");

	const truncated = await runBatch({ agent: "poteto-agent", task: "😀".repeat(6_000) });
	const truncatedTask = await harness.tool("pstack_tasks", { action: "get", id: truncated.started.details.taskIds[0] });
	assert.ok(Buffer.byteLength(truncatedTask.content[0].text, "utf8") < 18_000);
	assert.doesNotMatch(truncatedTask.content[0].text, /�/);
	assert.match(truncatedTask.content[0].text, /Output truncated/);

	await assert.rejects(harness.tool("subagent", { agent: "missing", task: "x" }), /Unknown pstack agent/);
	await assert.rejects(harness.tool("subagent", { agent: "poteto-agent", task: "x", route: "missing" }), /Unknown pstack route/);
	await assert.rejects(harness.tool("subagent", { agent: "poteto-agent", task: "x", model: "missing/model" }), /Unknown Pi model/);
	await assert.rejects(harness.tool("subagent", { agent: "poteto-agent", task: "x", thinking: "absurd" }), /Unknown thinking level/);
	const spawnMarker = join(output, "invalid-batch-spawned");
	await assert.rejects(
		harness.tool("subagent", {
			tasks: [
				{ agent: "poteto-agent", task: `spawn-marker:${spawnMarker}` },
				{ agent: "poteto-agent", task: "invalid model", model: "missing/model" },
			],
		}),
		/Unknown Pi model/,
	);
	await assert.rejects(stat(spawnMarker), /ENOENT/);
	await assert.rejects(
		harness.tool("subagent", { agent: "poteto-agent", task: "x", tasks: [{ agent: "poteto-agent", task: "y" }] }),
		/exactly one subagent mode/,
	);

	const failed = await runBatch({ agent: "poteto-agent", task: "fail-child" });
	const failedTask = await harness.tool("pstack_tasks", { action: "get", id: failed.started.details.taskIds[0] });
	assert.equal(failedTask.details.status, "failed");
	assert.match(failedTask.content[0].text, /fixture failure/);

	const parallel = await runBatch({
		tasks: [
			{ agent: "poteto-agent", task: "one", route: "bounded" },
			{ agent: "comment-sicko", task: "fail-child" },
		],
	});
	assert.match(parallel.completion.message.content, /poteto-agent completed/);
	assert.match(parallel.completion.message.content, /comment-sicko failed/);
	assert.equal(parallel.completion.message.details.status, "failed");
	const parallelList = await harness.tool("pstack_tasks", { action: "list" });
	assert.match(parallelList.content[0].text, new RegExp(`${parallel.started.details.batchId} failed`));

	const descendantMarker = join(output, "descendant.pid");
	const hanging = await harness.tool("subagent", { agent: "poteto-agent", task: `progress hang descendant-marker:${descendantMarker}` });
	assert.match(hanging.content[0].text, /Started pstack batch/);
	await harness.waitForWidget(([key, lines]) =>
		key === "pi-extensions-pstack-tasks" && Array.isArray(lines) && lines.some((line) => line.includes("running read")),
	);
	const hangingTaskId = hanging.details.taskIds[0];
	const running = await harness.tool("pstack_tasks", { action: "get", id: hangingTaskId });
	assert.equal(running.details.status, "running");
	assert.match(running.content[0].text, /running read/);
	await harness.tool("pstack_tasks", { action: "cancel", id: hangingTaskId });
	await harness.waitForMessage(({ message }) =>
		message.customType === "pi-extensions-pstack-batch-complete" && message.details.batchId === hanging.details.batchId,
	);
	const cancelled = await harness.tool("pstack_tasks", { action: "get", id: hangingTaskId });
	assert.equal(cancelled.details.status, "cancelled");
	const descendantPid = Number(await readFile(descendantMarker, "utf8"));
	await new Promise((resolveExit, rejectExit) => {
		const deadline = Date.now() + 5_000;
		const check = () => {
			try {
				process.kill(descendantPid, 0);
				if (Date.now() >= deadline) {
					try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
					rejectExit(new Error(`Descendant ${descendantPid} survived cancellation`));
				} else setTimeout(check, 50);
			} catch {
				resolveExit();
			}
		};
		check();
	});

	const queued = await harness.tool("subagent", {
		tasks: Array.from({ length: 4 }, (_, index) => ({ agent: "poteto-agent", task: `hang ${index}` })),
	});
	await harness.waitForWidget(([key, lines]) =>
		key === "pi-extensions-pstack-tasks" && Array.isArray(lines) && lines[0] === "pstack: 3 running · 1 queued",
	);
	await harness.tool("pstack_tasks", { action: "cancel", id: queued.details.batchId });
	await harness.waitForMessage(({ message }) =>
		message.customType === "pi-extensions-pstack-batch-complete" && message.details.batchId === queued.details.batchId,
	);
	assert.match((await harness.tool("pstack_tasks", { action: "get", id: queued.details.batchId })).content[0].text, /cancelled/);

	const preAborted = new AbortController();
	preAborted.abort();
	await assert.rejects(
		harness.tool("subagent", { agent: "poteto-agent", task: "never starts" }, preAborted.signal),
		/start cancelled/,
	);

	const treeTask = await harness.tool("subagent", { agent: "poteto-agent", task: "hang" });
	await harness.emit("session_before_tree");
	await harness.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
	assert.equal(
		harness.messages.some(({ message }) => message.customType === "pi-extensions-pstack-batch-complete" && message.details.batchId === treeTask.details.batchId),
		false,
	);
	assert.equal((await harness.tool("pstack_tasks", { action: "list" })).content[0].text, "No pstack tasks in this session.");

	const shutdownTask = await harness.tool("subagent", { agent: "poteto-agent", task: "hang" });
	assert.ok(shutdownTask.details.taskIds[0]);
	await harness.emit("session_shutdown");
	const afterShutdown = await harness.tool("pstack_tasks", { action: "list" });
	assert.equal(afterShutdown.content[0].text, "No pstack tasks in this session.");
	await harness.emit("session_start");

	const skillRoot = join(root, "skills", "pstack");
	const skillDirs = (await readdir(skillRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
	assert.equal(skillDirs.length, 14, "curated pstack has 14 skill directories");
	for (const directory of skillDirs) {
		const file = join(skillRoot, directory.name, "SKILL.md");
		const text = await readFile(file, "utf8");
		assert.match(text, /^---\n[\s\S]*?\n---\n/);
		assert.match(text, new RegExp(`^name: ${directory.name}$`, "m"));
		assert.match(text, /^description:\s*.+$/m);
		assert.doesNotMatch(text.match(/^---\n([\s\S]*?)\n---\n/)[1], /^(?:paths|mode|icon|color|reminder):/m);
		assert.match(text, /^disable-model-invocation: true$/m);
	}
	assert.equal(
		createHash("sha256").update(await readFile(join(root, "licenses", "pstack-MIT.txt"))).digest("hex"),
		"bc957ca6bee02792566a1a028d105e02e247c6e77cf057061674273da77b200e",
	);

	const markdownFiles = [];
	async function collect(path) {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const target = join(path, entry.name);
			if (entry.isDirectory()) await collect(target);
			else if (entry.name.endsWith(".md")) markdownFiles.push(target);
		}
	}
	await collect(skillRoot);
	markdownFiles.push(join(root, "PSTACK.md"));
	const whySkill = await readFile(join(skillRoot, "why", "SKILL.md"), "utf8");
	const investigatorPrompt = await readFile(join(skillRoot, "why", "references", "investigator-prompt.md"), "utf8");
	assert.match(whySkill, /Always inspect local source history/);
	assert.match(whySkill, /parent fetches Git and external evidence first/);
	assert.match(investigatorPrompt, /cannot query Git/);
	assert.doesNotMatch(investigatorPrompt, /may inspect local code and Git/i);
	const forbidden = /(subagent_type|run_in_background|is_background|AskQuestion|grok-4|claude-fable|cursor-team-kit|scripts\/(?:orch|watch-pr)|worktree-audit|\.cursor\/)/;
	for (const file of markdownFiles) {
		const text = await readFile(file, "utf8");
		if (!file.endsWith("pi-port.md")) assert.doesNotMatch(text, forbidden, file);
		for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
			const link = match[1].split("#", 1)[0];
			if (!link || ["url", "path"].includes(link) || /^[a-z][a-z+.-]*:/i.test(link) || link.startsWith("/")) continue;
			await assert.doesNotReject(stat(resolve(dirname(file), decodeURIComponent(link))), `${file}: ${link}`);
		}
	}
	await assert.rejects(readdir(join(skillRoot, "poteto-mode", "scripts")), /ENOENT/);

	const readme = await readFile(join(root, "README.md"), "utf8");
	const skillFilter = readme.match(/"skills": \["(skills\/pstack\/\*\*)"\]/)?.[1];
	assert.equal(skillFilter, "skills/pstack/**");
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: join(output, "loader-agent"),
		settingsManager: SettingsManager.inMemory({ packages: [{ source: root, extensions: [], skills: [skillFilter] }] }),
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const loadedSkills = loader.getSkills();
	assert.equal(loadedSkills.diagnostics.length, 0);
	assert.equal(loadedSkills.skills.filter((skill) => skill.filePath.startsWith(skillRoot)).length, 14);

	const smokeAgent = join(output, "smoke-agent");
	await mkdir(smokeAgent, { recursive: true });
	await writeFile(
		join(smokeAgent, "settings.json"),
		JSON.stringify({ packages: ["git:github.com/pi-pstack-tests/definitely-missing"] }),
	);
	const smoke = spawnSync(
		"pi",
		[
			"--no-session",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--extension",
			join(root, "extensions", "pstack", "index.ts"),
			"--skill",
			join(root, "skills", "pstack"),
			"--print",
			"/poteto-mode off",
		],
		{ cwd: root, encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: smokeAgent } },
	);
	assert.equal(smoke.status, 0, `Pi smoke failed:\n${smoke.stdout}\n${smoke.stderr}`);
	assert.doesNotMatch(`${smoke.stdout}\n${smoke.stderr}`, /(?:failed|error).*(?:skill|extension)/i);
	await assert.rejects(stat(join(smokeAgent, "git", "github.com", "pi-pstack-tests", "definitely-missing")), /ENOENT/);

	console.log("pstack tests passed");
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(output, { recursive: true, force: true });
}
