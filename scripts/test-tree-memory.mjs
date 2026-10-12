#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".tree-memory-test-"));

function compile() {
	const run = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["--noEmit", "false", "--rootDir", ".", "--outDir", output], { cwd: root, encoding: "utf8" });
	if (run.status !== 0) throw new Error(`${run.stdout}\n${run.stderr}`.trim());
}

function harness(extension, session, providerReply = { stopReason: "stop", content: [{ type: "text", text: "summary" }], usage: undefined }) {
	const events = new Map();
	const commands = new Map();
	const tools = new Map();
	const notifications = [];
	let providerCalls = 0;
	let maxPromptBytes = 0;
	const providersSeen = [];
	const pi = {
		on(name, handler) { const list = events.get(name) ?? []; list.push(handler); events.set(name, list); },
		registerCommand(name, command) { commands.set(name, command); },
		registerTool(tool) { tools.set(tool.name, tool); },
		appendEntry(type, data) { session.appendCustomEntry(type, structuredClone(data)); },
	};
	const provider = {
		streamSimple(model, context) {
			providerCalls++;
			providersSeen.push(model.provider);
			maxPromptBytes = Math.max(maxPromptBytes, Buffer.byteLength(JSON.stringify(context), "utf8"));
			return {
				async *[Symbol.asyncIterator]() {},
				async result() { return providerReply; },
			};
		},
	};
	const ctx = {
		mode: "print", hasUI: false, cwd: root, sessionManager: session,
		model: { provider: "fixture-a", id: "fixture", contextWindow: 100000 },
		modelRegistry: {
			async getApiKeyAndHeaders() { return { ok: true, apiKey: "fixture" }; },
			getProvider() { return provider; },
		},
		ui: { notify(...args) { notifications.push(args); } },
		signal: undefined,
	};
	extension(pi);
	return {
		commands, tools, notifications, ctx,
		get providerCalls() { return providerCalls; },
		get maxPromptBytes() { return maxPromptBytes; },
		providersSeen,
		async emit(name, event = {}) {
			let result;
			for (const handler of events.get(name) ?? []) {
				const next = await handler(event, ctx);
				if (next !== undefined) result = next;
			}
			return result;
		},
		async command(args) { await commands.get("tree-memory").handler(args, ctx); },
		async tool(name, params) { return tools.get(name).execute("test", params, undefined, undefined, ctx); },
	};
}

