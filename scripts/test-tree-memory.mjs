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
	const statuses = [];
	const streamOptions = [];
	let providerCalls = 0;
	let maxPromptBytes = 0;
	const modelsSeen = [];
	const authModelsSeen = [];
	const pi = {
		on(name, handler) { const list = events.get(name) ?? []; list.push(handler); events.set(name, list); },
		registerCommand(name, command) { commands.set(name, command); },
		registerTool(tool) { tools.set(tool.name, tool); },
		appendEntry(type, data) { session.appendCustomEntry(type, structuredClone(data)); },
	};
	const provider = {
		streamSimple(model, context, options) {
			streamOptions.push(options);
			providerCalls++;
			modelsSeen.push(`${model.provider}/${model.id}`);
			maxPromptBytes = Math.max(maxPromptBytes, Buffer.byteLength(JSON.stringify(context), "utf8"));
			return {
				async *[Symbol.asyncIterator]() {},
				async result() { return typeof providerReply === "function" ? providerReply(context, providerCalls) : providerReply; },
			};
		},
	};
	const ctx = {
		mode: "print", hasUI: false, cwd: root, sessionManager: session,
		model: { provider: "fixture-a", id: "fixture", contextWindow: 100000 },
		modelRegistry: {
			find(provider, id) {
				if ((provider === "openai-codex" && id === "gpt-6-luna") || (["fixture-a", "fixture-b"].includes(provider) && id === "fixture")) {
					return { provider, id, contextWindow: 100000 };
				}
			},
			async getApiKeyAndHeaders(model) { authModelsSeen.push(`${model.provider}/${model.id}`); return { ok: true, apiKey: "fixture" }; },
			getProvider() { return provider; },
		},
		ui: { notify(...args) { notifications.push(args); }, setStatus(...args) { statuses.push(args); } },
		signal: undefined,
	};
	extension(pi);
	return {
		commands, tools, notifications, statuses, streamOptions, ctx,
		get providerCalls() { return providerCalls; },
		get maxPromptBytes() { return maxPromptBytes; },
		modelsSeen, authModelsSeen,
		async emit(name, event = {}) {
			let result;
			for (const handler of events.get(name) ?? []) {
				const next = await handler(event, ctx);
				if (next !== undefined) result = next;
			}
			return result;
		},
		async start() { await this.emit("before_agent_start"); return this.emit("agent_start"); },
		async command(args) { await commands.get("tree-memory").handler(args, ctx); },
		async tool(name, params, signal, onUpdate) { return tools.get(name).execute("test", params, signal, onUpdate, ctx); },
	};
}

