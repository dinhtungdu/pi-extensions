#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
} finally {
	await rm(temp, { recursive: true, force: true });
}
