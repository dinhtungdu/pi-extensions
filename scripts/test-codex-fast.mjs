#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".codex-fast-test-"));

try {
	const compile = spawnSync(
		join(root, "node_modules", ".bin", "tsc"),
		["--noEmit", "false", "--rootDir", ".", "--outDir", output],
		{ cwd: root, encoding: "utf8" },
	);
	if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`.trim());

	const { PACKAGE_FOOTER_STATUS_KEYS } = await import(
		pathToFileURL(join(output, "extensions", "footer-status.js"))
	);
	const {
		default: codexFastExtension,
		CODEX_FAST_STATUS_ICON,
		CODEX_FAST_STATUS_KEY,
	} = await import(pathToFileURL(join(output, "extensions", "codex-fast.js")));

	assert.equal(CODEX_FAST_STATUS_ICON, "⚡");
	assert.ok(
		CODEX_FAST_STATUS_KEY.localeCompare(PACKAGE_FOOTER_STATUS_KEYS.discord) < 0,
		"Codex Fast status must render before Discord",
	);

	const events = new Map();
	const statuses = [];
	const pi = {
		on(name, handler) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
	};
	const ctx = {
		model: {
			provider: "openai-codex",
			api: "openai-codex-responses",
		},
		ui: {
			setStatus: (...args) => statuses.push(args),
		},
	};
	codexFastExtension(pi);

	async function emit(name, event = {}) {
		let result;
		for (const handler of events.get(name) ?? []) {
			const next = await handler({ type: name, ...event, ...(result === undefined ? {} : { payload: result }) }, ctx);
			if (next !== undefined) result = next;
		}
		return result;
	}

	await emit("session_start");
	assert.deepEqual(statuses.at(-1), [CODEX_FAST_STATUS_KEY, CODEX_FAST_STATUS_ICON]);

	const payload = { model: "gpt-5.4", service_tier: "default" };
	const fastPayload = await emit("before_provider_request", { payload });
	assert.deepEqual(fastPayload, { model: "gpt-5.4", service_tier: "priority" });
	assert.equal(payload.service_tier, "default", "provider payload must not be mutated in place");

	ctx.model = { provider: "openai", api: "openai-responses" };
	await emit("model_select");
	assert.deepEqual(statuses.at(-1), [CODEX_FAST_STATUS_KEY, undefined]);
	assert.equal(
		await emit("before_provider_request", { payload }),
		undefined,
		"non-Codex requests must be unchanged",
	);

	ctx.model = { provider: "openai-codex", api: "openai-responses" };
	assert.equal(
		await emit("before_provider_request", { payload }),
		undefined,
		"non-Codex APIs must be unchanged",
	);

	await emit("session_shutdown");
	assert.deepEqual(statuses.at(-1), [CODEX_FAST_STATUS_KEY, undefined]);

	console.log("codex fast tests passed");
} finally {
	await rm(output, { recursive: true, force: true });
}
