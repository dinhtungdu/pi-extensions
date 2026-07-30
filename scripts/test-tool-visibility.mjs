#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
	AssistantMessageComponent,
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".tool-visibility-test-"));

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

function createAssistantRow(content, hideThinkingBlock = true, stopReason = "toolUse") {
	return new AssistantMessageComponent(
		{
			role: "assistant",
			content,
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: 0,
		},
		hideThinkingBlock,
	);
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
		pathToFileURL(join(output, "extensions", "tool-visibility", "visibility-shim.js"))
	);
	const extensionModule = await import(
		pathToFileURL(join(output, "extensions", "tool-visibility", "index.js"))
	);
	const { installToolVisibilityShim, MINIMUM_PI_VERSION } = shimModule;

	const prototype = ToolExecutionComponent.prototype;
	const assistantPrototype = AssistantMessageComponent.prototype;
	const originalRender = prototype.render;
	const originalAssistantRender = assistantPrototype.render;
	const existing = createToolRow();
	const thinkingOnly = createAssistantRow([
		{ type: "thinking", thinking: "considering the next tool" },
		{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
	]);
	const mixedAssistant = createAssistantRow([
		{ type: "thinking", thinking: "reasoning before the answer" },
		{ type: "text", text: "Visible answer" },
	]);
	const expandedThinking = createAssistantRow(
		[{ type: "thinking", thinking: "Visible reasoning" }],
		false,
	);
	const initialRows = existing.render(100);
	const initialThinkingRows = thinkingOnly.render(100);
	assert.ok(initialRows.length > 0, "tool rows should be visible before the shim is hidden");
	assert.ok(
		initialThinkingRows.some((line) => line.includes("Thinking...")),
		"Pi's collapsed thinking placeholder should render before compact mode",
	);

	const first = installToolVisibilityShim();
	assert.equal(first.isVisible(), true, "tool rows must default to visible");
	assert.deepEqual(existing.render(100), initialRows, "installing must not alter visible rows");

	first.setVisible(false);
	assert.deepEqual(existing.render(100), [], "existing tool rows must hide immediately");
	assert.deepEqual(
		thinkingOnly.render(100),
		[],
		"compact mode must remove collapsed thinking-only placeholders without reserving rows",
	);
	assert.ok(
		mixedAssistant.render(100).some((line) => line.includes("Visible answer")),
		"compact mode must preserve assistant responses that also contain thinking",
	);
	assert.ok(
		expandedThinking.render(100).some((line) => line.includes("Visible reasoning")),
		"compact mode must preserve expanded thinking",
	);
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
	assert.deepEqual(
		thinkingOnly.render(100),
		initialThinkingRows,
		"showing tools must restore Pi's default collapsed thinking rendering",
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
	assert.equal(prototype.render, originalRender, "last dispose must restore Pi's tool renderer");
	assert.equal(
		assistantPrototype.render,
		originalAssistantRender,
		"last dispose must restore Pi's assistant renderer",
	);

	class FutureToolRow {
		calls = [];
		render(width, ...args) {
			this.calls.push([width, ...args]);
			return [`${width}:${args.join(":")}`];
		}
	}
	class FutureAssistantRow {
		hideThinkingBlock = false;
		render(width, ...args) {
			return [`assistant:${width}:${args.join(":")}`];
		}
	}
	const future = installToolVisibilityShim({
		piVersion: "99.0.0",
		ToolExecutionClass: FutureToolRow,
		AssistantMessageClass: FutureAssistantRow,
	});
	const futureRow = new FutureToolRow();
	assert.deepEqual(futureRow.render(42, "extra"), ["42:extra"], "compatible future renders must pass through");
	assert.deepEqual(futureRow.calls, [[42, "extra"]], "the shim must forward every render argument");
	future.setVisible(false);
	assert.deepEqual(futureRow.render(42, "hidden"), [], "compatible future rows must hide");
	assert.deepEqual(futureRow.calls, [[42, "extra"]], "hidden renders must not invoke Pi's renderer");
	assert.equal(future.dispose(), true);

	for (const piVersion of ["0.82.0", "0.82.1-beta.1", "invalid"]) {
		assert.throws(
			() => installToolVisibilityShim({ piVersion }),
			/compatibility error.*Compact rendering was left unchanged/,
			`Pi ${piVersion} must fail the minimum-version check`,
		);
	}
	assert.throws(
		() => installToolVisibilityShim({
			piVersion: MINIMUM_PI_VERSION,
			ToolExecutionClass: { prototype: {} },
		}),
		/ToolExecutionComponent\.render is unavailable/,
		"incompatible runtime shape must fail explicitly",
	);
	const lockedPrototype = {};
	Object.defineProperty(lockedPrototype, "render", { value: () => ["locked"], writable: false });
	assert.throws(
		() => installToolVisibilityShim({
			piVersion: MINIMUM_PI_VERSION,
			ToolExecutionClass: { prototype: lockedPrototype },
		}),
		/ToolExecutionComponent\.render cannot be patched safely/,
		"a non-writable renderer must fail explicitly",
	);
	assert.throws(
		() => installToolVisibilityShim({
			piVersion: MINIMUM_PI_VERSION,
			AssistantMessageClass: { prototype: {} },
		}),
		/AssistantMessageComponent\.render is unavailable/,
		"an incompatible assistant renderer must fail explicitly",
	);
	assert.equal(prototype.render, originalRender);
	assert.equal(assistantPrototype.render, originalAssistantRender);

	const harness = createExtensionHarness(extensionModule.default);
	await harness.emit("session_start", { reason: "startup" });
	assert.deepEqual([...harness.commands.keys()], ["tools"], "the extension must expose only /tools");
	assert.deepEqual(
		harness.commands.get("tools").getArgumentCompletions("").map(({ value }) => value),
		["hide", "show", "status", "diagnostics"],
		"/tools must expose only the approved arguments",
	);
	assert.equal(harness.statuses.at(-1)[1], "🛠️", "default footer status must be a compact tool icon");
	assert.deepEqual(harness.workingCalls, [], "tool visibility must not alter Pi's working indicator");

	const newRow = createToolRow("new_custom_tool");
	await harness.command("tools");
	assert.deepEqual(newRow.render(80), [], "bare /tools must hide newly-created arbitrary tool rows");
	assert.deepEqual(harness.notifications.at(-1), ["TOOLS: hidden", "info"]);
	assert.equal(harness.statuses.at(-1)[1], "🧰", "hidden footer status must use the put-away tool icon");

	await harness.command("tools");
	assert.ok(newRow.render(80).length > 0, "bare /tools must toggle hidden rows back to shown");
	for (const removedAlias of ["toggle", "on", "off", "visible", "hidden", "diagnostic", "diag"]) {
		await harness.command("tools", removedAlias);
		assert.deepEqual(harness.notifications.at(-1), ["Usage: /tools [hide|show|status|diagnostics]", "warning"]);
		assert.ok(newRow.render(80).length > 0, `removed ${removedAlias} alias must not change visibility`);
	}
	await harness.command("tools", "hide");
	assert.deepEqual(newRow.render(80), [], "/tools hide must hide rows");
	await harness.command("tools", "show");
	assert.ok(newRow.render(80).length > 0, "/tools show must restore rows");
	await harness.command("tools", "status");
	assert.deepEqual(harness.notifications.at(-1), ["TOOLS: shown", "info"]);
	await harness.command("tools", "diagnostics");
	assert.match(harness.notifications.at(-1)[0], new RegExp(`minimum ${MINIMUM_PI_VERSION.replaceAll(".", "\\.")}`));
	assert.match(harness.notifications.at(-1)[0], /runtime-compatible=true;.*owners=1$/);

	await harness.emit("session_shutdown", { reason: "reload" });
	assert.equal(prototype.render, originalRender, "reload shutdown must restore Pi before the next extension instance");
	assert.deepEqual(harness.statuses.at(-1), ["tool-visibility", undefined]);

	const reloaded = createExtensionHarness(extensionModule.default);
	await reloaded.emit("session_start", { reason: "reload" });
	assert.equal(prototype.render === originalRender, false, "reloaded instance must install one fresh wrapper");
	assert.deepEqual([...reloaded.commands.keys()], ["tools"]);
	await reloaded.command("tools", "diagnostics");
	assert.match(reloaded.notifications.at(-1)[0], /owners=1$/);
	await reloaded.emit("session_shutdown", { reason: "quit" });
	assert.equal(prototype.render, originalRender, "reloaded instance must clean up tool patches");
	assert.equal(
		assistantPrototype.render,
		originalAssistantRender,
		"reloaded instance must clean up thinking patches",
	);

	console.log("[tool-visibility test] passed");
} finally {
	if (ToolExecutionComponent.prototype.render !== undefined) {
		// Failed assertions should not leave the test process's shared classes patched.
		const record = ToolExecutionComponent.prototype[
			Symbol.for("pi-extensions.tool-visibility.v1")
		];
		if (record?.originalDescriptor) {
			Object.defineProperty(ToolExecutionComponent.prototype, "render", record.originalDescriptor);
			delete ToolExecutionComponent.prototype[Symbol.for("pi-extensions.tool-visibility.v1")];
		}
		const thinkingRecord = AssistantMessageComponent.prototype[
			Symbol.for("pi-extensions.tool-visibility.thinking.v1")
		];
		if (thinkingRecord?.originalDescriptor) {
			Object.defineProperty(
				AssistantMessageComponent.prototype,
				"render",
				thinkingRecord.originalDescriptor,
			);
			delete AssistantMessageComponent.prototype[
				Symbol.for("pi-extensions.tool-visibility.thinking.v1")
			];
		}
	}
	await rm(output, { recursive: true, force: true });
}