try {
	compile();
	const extension = (await import(pathToFileURL(join(output, "extensions/tree-memory/index.js")))).default;
	const core = await import(pathToFileURL(join(output, "extensions/tree-memory/core.js")));

	// Preflight is immediate; every mode awaits the same completed view before inference.
	for (const mode of ["interactive", "rpc", "print"]) {
		const startupSession = SessionManager.inMemory(root);
		const startupOriginal = { role: "user", content: "saved fact", timestamp: 1 };
		const startupId = startupSession.appendMessage(startupOriginal);
		const pendingMessage = { role: "user", content: "pending fact ".repeat(100), timestamp: 2 };
		startupSession.appendMessage(pendingMessage);
		startupSession.appendCustomEntry(core.CONFIG_ENTRY, { epoch: "startup", enabled: true, phase: "ready", backfill: true, createdAt: new Date().toISOString() });
		startupSession.appendCustomEntry(core.NODE_ENTRY, { epoch: "startup", id: 0, n: 1, text: "saved fact", sourceEntryId: startupId });
		let releaseStartup;
		const startupGate = new Promise(resolve => { releaseStartup = resolve; });
		const startup = harness(extension, startupSession, () => startupGate);
		startup.ctx.mode = mode;
		await startup.emit("session_start", { reason: "resume" });
		await startup.emit("before_agent_start", { prompt: "current" });
		assert.equal(startup.providerCalls, 0, "compression must start after preflight");
		let prepared = false;
		const startupRun = startup.emit("agent_start").then(() => { prepared = true; });
		try {
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(prepared, false, `${mode} inference must wait for compression`);
			assert.equal(startup.providerCalls, 1);
			releaseStartup({ stopReason: "stop", content: [{ type: "text", text: "pending summary" }] });
			await startupRun;
			const native = [startupOriginal, pendingMessage, { role: "user", content: "current", timestamp: 3 }];
			const frozen = await startup.emit("context", { messages: native });
			assert.match(JSON.stringify(frozen.messages[0]), /1\+1\|pending summary/);
			assert.deepEqual(frozen.messages.slice(1), native.slice(2), "first inference uses completed summaries and the current prompt");
			assert.deepEqual(await startup.emit("context", { messages: native }), frozen, "view stays identical throughout the tool loop");
			startupSession.appendMessage(native.at(-1));
			await startup.emit("agent_start");
			assert.deepEqual(await startup.emit("context", { messages: native }), frozen, "continuation/retry cannot rebuild the frozen view");
			assert.equal(core.collectNodes(startupSession.getBranch(), "startup").has("2+1"), false, "only a new submitted prompt starts automatic preparation");
		} finally {
			releaseStartup({ stopReason: "stop", content: [{ type: "text", text: "cleanup" }] });
			await startupRun;
		}
	}

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
	const disabledEntries = structuredClone(session.getBranch());
	assert.equal((await app.tool("tree_memory", { action: "retry" })).isError, true, "retry tool must reject disabled memory");
	assert.deepEqual(session.getBranch(), disabledEntries, "retry never enables or backfills a disabled session");
	assert.equal(app.providerCalls, 0);
	await app.command("enable");
	assert.match(app.notifications.at(-1)[0], /--backfill/, "existing history requires explicit consent");
	assert.equal(core.latestConfig(session.getBranch()), undefined);
	await app.command("enable --backfill");
	assert.equal(core.latestConfig(session.getBranch()).enabled, true);
	await app.start();
	const saved = core.snapshot(session.getBranch(), false);
	assert.equal(saved.evidence.length, 2);
	assert.ok(saved.view);
	assert.ok(JSON.stringify(session.getBranch()).includes("PRIVATE_CHAIN"), "Pi originals remain intact");
	assert.ok(saved.evidence.every((entry) => !entry.text.includes("PRIVATE_CHAIN")), "tree evidence excludes hidden reasoning");

	assert.equal((await app.tool("tree_memory", { action: "status" })).details.phase, "ready");
	const transformed = await app.emit("context", { messages: [
		{ role: "user", content: "Remember project Cobalt.", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "Decision: launch Friday." }], timestamp: 2 },
		{ role: "user", content: "What did we decide?", timestamp: 3 },
	] });
	assert.equal(transformed.messages.length, 2, "status must preserve the bounded view for subsequent tool-loop requests");
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
	await restartApp.command("model fixture-b/fixture");
	assert.equal(core.latestConfig(persisted.getBranch()).enabled, false, "selecting a compressor does not enable or backfill memory");
	await restartApp.command("enable --backfill");
	await restartApp.start();
	persisted.appendMessage({ role: "user", content: "current", timestamp: 2 });
	persisted.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 3 });
	assert.equal(core.latestConfig(persisted.getBranch()).phase, "ready");
	const reopened = SessionManager.open(persisted.getSessionFile(), dir);
	assert.equal(core.latestConfig(reopened.getBranch()).phase, "ready");
	const resumed = harness(extension, reopened);
	await resumed.emit("session_start", { reason: "resume" });
	const resumedStatus = (await resumed.tool("tree_memory", { action: "status" })).details;
	assert.equal(resumedStatus.phase, "ready");
	assert.equal(resumedStatus.compressor, "fixture-b/fixture", "compressor selection survives reopen");
	assert.match((await resumed.tool("tree_zoom", { id: 0, n: 1, offset: 0 })).content[0].text, /restart original/);

	// Huge tool/message records are fully covered through bounded compressor pages.
	const pagedSession = SessionManager.inMemory(root);
	pagedSession.appendMessage({ role: "user", content: "z".repeat(50_000), timestamp: 1 });
	const paged = harness(extension, pagedSession);
	await paged.emit("session_start", { reason: "startup" });
	await paged.command("enable --backfill");
	await paged.start();
	assert.equal(core.latestConfig(pagedSession.getBranch()).phase, "ready");
	assert.equal(paged.providerCalls, 3);
	assert.ok(paged.modelsSeen.every(model => model === core.DEFAULT_COMPRESSOR), "default cheap compressor, not main agent model");
	assert.deepEqual(paged.authModelsSeen, paged.modelsSeen, "credentials resolve for the compressor model");
	assert.ok(paged.maxPromptBytes < 30_000, "compressor source pages stay bounded");
	pagedSession.appendMessage({ role: "user", content: "new provider record ".repeat(50), timestamp: 2 });
	paged.ctx.model = { ...paged.ctx.model, provider: "fixture-b" };
	await paged.start();
	assert.equal(paged.modelsSeen.at(-1), core.DEFAULT_COMPRESSOR, "agent provider switching must not switch the compressor");
	const previousNodes = core.collectNodes(pagedSession.getBranch(), core.latestConfig(pagedSession.getBranch()).epoch);
	await paged.command("model fixture-b/fixture");
	pagedSession.appendMessage({ role: "user", content: "custom compressor record ".repeat(50), timestamp: 3 });
	await paged.start();
	assert.equal(paged.modelsSeen.at(-1), "fixture-b/fixture");
	assert.equal(paged.authModelsSeen.at(-1), "fixture-b/fixture");
	const changedNodes = core.collectNodes(pagedSession.getBranch(), core.latestConfig(pagedSession.getBranch()).epoch);
	for (const [key, node] of previousNodes) assert.deepEqual(changedNodes.get(key), node, "changing compressor preserves existing summaries");
	await paged.command("model missing/model");
	assert.equal(core.latestConfig(pagedSession.getBranch()).compressor, "fixture-b/fixture", "reject unknown compressor without changing selection");

	const unavailableSession = SessionManager.inMemory(root);
	unavailableSession.appendMessage({ role: "user", content: "x".repeat(700), timestamp: 1 });
	const unavailable = harness(extension, unavailableSession);
	await unavailable.emit("session_start", { reason: "startup" });
	await unavailable.command("enable --backfill");
	unavailable.ctx.modelRegistry.find = () => undefined;
	await unavailable.start();
	assert.equal(core.latestConfig(unavailableSession.getBranch()).phase, "error");
	assert.equal(unavailable.providerCalls, 0, "missing compressor never falls back to paid main model");
	assert.equal(await unavailable.emit("context", { messages: [] }), undefined);
	assert.equal(await unavailable.emit("session_before_compact", {}), undefined);
	assert.match(unavailable.notifications.at(-1)[0], /compressor.*unavailable/);

	// Oversized replies need the actual draft plus a smaller target, not another copy of the same source request.
	const correctedSession = SessionManager.inMemory(root);
	correctedSession.appendMessage({ role: "user", content: "detailed request ".repeat(100), timestamp: 1 });
	const draft = "oversized summary ".repeat(40).trim();
	const corrected = harness(extension, correctedSession, (context, call) => {
		if (call === 1) return { stopReason: "stop", content: [{ type: "text", text: draft }] };
		assert.equal(context.messages.length, 2, "length correction must be a distinct follow-up instruction");
		const correction = context.messages[1].content[0].text;
		assert.ok(correction.includes(draft), "show the previous summary for rewriting");
		assert.match(correction, /at most 256 UTF-8 bytes/);
		assert.match(correction, /Length wins over completeness/);
		return { stopReason: "stop", content: [{ type: "text", text: "User requests implementation; preserve originals." }] };
	});
	await corrected.emit("session_start", { reason: "startup" });
	await corrected.command("enable --backfill");
	await corrected.start();
	assert.equal(corrected.providerCalls, 2);
	assert.equal(core.latestConfig(correctedSession.getBranch()).phase, "ready");

	// A failed paid summary never replaces history and never blocks native compaction.
	const failedSession = SessionManager.inMemory(root);
	failedSession.appendMessage({ role: "user", content: "x".repeat(700), timestamp: 1 });
	const failed = harness(extension, failedSession, { stopReason: "stop", content: [{ type: "text", text: "y".repeat(core.NODE_BYTES + 1) }], usage: undefined });
	await failed.emit("session_start", { reason: "startup" });
	await failed.command("enable --backfill");
	await failed.start();
	assert.equal(core.latestConfig(failedSession.getBranch()).phase, "error");
	assert.equal(await failed.emit("context", { messages: [{ role: "user", content: "original native", timestamp: 1 }] }), undefined);
	assert.equal(await failed.emit("session_before_compact", { reason: "threshold" }), undefined);
	assert.match(failed.notifications.at(-1)[0], /native context retained/);
	assert.equal(failed.providerCalls, 3, "oversized compressor output gets two corrective retries, then fails visibly");
	assert.match(core.latestConfig(failedSession.getBranch()).error, /0\+1.*shortest=513 bytes, last=513 bytes.*paused/);
	await failed.start();
	assert.equal(failed.providerCalls, 3, "ordinary messages must not restart paid compression after failure");
	const paused = harness(extension, failedSession);
	await paused.emit("session_start", { reason: "resume" });
	await paused.start();
	assert.equal(paused.providerCalls, 0, "pause survives extension reload/resume");
	await paused.command("retry");
	assert.equal(paused.providerCalls, 1, "explicit retry resumes compression");
	assert.equal(core.latestConfig(failedSession.getBranch()).phase, "ready");

	// RPC retry must acknowledge while the compressor is still blocked, preserving prior nodes.
	const backgroundSession = SessionManager.inMemory(root);
	const originalId = backgroundSession.appendMessage({ role: "user", content: "already summarized", timestamp: 1 });
	backgroundSession.appendMessage({ role: "user", content: "background record ".repeat(100), timestamp: 2 });
	backgroundSession.appendCustomEntry(core.CONFIG_ENTRY, { epoch: "background", enabled: true, phase: "error", error: "old failure", backfill: true, createdAt: new Date().toISOString() });
	const originalNode = { epoch: "background", id: 0, n: 1, text: "already summarized", sourceEntryId: originalId };
	backgroundSession.appendCustomEntry(core.NODE_ENTRY, originalNode);
	let release;
	const blockedReply = new Promise(resolve => { release = resolve; });
	const background = harness(extension, backgroundSession, () => blockedReply);
	background.ctx.mode = "rpc";
	await background.emit("session_start", { reason: "resume" });
	const retry = background.command("retry");
	let deadline;
	const acknowledged = await Promise.race([
		retry.then(() => true),
		new Promise(resolve => { deadline = setTimeout(() => resolve(false), 500); }),
	]);
	clearTimeout(deadline);
	let acceptedRun;
	try {
		assert.equal(acknowledged, true, "RPC retry must return before the compressor finishes");
		const running = (await background.tool("tree_memory", { action: "status" })).details;
		assert.equal(running.phase, "building");
		assert.equal(running.error, null, "do not show the old error as an active failure");
		assert.deepEqual(running.progress, { completed: 1, total: 3, range: "1+1" });
		await background.command("retry");
		assert.equal(background.providerCalls, 1, "a second retry cannot launch a competing build");
		await background.emit("before_agent_start", { prompt: "current" });
		acceptedRun = background.start();
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(background.providerCalls, 1, "accepted run joins the existing build");
		assert.equal(await background.emit("context", { messages: [] }), undefined, "no partial history replacement");
	} finally {
		release({ stopReason: "stop", content: [{ type: "text", text: "background summary" }] });
		await retry;
		await acceptedRun;
	}
	for (let attempts = 0; (await background.tool("tree_memory", { action: "status" })).details.phase === "building"; attempts++) {
		assert.ok(attempts < 100, "background build did not settle");
		await new Promise(resolve => setImmediate(resolve));
	}
	assert.equal(core.latestConfig(backgroundSession.getBranch()).phase, "ready");
	assert.deepEqual(core.collectNodes(backgroundSession.getBranch(), "background").get("0+1"), originalNode);
	assert.match(JSON.stringify(await background.emit("context", { messages: [] })), /background summary/, "accepted run freezes the completed retry before inference");
	await background.start();
	const nextView = await background.emit("context", { messages: [{ role: "user", content: "next", timestamp: 3 }] });
	assert.match(JSON.stringify(nextView.messages[0]), /Historical memory/);
	assert.ok(background.statuses.some(([, text]) => /1\/3/.test(text)), "report live node progress");
	await background.command("status");
	assert.deepEqual(await background.emit("context", { messages: [{ role: "user", content: "next", timestamp: 3 }] }), nextView, "status command must preserve the frozen turn");
	backgroundSession.appendMessage({ role: "user", content: "new incremental record ".repeat(100), timestamp: 3 });
	await background.start();
	const caughtUp = await background.emit("context", { messages: [{ role: "user", content: "later", timestamp: 4 }] });
	assert.match(JSON.stringify(caughtUp.messages[0]), /2\+1\|background summary/, "ordinary turn preparation must catch up, not leave memory perpetually one turn behind");
	assert.equal(background.providerCalls, 2);

	// Cancelled automatic builds cannot write into a disabled session or another branch.
	for (const action of ["disable", "session_tree", "session_shutdown"]) {
		const cancelSession = SessionManager.inMemory(root);
		cancelSession.appendMessage({ role: "user", content: "shared fact", timestamp: 1 });
		let unblock;
		const reply = new Promise(resolve => { unblock = resolve; });
		const cancellable = harness(extension, cancelSession, () => reply);
		cancellable.ctx.mode = "rpc";
		await cancellable.emit("session_start", { reason: "startup" });
		await cancellable.command("enable --backfill");
		const branchPoint = cancelSession.getLeafId();
		cancelSession.appendMessage({ role: "user", content: "pending record ".repeat(100), timestamp: 2 });
		const start = cancellable.start();
		try {
			await cancellable.emit("before_agent_start", { prompt: "current" });
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(cancellable.providerCalls, 1);
			if (action === "disable") await cancellable.command("disable");
			else {
				if (action === "session_tree") cancelSession.branch(branchPoint);
				await cancellable.emit(action);
			}
			assert.equal(cancellable.streamOptions[0].signal.aborted, true);
			const cancelledEntries = structuredClone(cancelSession.getBranch());
			unblock({ stopReason: "stop", content: [{ type: "text", text: "late reply must not be saved" }] });
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(cancelSession.getBranch(), cancelledEntries, `no late writes after ${action}`);
			assert.equal(cancellable.statuses.at(-1)[1], undefined);
		} finally {
			unblock({ stopReason: "stop", content: [{ type: "text", text: "cleanup" }] });
			await start;
		}
	}

	// Retry as a normal tool waits for completion, streams updates and accounts only new usage.
	const toolSession = SessionManager.inMemory(root);
	const toolOriginalId = toolSession.appendMessage({ role: "user", content: "saved original", timestamp: 1 });
	toolSession.appendMessage({ role: "user", content: "tool retry record ".repeat(100), timestamp: 2 });
	toolSession.appendCustomEntry(core.CONFIG_ENTRY, { epoch: "tool", enabled: true, phase: "error", error: "old failure", backfill: true, createdAt: new Date().toISOString() });
	const toolNode = { epoch: "tool", id: 0, n: 1, text: "saved original", sourceEntryId: toolOriginalId };
	toolSession.appendCustomEntry(core.NODE_ENTRY, toolNode);
	let releaseTool;
	const toolGate = new Promise(resolve => { releaseTool = resolve; });
	const retryTool = harness(extension, toolSession, () => toolGate);
	await retryTool.emit("session_start", { reason: "resume" });
	const updates = [];
	const toolRun = retryTool.tool("tree_memory", { action: "retry" }, undefined, update => updates.push(update));
	await new Promise(resolve => setImmediate(resolve));
	const duringTool = structuredClone(toolSession.getBranch());
	const runningToolStatus = await retryTool.tool("tree_memory", { action: "status" });
	assert.equal(runningToolStatus.details.phase, "building");
	assert.deepEqual(toolSession.getBranch(), duringTool, "status stays read-only during retry");
	assert.ok(updates.some(update => update.details.progress.range === "1+1" && update.details.progress.completed === 1));
	assert.equal((await retryTool.tool("tree_memory", { action: "retry" })).isError, true, "no competing retry tool");
	assert.equal(retryTool.providerCalls, 1);
	const newUsage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
	releaseTool({ stopReason: "stop", content: [{ type: "text", text: "retried summary" }], usage: newUsage });
	const toolResult = await toolRun;
	assert.equal(toolResult.isError, false);
	assert.equal(toolResult.details.phase, "ready");
	assert.equal(toolResult.details.nodes, 3);
	assert.deepEqual(toolResult.usage, newUsage);
	assert.equal(updates.at(-1).details.progress.completed, 3);
	assert.deepEqual(core.collectNodes(toolSession.getBranch(), "tool").get("0+1"), toolNode);

	// Tool cancellation and compressor failures return errors, without silently enabling or restarting.
	for (const abort of [true, false]) {
		const errorSession = SessionManager.inMemory(root);
		errorSession.appendMessage({ role: "user", content: "error record ".repeat(100), timestamp: 1 });
		errorSession.appendCustomEntry(core.CONFIG_ENTRY, { epoch: "tool-error", enabled: true, phase: "error", error: "prior error", backfill: true, createdAt: new Date().toISOString() });
		let finish;
		const errorGate = new Promise(resolve => { finish = resolve; });
		const errorTool = harness(extension, errorSession, () => errorGate);
		await errorTool.emit("session_start", { reason: "resume" });
		const controller = new AbortController();
		const pendingTool = errorTool.tool("tree_memory", { action: "retry" }, controller.signal);
		await new Promise(resolve => setImmediate(resolve));
		if (abort) controller.abort();
		finish({ stopReason: "error", errorMessage: "WebSocket closed 1000", content: [], usage: newUsage });
		const errorResult = await pendingTool;
		assert.equal(errorResult.isError, true);
		assert.match(errorResult.details.error, abort ? /cancelled/ : /WebSocket closed 1000/);
		assert.deepEqual(errorResult.usage, newUsage, "report paid failed/aborted response usage too");
		assert.equal(core.collectNodes(errorSession.getBranch(), "tool-error").size, 0, "do not save a failed or cancelled summary");
		await errorTool.start();
		assert.equal(errorTool.providerCalls, 1, "failed tool retry stays paused");
	}

	// Native in-file branching reconstructs only the selected path.
	const branched = SessionManager.inMemory(root);
	branched.appendMessage({ role: "user", content: "shared fact", timestamp: 1 });
	const branchApp = harness(extension, branched);
	await branchApp.emit("session_start", { reason: "startup" });
	await branchApp.command("enable --backfill");
	await branchApp.start();
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
