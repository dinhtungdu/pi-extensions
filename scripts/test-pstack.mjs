#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
		!prompt.includes("never mutate it") ||
		!prompt.includes("pi-port.md") ||
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
	const toolsIndex = process.argv.indexOf("--tools");
	if (task.includes("assert-readonly") && process.argv[toolsIndex + 1] !== "read,grep,find,ls") {
		console.error("readonly tools not enforced");
		process.exit(6);
	}
	if (task.includes("assert-parent-model") && process.argv[modelIndex + 1] !== "test/model") {
		console.error("parent model not inherited");
		process.exit(4);
	}
	if (task.includes("assert-auto-model") && modelIndex >= 0) {
		console.error("auto model should omit override");
		process.exit(5);
	}
	if (task.includes("hang")) {
		setInterval(() => {}, 1_000);
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
	const { default: pstackExtension, latestPotetoMode, PSTACK_ROLE_NAMES } = await import(
		pathToFileURL(join(output, "extensions", "pstack", "index.js"))
	);
	assert.equal(PSTACK_ROLE_NAMES.length, 17);
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
		const statuses = [];
		const notifications = [];
		const selections = [];
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
			appendEntry(customType, data) {
				entries.push({ type: "custom", customType, data });
			},
			sendUserMessage(text, options) {
				sent.push({ text, options });
			},
		};
		const ctx = {
			cwd: root,
			hasUI: true,
			model: { provider: "test", id: "model" },
			scopedModels: [],
			modelRegistry: {
				getAvailable: () => [{ provider: "test", id: "model" }, { provider: "other", id: "reviewer" }],
			},
			sessionManager: { getBranch: () => entries },
			isIdle: () => true,
			ui: {
				setStatus: (...args) => statuses.push(args),
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

		return { command, commands, ctx, emit, entries, notifications, selections, sent, statuses, tool, tools };
	}

	const harness = createHarness();
	for (const command of ["poteto-mode", "setup-pstack"]) assert.ok(harness.commands.has(command));
	for (const tool of ["pstack_config", "pstack_sessions", "subagent"]) assert.ok(harness.tools.has(tool));

	await harness.emit("session_start");
	assert.deepEqual(harness.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.pstack, undefined]);
	await harness.command("poteto-mode", "implement fixture");
	assert.deepEqual(harness.entries.at(-1).data, { enabled: true });
	assert.equal(harness.sent.at(-1).text, "implement fixture");
	assert.deepEqual(harness.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.pstack, "🥔 poteto"]);
	const injected = await harness.emit("before_agent_start", { systemPrompt: "base" });
	assert.match(injected.systemPrompt, /Poteto Mode is enabled/);
	assert.match(injected.systemPrompt, /pi-port\.md/);

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
	await harness.emit("session_tree");
	assert.deepEqual(harness.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.pstack, "🥔 poteto"]);
	await harness.emit("session_shutdown");
	assert.deepEqual(harness.statuses.at(-1), [PACKAGE_FOOTER_STATUS_KEYS.pstack, undefined]);

	harness.selections.push("bug-fix", "other/reviewer");
	await harness.command("setup-pstack");
	const config = JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR, "pstack", "models.json"), "utf8"));
	assert.equal(config.roles["bug-fix"], "other/reviewer");
	const listed = await harness.tool("pstack_config", { action: "list-models" });
	assert.match(listed.content[0].text, /test\/model/);
	const sessions = await harness.tool("pstack_sessions", {});
	assert.deepEqual(sessions.details.files, []);
	await assert.rejects(
		harness.tool("pstack_config", { action: "set", role: "bug-fix", model: "missing/model" }),
		/Unknown Pi model/,
	);
	await Promise.all([
		harness.tool("pstack_config", { action: "set", role: "bug-fix", model: "test/model" }),
		harness.tool("pstack_config", { action: "set", role: "perf-issue", model: "other/reviewer" }),
	]);
	const concurrentConfig = (await harness.tool("pstack_config", { action: "get" })).details;
	assert.equal(concurrentConfig.roles["bug-fix"], "test/model");
	assert.equal(concurrentConfig.roles["perf-issue"], "other/reviewer");
	await harness.tool("pstack_config", { action: "reset" });

	const single = await harness.tool("subagent", {
		agent: "poteto-agent",
		task: "assert-policy assert-parent-model assert-readonly",
		readonly: true,
	});
	assert.equal(single.content[0].text, "child:assert-policy assert-parent-model assert-readonly");
	assert.equal(
		(await harness.tool("subagent", { agent: "poteto-agent", task: "assert-auto-model", model: "auto" })).content[0].text,
		"child:assert-auto-model",
	);
	assert.equal(single.usage.totalTokens, 5);
	const truncated = await harness.tool("subagent", { agent: "poteto-agent", task: "😀".repeat(20_000) });
	assert.ok(Buffer.byteLength(truncated.content[0].text, "utf8") < 52_000);
	assert.doesNotMatch(truncated.content[0].text, /�/);
	assert.match(truncated.content[0].text, /Output truncated/);
	await assert.rejects(harness.tool("subagent", { agent: "missing", task: "x" }), /Unknown pstack agent/);
	await assert.rejects(harness.tool("subagent", { agent: "poteto-agent", task: "x", role: "missing" }), /Unknown pstack role/);
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
	await assert.rejects(harness.tool("subagent", { agent: "poteto-agent", task: "fail-child" }), /fixture failure/);

	const parallel = await harness.tool("subagent", {
		tasks: [
			{ agent: "poteto-agent", task: "one", role: "swarm workers" },
			{ agent: "comment-sicko", task: "fail-child" },
		],
	});
	assert.match(parallel.content[0].text, /poteto-agent completed/);
	assert.match(parallel.content[0].text, /comment-sicko failed/);
	assert.equal(parallel.details.results.length, 2);
	assert.equal(parallel.usage.totalTokens, 10);

	const controller = new AbortController();
	const cancellation = harness.tool("subagent", { agent: "poteto-agent", task: "hang" }, controller.signal);
	setImmediate(() => controller.abort());
	await assert.rejects(cancellation, /Subagent failed/);
	const parallelController = new AbortController();
	const parallelCancellation = harness.tool(
		"subagent",
		{ tasks: [{ agent: "poteto-agent", task: "hang" }, { agent: "poteto-agent", task: "hang" }] },
		parallelController.signal,
	);
	setImmediate(() => parallelController.abort());
	await assert.rejects(parallelCancellation, /parallel run cancelled/);

	const skillRoot = join(root, "skills", "pstack");
	const skillDirs = (await readdir(skillRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
	assert.equal(skillDirs.length, 47, "current upstream has 47 skill directories");
	for (const directory of skillDirs) {
		const file = join(skillRoot, directory.name, "SKILL.md");
		const text = await readFile(file, "utf8");
		assert.match(text, /^---\n[\s\S]*?\n---\n/);
		assert.match(text, new RegExp(`^name: ${directory.name}$`, "m"));
		assert.match(text, /^description:\s*.+$/m);
		assert.doesNotMatch(text.match(/^---\n([\s\S]*?)\n---\n/)[1], /^(?:paths|mode|icon|color|reminder):/m);
		if (directory.name === "setup-pstack") assert.doesNotMatch(text, /^disable-model-invocation:/m);
		else assert.match(text, /^disable-model-invocation: true$/m);
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
	assert.match(whySkill, /parent gathers Git history and diffs/);
	assert.match(whySkill, /Pass all fetched Git and external evidence/);
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
	assert.equal(loadedSkills.skills.filter((skill) => skill.filePath.startsWith(skillRoot)).length, 47);

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
