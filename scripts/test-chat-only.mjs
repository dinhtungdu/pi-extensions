#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".chat-only-test-"));

function compileExtensions() {
	const compile = spawnSync(
		join(root, "node_modules", ".bin", "tsc"),
		["--noEmit", "false", "--rootDir", ".", "--outDir", output],
		{ cwd: root, encoding: "utf8" },
	);
	if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`.trim());
}

function createToolRow(toolName = "arbitrary_image_tool") {
	const row = new ToolExecutionComponent(
		toolName,
		`${toolName}-call`,
		{ input: "before" },
		{ showImages: true },
		undefined,
		{ requestRender: () => {} },
		root,
	);
	return row;
}

function createExtensionHarness(extension) {
	const events = new Map();
	const commands = new Map();
	const statuses = [];
	const notifications = [];
	const workingCalls = [];
	const pi = {
		on(name, handler) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			setStatus: (...args) => statuses.push(args),
			notify: (...args) => notifications.push(args),
			setWorkingVisible: (...args) => workingCalls.push(["visible", ...args]),
			setWorkingIndicator: (...args) => workingCalls.push(["indicator", ...args]),
		},
	};
	extension(pi);
	return {
		commands,
		statuses,
		notifications,
		workingCalls,
		async emit(name, event = {}) {
			for (const handler of events.get(name) ?? []) await handler(event, ctx);
		},
		async command(name, args = "") {
			await commands.get(name).handler(args, ctx);
		},
	};
}

try {
	initTheme("dark");
	compileExtensions();
	const shimModule = await import(
		pathToFileURL(join(output, "extensions", "chat-only", "visibility-shim.js"))
	);
	const extensionModule = await import(
		pathToFileURL(join(output, "extensions", "chat-only", "index.js"))
	);
	const { installToolVisibilityShim, SUPPORTED_PI_VERSION } = shimModule;

	const prototype = ToolExecutionComponent.prototype;
	const originalRender = prototype.render;
	const existing = createToolRow();
	const initialRows = existing.render(100);
	assert.ok(initialRows.length > 0, "tool rows should be visible before the shim is hidden");

	const first = installToolVisibilityShim();
	assert.equal(first.isVisible(), true, "tool rows must default to visible");
	assert.deepEqual(existing.render(100), initialRows, "installing must not alter visible rows");

	first.setVisible(false);
	assert.deepEqual(existing.render(100), [], "existing tool rows must hide immediately");
	existing.updateResult(
		{
			content: [
				{ type: "text", text: "completed while hidden" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
			details: { completed: true },
			isError: false,
		},
		false,
	);
	assert.deepEqual(existing.render(100), [], "tool completion and image results must remain hidden");
	const expectedCompletedRows = originalRender.call(existing, 100);
	first.setVisible(true);
	assert.deepEqual(
		existing.render(100),
		expectedCompletedRows,
		"showing must restore the exact current rows after hidden completion",
	);

	const firstWrapper = prototype.render;
	const second = installToolVisibilityShim();
	assert.equal(prototype.render, firstWrapper, "reload/duplicate installation must not wrap render twice");
	assert.equal(second.diagnostics().ownerCount, 2);
	first.setVisible(false);
	assert.deepEqual(existing.render(100), [], "any active hidden owner must hide rows");
	assert.equal(first.dispose(), true);
	assert.deepEqual(existing.render(100), expectedCompletedRows, "disposing the hidden owner must reveal rows");
	assert.equal(second.dispose(), true);
	assert.equal(prototype.render, originalRender, "last dispose must restore Pi's original render method");

	assert.throws(
		() => installToolVisibilityShim({ piVersion: "99.0.0" }),
		/compatibility error.*Tool rows were left visible/,
		"unsupported Pi internals must fail explicitly",
	);
	assert.equal(prototype.render, originalRender);

	const harness = createExtensionHarness(extensionModule.default);
	await harness.emit("session_start", { reason: "startup" });
	assert.match(harness.statuses.at(-1)[1], /^CHAT tools: shown$/, "default status must be persistent and visible");
	assert.deepEqual(harness.workingCalls, [], "chat-only must not alter Pi's working indicator");

	const newRow = createToolRow("new_custom_tool");
	await harness.command("chat-only");
	assert.deepEqual(newRow.render(80), [], "toggle must hide newly-created arbitrary tool rows");
	assert.deepEqual(harness.notifications.at(-1), ["CHAT tools hidden", "info"]);
	assert.match(harness.statuses.at(-1)[1], /hidden$/);

	await harness.command("show-tools");
	assert.ok(newRow.render(80).length > 0, "explicit show alias must restore rows immediately");
	await harness.command("hide-tools");
	assert.deepEqual(newRow.render(80), [], "explicit hide alias must hide rows");
	await harness.command("chat-tools", "show");
	assert.ok(newRow.render(80).length > 0, "chat-tools show alias must restore rows");
	await harness.command("chat-only", "status");
	assert.deepEqual(harness.notifications.at(-1), ["CHAT tools: shown", "info"]);
	await harness.command("chat-only", "diagnostics");
	assert.match(harness.notifications.at(-1)[0], new RegExp(`target ${SUPPORTED_PI_VERSION.replaceAll(".", "\\.")}`));
	assert.match(harness.notifications.at(-1)[0], /patched=true; owners=1$/);

	await harness.emit("session_shutdown", { reason: "reload" });
	assert.equal(prototype.render, originalRender, "reload shutdown must restore Pi before the next extension instance");
	assert.deepEqual(harness.statuses.at(-1), ["chat-only", undefined]);

	const reloaded = createExtensionHarness(extensionModule.default);
	await reloaded.emit("session_start", { reason: "reload" });
	assert.equal(prototype.render === originalRender, false, "reloaded instance must install one fresh wrapper");
	await reloaded.command("chat-only", "diagnostics");
	assert.match(reloaded.notifications.at(-1)[0], /owners=1$/);
	await reloaded.emit("session_shutdown", { reason: "quit" });
	assert.equal(prototype.render, originalRender, "reloaded instance must clean up without stacked patches");

	console.log("[chat-only test] passed");
} finally {
	if (ToolExecutionComponent.prototype.render !== undefined) {
		// Failed assertions should not leave the test process's shared class patched.
		const record = ToolExecutionComponent.prototype[
			Symbol.for("pi-extensions.chat-only.tool-visibility.v1")
		];
		if (record?.originalDescriptor) {
			Object.defineProperty(ToolExecutionComponent.prototype, "render", record.originalDescriptor);
			delete ToolExecutionComponent.prototype[Symbol.for("pi-extensions.chat-only.tool-visibility.v1")];
		}
	}
	await rm(output, { recursive: true, force: true });
}
