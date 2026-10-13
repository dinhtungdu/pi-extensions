#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const temp = await mkdtemp(join(tmpdir(), "pi-tree-memory-"));
const session = join(temp, "session.jsonl");
const requests = join(temp, "requests.jsonl");
const now = new Date().toISOString();
const text = (value) => [{ type: "text", text: value }];
const entries = [
	{ type: "session", version: 3, id: "tree-smoke", timestamp: now, cwd: root },
	{ type: "model_change", id: "a0000000", parentId: null, timestamp: now, provider: "tree-fixture", modelId: "tree-fixture" },
	{ type: "message", id: "b0000000", parentId: "a0000000", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: text("Remember project Cobalt."), timestamp: 1 } },
	{ type: "message", id: "c0000000", parentId: "b0000000", timestamp: "2026-01-02T00:00:00.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_CHAIN", thinkingSignature: "PRIVATE_SIGNATURE" }, { type: "text", text: "Decision: launch Friday." }], provider: "tree-fixture", model: "tree-fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 } },
	{ type: "custom", id: "d0000000", parentId: "c0000000", timestamp: now, customType: "pi-extensions-tree-memory-config-v1", data: { epoch: "smoke-epoch", enabled: true, phase: "ready", backfill: true, createdAt: now } },
	{ type: "custom", id: "e0000000", parentId: "d0000000", timestamp: now, customType: "pi-extensions-tree-memory-node-v1", data: { epoch: "smoke-epoch", id: 0, n: 1, text: "user: Remember project Cobalt.", sourceEntryId: "b0000000", date: "2026-01-01T00:00:00.000Z" } },
	{ type: "custom", id: "f0000000", parentId: "e0000000", timestamp: now, customType: "pi-extensions-tree-memory-node-v1", data: { epoch: "smoke-epoch", id: 1, n: 1, text: "assistant: Decision: launch Friday.", sourceEntryId: "c0000000", date: "2026-01-02T00:00:00.000Z" } },
	{ type: "custom", id: "a1111111", parentId: "f0000000", timestamp: now, customType: "pi-extensions-tree-memory-node-v1", data: { epoch: "smoke-epoch", id: 0, n: 2, text: "Cobalt decision: launch Friday." } },
];