try {
	compile();
	const extension = (await import(pathToFileURL(join(output, "extensions/tree-memory/index.js")))).default;
	const core = await import(pathToFileURL(join(output, "extensions/tree-memory/core.js")));

	// Bounded views cover every leaf exactly once; exact pages are UTF-8 byte bounded.
	const manyNodes = new Map();
	for (let n = 1; n <= 256; n *= 2) {
		for (let id = 0; id + n <= 256; id += n) manyNodes.set(core.nodeKey(id, n), { epoch: "unit", id, n, text: `range ${id}+${n} ${"x".repeat(90)}` });
	}
	const bounded = core.buildView(manyNodes, 256);
	assert.ok(core.utf8Bytes(core.renderView(bounded)) <= core.VIEW_BYTES);
	assert.equal(bounded.reduce((sum, node) => sum + node.n, 0), 256);
	for (let index = 1; index < bounded.length; index++) assert.equal(bounded[index - 1].id + bounded[index - 1].n, bounded[index].id);
	const unicodePage = core.bytePage("🙂".repeat(4_000), 0);
	assert.ok(core.utf8Bytes(unicodePage.text) <= 12_000);
	assert.ok(unicodePage.nextOffset > 0);

	const session = SessionManager.inMemory(root);
	session.appendMessage({ role: "user", content: "Remember project Cobalt.", timestamp: 1 });
	session.appendMessage({
		role: "assistant", content: [
			{ type: "thinking", thinking: "PRIVATE_CHAIN", thinkingSignature: "PRIVATE_SIGNATURE" },
			{ type: "text", text: "Decision: launch Friday." },
		], provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2,
	});
	const app = harness(extension, session);
	await app.emit("session_start", { reason: "startup" });
	await app.command("enable");
	assert.match(app.notifications.at(-1)[0], /--backfill/, "existing history requires explicit consent");
	assert.equal(core.latestConfig(session.getBranch()), undefined);
	await app.command("enable --backfill");
	assert.equal(core.latestConfig(session.getBranch()).enabled, true);
	await app.emit("before_agent_start", { prompt: "What did we decide?" });
	const saved = core.snapshot(session.getBranch(), false);
	assert.equal(saved.evidence.length, 2);
	assert.ok(saved.view);
	assert.ok(JSON.stringify(session.getBranch()).includes("PRIVATE_CHAIN"), "Pi originals remain intact");
	assert.ok(saved.evidence.every((entry) => !entry.text.includes("PRIVATE_CHAIN")), "tree evidence excludes hidden reasoning");

	const transformed = await app.emit("context", { messages: [
		{ role: "user", content: "Remember project Cobalt.", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "Decision: launch Friday." }], timestamp: 2 },
		{ role: "user", content: "What did we decide?", timestamp: 3 },
	] });
	assert.equal(transformed.messages.length, 2, "bounded view plus current turn replaces old inference messages");
	assert.match(JSON.stringify(transformed.messages[0].content), /<chat>/);
	assert.match(transformed.messages[1].content, /What did we decide/);
	const zoom = await app.tool("tree_zoom", { id: 1, n: 1, offset: 0 });
	assert.match(zoom.content[0].text, /launch Friday/);
	const seek = await app.tool("tree_seek", { query: "Cobalt launch", limit: 8, cursor: 0 });
	assert.match(seek.content[0].text, /Remember project Cobalt/);
	assert.match(seek.content[0].text, /Decision: launch Friday/);

	const compaction = await app.emit("session_before_compact", { reason: "manual" });
	assert.deepEqual(compaction, { cancel: true });
	await app.command("disable");
	assert.equal(await app.emit("context", { messages: [{ role: "user", content: "native", timestamp: 4 }] }), undefined);
	assert.equal(await app.emit("session_before_compact", { reason: "manual" }), undefined);

	// Persist/reopen proves custom config, nodes, and original Pi messages survive restart.
	const dir = await mkdtemp(join(output, "sessions-"));
	const persisted = SessionManager.create(root, dir, { id: "tree-restart" });
	persisted.appendMessage({ role: "user", content: "restart original", timestamp: 1 });
	const restartApp = harness(extension, persisted);
	await restartApp.emit("session_start", { reason: "startup" });
	await restartApp.command("enable --backfill");
	await restartApp.emit("before_agent_start", { prompt: "current" });
	persisted.appendMessage({ role: "user", content: "current", timestamp: 2 });
	persisted.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 3 });
	assert.equal(core.latestConfig(persisted.getBranch()).phase, "ready");
	const reopened = SessionManager.open(persisted.getSessionFile(), dir);
	assert.equal(core.latestConfig(reopened.getBranch()).phase, "ready");
	const resumed = harness(extension, reopened);
	await resumed.emit("session_start", { reason: "resume" });
	assert.equal((await resumed.tool("tree_memory", { action: "status" })).details.phase, "ready");
	assert.match((await resumed.tool("tree_zoom", { id: 0, n: 1, offset: 0 })).content[0].text, /restart original/);

	// Huge tool/message records are fully covered through bounded compressor pages.
	const pagedSession = SessionManager.inMemory(root);
	pagedSession.appendMessage({ role: "user", content: "z".repeat(50_000), timestamp: 1 });
	const paged = harness(extension, pagedSession);
	await paged.emit("session_start", { reason: "startup" });
	await paged.command("enable --backfill");
	await paged.emit("before_agent_start", { prompt: "current" });
	assert.equal(core.latestConfig(pagedSession.getBranch()).phase, "ready");
	assert.equal(paged.providerCalls, 3);
	assert.ok(paged.maxPromptBytes < 30_000, "compressor source pages stay bounded");
	pagedSession.appendMessage({ role: "user", content: "new provider record ".repeat(50), timestamp: 2 });
	paged.ctx.model = { ...paged.ctx.model, provider: "fixture-b" };
	await paged.emit("before_agent_start", { prompt: "next" });
	assert.equal(paged.providersSeen.at(-1), "fixture-b", "future nodes use the newly selected Pi provider");

	// A failed paid summary never replaces history and never blocks native compaction.
	const failedSession = SessionManager.inMemory(root);
	failedSession.appendMessage({ role: "user", content: "x".repeat(700), timestamp: 1 });
	const failed = harness(extension, failedSession, { stopReason: "stop", content: [{ type: "text", text: "y".repeat(core.NODE_BYTES + 1) }], usage: undefined });
	await failed.emit("session_start", { reason: "startup" });
	await failed.command("enable --backfill");
	await failed.emit("before_agent_start", { prompt: "current" });
	assert.equal(core.latestConfig(failedSession.getBranch()).phase, "error");
	assert.equal(await failed.emit("context", { messages: [{ role: "user", content: "original native", timestamp: 1 }] }), undefined);
	assert.equal(await failed.emit("session_before_compact", { reason: "threshold" }), undefined);
	assert.match(failed.notifications.at(-1)[0], /native context retained/);
	assert.equal(failed.providerCalls, 3, "oversized compressor output gets two corrective retries, then fails visibly");

	// Native in-file branching reconstructs only the selected path.
	const branched = SessionManager.inMemory(root);
	branched.appendMessage({ role: "user", content: "shared fact", timestamp: 1 });
	const branchApp = harness(extension, branched);
	await branchApp.emit("session_start", { reason: "startup" });
	await branchApp.command("enable --backfill");
	await branchApp.emit("before_agent_start", { prompt: "first current" });
	const branchPoint = branched.getLeafId();
	branched.appendMessage({ role: "assistant", content: [{ type: "text", text: "FOREIGN_BRANCH_SECRET" }], provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 3 });
	branched.branch(branchPoint);
	await branchApp.emit("session_tree", {});
	const branchSearch = await branchApp.tool("tree_seek", { query: "FOREIGN_BRANCH_SECRET", limit: 8, cursor: 0 });
	assert.equal(branchSearch.details.matches.length, 0);

	console.log("[tree-memory test] passed");
} finally {
	await rm(output, { recursive: true, force: true });
}
