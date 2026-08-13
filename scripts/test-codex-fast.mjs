#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".codex-fast-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(output, "agent");

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
		CODEX_FAST_CONFIG_FILE,
		CODEX_FAST_STATUS_ICON,
		CODEX_FAST_STATUS_KEY,
	} = await import(pathToFileURL(join(output, "extensions", "codex-fast.js")));

	assert.equal(CODEX_FAST_STATUS_ICON, "⚡");
	assert.ok(
		CODEX_FAST_STATUS_KEY.localeCompare(PACKAGE_FOOTER_STATUS_KEYS.discord) < 0,
		"Codex Fast status must render before Discord",
	);

	function createHarness() {
		const events = new Map();
		const commands = new Map();
		const statuses = [];
		const notifications = [];
		const pi = {
			on(name, handler) {
				const handlers = events.get(name) ?? [];
				handlers.push(handler);
				events.set(name, handlers);
			},
			registerCommand(name, command) {
				commands.set(name, command);
			},
		};
		const ctx = {
			model: {
				provider: "openai-codex",
				api: "openai-codex-responses",
			},
			ui: {
				notify: (...args) => notifications.push(args),
				setStatus: (...args) => statuses.push(args),
			},
		};
		codexFastExtension(pi);

		async function emit(name, event = {}) {
			let result;
			for (const handler of events.get(name) ?? []) {
				const next = await handler(
					{ type: name, ...event, ...(result === undefined ? {} : { payload: result }) },
					ctx,
				);
				if (next !== undefined) result = next;
			}
			return result;
		}

		async function command(args) {
			return commands.get("fast").handler(args, ctx);
		}

		return { command, commands, ctx, emit, notifications, statuses };
	}

	const first = createHarness();
	assert.ok(first.commands.has("fast"), "/fast command must be registered");
	assert.deepEqual(
		first.commands.get("fast").getArgumentCompletions("o").map(({ value }) => value),
		["on", "off"],
	);

	await first.emit("session_start");
	assert.deepEqual(first.statuses.at(-1), [CODEX_FAST_STATUS_KEY, undefined]);

	const payload = { model: "gpt-5.4", service_tier: "default" };
	assert.equal(
		await first.emit("before_provider_request", { payload }),
		undefined,
		"Fast mode must default to disabled",
	);

	await first.command("on");
	assert.deepEqual(first.statuses.at(-1), [CODEX_FAST_STATUS_KEY, CODEX_FAST_STATUS_ICON]);
	const fastPayload = await first.emit("before_provider_request", { payload });
	assert.deepEqual(fastPayload, { model: "gpt-5.4", service_tier: "priority" });
	assert.equal(payload.service_tier, "default", "provider payload must not be mutated in place");

	await first.command("off");
	assert.deepEqual(first.statuses.at(-1), [CODEX_FAST_STATUS_KEY, undefined]);
	assert.deepEqual(
		JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR, CODEX_FAST_CONFIG_FILE), "utf8")),
		{ enabled: false },
	);
	assert.equal(
		await first.emit("before_provider_request", { payload }),
		undefined,
		"disabled Fast mode must not modify requests",
	);

	const second = createHarness();
	await second.emit("session_start");
	assert.deepEqual(second.statuses.at(-1), [CODEX_FAST_STATUS_KEY, undefined]);
	assert.equal(
		await second.emit("before_provider_request", { payload }),
		undefined,
		"disabled state must persist across sessions",
	);

	await second.command("");
	assert.match(second.notifications.at(-1)[0], /Codex Fast mode: off/);
	await second.command("on");
	assert.deepEqual(second.statuses.at(-1), [CODEX_FAST_STATUS_KEY, CODEX_FAST_STATUS_ICON]);
	assert.deepEqual(await second.emit("before_provider_request", { payload }), {
		model: "gpt-5.4",
		service_tier: "priority",
	});

	second.ctx.model = { provider: "openai", api: "openai-responses" };
	await second.emit("model_select");
	assert.deepEqual(second.statuses.at(-1), [CODEX_FAST_STATUS_KEY, undefined]);
	assert.equal(
		await second.emit("before_provider_request", { payload }),
		undefined,
		"non-Codex requests must be unchanged",
	);

	second.ctx.model = { provider: "openai-codex", api: "openai-responses" };
	assert.equal(
		await second.emit("before_provider_request", { payload }),
		undefined,
		"non-Codex APIs must be unchanged",
	);

	await second.command("invalid");
	assert.deepEqual(second.notifications.at(-1), ["Usage: /fast [on|off|status|toggle]", "warning"]);

	await second.emit("session_shutdown");
	assert.deepEqual(second.statuses.at(-1), [CODEX_FAST_STATUS_KEY, undefined]);

	console.log("codex fast tests passed");
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(output, { recursive: true, force: true });
}