try {
	await writeFile(session, `${entries.map(JSON.stringify).join("\n")}\n`);
	await writeFile(requests, "");
	const globalPrefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim();
	const globalPi = join(globalPrefix, "bin", "pi");
	const fauxModule = pathToFileURL(join(globalPrefix, "lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/faux.js")).href;
	const run = spawnSync(process.env.PI_BIN ?? globalPi, [
		"-ne", "-ns", "-np", "--no-themes", "--no-mcp", "-nc",
		"-e", join(root, "scripts/fixtures/tree-memory-provider.ts"),
		"-e", join(root, "extensions/tree-memory/index.ts"),
		"--session", session, "--model", "tree-fixture/tree-fixture", "--print", "What did we decide?",
	], { cwd: root, encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1", TREE_SMOKE_LOG: requests, TREE_FAUX_MODULE: process.env.TREE_FAUX_MODULE ?? fauxModule } });
	assert.equal(run.status, 0, run.stderr || run.stdout);
	assert.match(run.stdout, /RECALL_OK/);
	const calls = (await readFile(requests, "utf8")).trim().split("\n");
	assert.equal(calls.length, 3);
	assert.ok(calls.every((call) => call.includes("Historical memory")));
	assert.ok(calls.every((call) => !call.includes("PRIVATE_CHAIN")), "hidden reasoning leaked into inference context");
	assert.match(calls[1], /"toolName":"tree_seek"/);
	assert.match(calls[2], /"toolName":"tree_zoom"/);
	console.log("[tree-memory real Pi smoke] passed");

	// Real RPC preflight must return while a compressor request is still pending.
	const backgroundSession = join(temp, "background.jsonl");
	const backgroundEntries = structuredClone(entries.slice(0, 6));
	backgroundEntries[3].message.content = text("long record ".repeat(100));
	backgroundEntries[4].data.phase = "error";
	backgroundEntries[4].data.error = "old error";
	backgroundEntries[4].data.compressor = "tree-compressor/compressor";
	await writeFile(backgroundSession, `${backgroundEntries.map(JSON.stringify).join("\n")}\n`);
	let gateResponse;
	let requestStarted;
	let started = new Promise(resolve => { requestStarted = resolve; });
	const gate = createServer((_request, response) => {
		gateResponse = response;
		requestStarted();
	});
	await new Promise(resolve => gate.listen(0, "127.0.0.1", resolve));
	const { RpcClient } = await import(pathToFileURL(join(globalPrefix, "lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js")));
	const client = new RpcClient({
		cliPath: await realpath(process.env.PI_BIN ?? globalPi), cwd: root,
		args: ["-ne", "-ns", "-np", "--no-themes", "--no-mcp", "-nc", "-e", join(root, "scripts/fixtures/tree-memory-provider.ts"), "-e", join(root, "extensions/tree-memory/index.ts"), "--session", backgroundSession, "--model", "tree-fixture/tree-fixture"],
		env: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(temp, "agent"), TREE_FAUX_MODULE: process.env.TREE_FAUX_MODULE ?? fauxModule, TREE_SMOKE_GATE_URL: `http://127.0.0.1:${gate.address().port}`, TREE_SMOKE_RETRY_TOOL: "1" },
	});
	const events = [];
	let markReady;
	let markSettled;
	const ready = new Promise(resolve => { markReady = resolve; });
	const unsubscribe = client.onEvent(event => {
		events.push(event);
		if (event.type === "agent_settled") markSettled?.();
		if (event.type === "extension_ui_request" && event.method === "notify" && event.message?.startsWith("Tree memory ready:")) markReady();
	});
	let timeout;
	const deadline = new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("RPC background smoke timed out")), 15_000); });
	try {
		await client.start();
		assert.equal(await Promise.race([client.prompt("/tree-memory retry"), deadline]), "handled");
		await Promise.race([started, deadline]);
		assert.equal((await client.getState()).isStreaming, false, "retry cannot monopolize the agent run");
		await client.prompt("/tree-memory status");
		const running = JSON.parse(events.filter(event => event.type === "extension_ui_request" && event.method === "notify").at(-1).message);
		assert.equal(running.phase, "building");
		assert.equal(running.error, null);
		assert.deepEqual(running.progress, { completed: 1, total: 3, range: "1+1" });
		assert.ok(events.some(event => event.method === "setStatus" && /1\/3/.test(event.statusText)), "RPC must forward live progress");
		gateResponse.end("release");
		await Promise.race([ready, deadline]);
		await client.prompt("/tree-memory status");
		const complete = JSON.parse(events.filter(event => event.type === "extension_ui_request" && event.method === "notify").at(-1).message);
		assert.equal(complete.phase, "ready");
		assert.equal(complete.nodes, 3);
		assert.equal(complete.error, null);
		console.log("[tree-memory real Pi RPC background smoke] passed: immediate handled ack, 1/3 progress, 3/3 ready");

		// Normal chat -> retry tool -> native updates -> agent settlement (no command-only path).
		const toolSession = join(temp, "tool.jsonl");
		await writeFile(toolSession, `${backgroundEntries.map(JSON.stringify).join("\n")}\n`);
		await client.switchSession(toolSession);
		events.length = 0;
		started = new Promise(resolve => { requestStarted = resolve; });
		const settled = new Promise(resolve => { markSettled = resolve; });
		assert.equal(await Promise.race([client.prompt("Retry tree memory."), deadline]), "started");
		await Promise.race([started, deadline]);
		assert.equal((await client.getState()).isStreaming, true, "tool work runs inside an accepted agent turn");
		assert.ok(events.some(event => event.type === "tool_execution_update" && event.toolName === "tree_memory" && event.partialResult.details.progress.range === "1+1"), "progress must use native tool updates, not ignored extension UI");
		assert.ok(!events.some(event => event.type === "agent_settled"), "turn cannot settle before the compressor finishes");
		gateResponse.end("release");
		await Promise.race([settled, deadline]);
		const toolEnd = events.find(event => event.type === "tool_execution_end" && event.toolName === "tree_memory");
		assert.equal(toolEnd.isError, false);
		assert.equal(toolEnd.result.details.phase, "ready");
		assert.equal(toolEnd.result.details.nodes, 7);
		assert.ok(toolEnd.result.usage, "tool must report nested compressor usage");
		assert.equal(await client.getLastAssistantText(), "RETRY_OK");
		assert.equal((await client.getState()).isStreaming, false);
		console.log("[tree-memory real Pi RPC retry tool smoke] passed: started ack before compression, native progress, ready, agent_settled");
	} finally {
		clearTimeout(timeout);
		gateResponse?.end();
		unsubscribe();
		await client.stop();
		gate.closeAllConnections();
		await new Promise(resolve => gate.close(resolve));
	}
} finally {
	await rm(temp, { recursive: true, force: true });
}
