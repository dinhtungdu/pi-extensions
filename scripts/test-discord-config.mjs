#!/usr/bin/env node

import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".discord-config-test-"));
const dataDir = await mkdtemp(join(tmpdir(), "pi-discord-config-data-"));
let importSequence = 0;
let requestSequence = 0;
let retainedChild;
const configProcessFixture = join(root, "scripts", "fixtures", "discord-config-process.mjs");

function compileExtensions() {
	const compile = spawnSync(
		join(root, "node_modules", ".bin", "tsc"),
		["--noEmit", "false", "--rootDir", ".", "--outDir", output],
		{ cwd: root, encoding: "utf8" },
	);
	if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`.trim());
}

async function importFreshConfig() {
	const url = pathToFileURL(join(output, "extensions/discord/config.js"));
	url.searchParams.set("instance", String(importSequence++));
	return import(url.href);
}

function fingerprint({ token, guildId, categoryId }) {
	return createHash("sha256")
		.update(`${token}\0${guildId}\0${categoryId ?? ""}`)
		.digest("hex");
}

async function writeConfig(file, token, epoch = 0) {
	await writeFile(file, `${JSON.stringify({ token, guildId: "12345", epoch })}\n`);
}

async function readAuthority(file) {
	return JSON.parse(await readFile(`${file}.authority.json`, "utf8"));
}

function wait(milliseconds) {
	return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function startRetainedProcess() {
	const child = fork(configProcessFixture, [output, "retained"], {
		cwd: root,
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	const [ready] = await once(child, "message");
	assert.equal(ready.ready, true);
	assert.equal(ready.pid, child.pid);
	return child;
}

function requestChild(child, request) {
	return new Promise((resolveRequest, rejectRequest) => {
		const id = requestSequence++;
		const cleanup = () => {
			child.off("message", onMessage);
			child.off("exit", onExit);
		};
		const onMessage = (response) => {
			if (response?.id !== id) return;
			cleanup();
			if (response.ok) resolveRequest(response);
			else rejectRequest(new Error(response.error));
		};
		const onExit = (code, signal) => {
			cleanup();
			rejectRequest(new Error(`config child exited before response (${String(code ?? signal)})`));
		};
		child.on("message", onMessage);
		child.on("exit", onExit);
		child.send({ ...request, id });
	});
}

try {
	compileExtensions();
	await mkdir(dataDir, { recursive: true });

	const evictionFile = join(dataDir, "eviction.json");
	retainedChild = await startRetainedProcess();
	await writeConfig(evictionFile, "stale-token");
	const staleFirst = (await requestChild(retainedChild, {
		action: "load",
		file: relative(process.cwd(), evictionFile),
	})).config;
	assert.ok(staleFirst);

	await writeConfig(evictionFile, "current-token", staleFirst.epoch + 1);
	const currentProcess = await importFreshConfig();
	const current = await currentProcess.loadDiscordConfig(evictionFile, {});
	assert.ok(current.epoch > staleFirst.epoch, "a new effective config must advance global authority");
	const stableAuthorityText = await readFile(`${evictionFile}.authority.json`, "utf8");
	const stableAuthorityStat = await stat(`${evictionFile}.authority.json`);
	assert.deepEqual((await readAuthority(evictionFile)).sources, {}, "new processes must not add durable source history");

	const launchedPids = new Set();
	for (let launch = 0; launch < 257; launch++) {
		const launched = spawnSync(process.execPath, [configProcessFixture, output, "once", evictionFile], {
			cwd: root,
			encoding: "utf8",
		});
		assert.equal(launched.status, 0, launched.stderr);
		const observed = JSON.parse(launched.stdout);
		assert.equal(observed.config.epoch, current.epoch);
		assert.equal(launchedPids.has(observed.pid), false, `child PID ${observed.pid} was reused`);
		launchedPids.add(observed.pid);
	}
	assert.equal(launchedPids.size, 257, "the eviction boundary requires >256 distinct child processes");
	assert.equal(launchedPids.has(retainedChild.pid), false, "the retained stale process must outlive distinct launch processes");
	const authorityAfterLaunches = await stat(`${evictionFile}.authority.json`);
	assert.equal(await readFile(`${evictionFile}.authority.json`, "utf8"), stableAuthorityText,
		">256 process launches must not grow or rewrite stable authority state");
	assert.equal(authorityAfterLaunches.size, stableAuthorityStat.size);
	assert.equal(authorityAfterLaunches.mtimeMs, stableAuthorityStat.mtimeMs);
	assert.equal(Object.keys((await readAuthority(evictionFile)).sources).length, 0);

	const staleReconnect = (await requestChild(retainedChild, {
		action: "load",
		file: evictionFile,
		token: "stale-token",
	})).config;
	assert.equal(staleReconnect.epoch, staleFirst.epoch, "a long-lived stale process must not reclaim authority");
	assert.equal(await readFile(`${evictionFile}.authority.json`, "utf8"), stableAuthorityText,
		"a stale reconnect must not rewrite authority state");

	const unsupportedAuthorityText = `${JSON.stringify({ ...JSON.parse(stableAuthorityText), version: 2 })}\n`;
	const configBeforeFailedSave = await readFile(evictionFile, "utf8");
	await writeFile(`${evictionFile}.authority.json`, unsupportedAuthorityText);
	await assert.rejects(
		() => requestChild(retainedChild, {
			action: "save",
			file: evictionFile,
			config: { token: "stale-token", guildId: "12345" },
		}),
		/unsupported version 2/,
	);
	assert.equal(await readFile(`${evictionFile}.authority.json`, "utf8"), unsupportedAuthorityText,
		"a failed save must not mutate authority state");
	assert.equal(await readFile(evictionFile, "utf8"), configBeforeFailedSave,
		"a failed save must not mutate config state");
	await writeFile(`${evictionFile}.authority.json`, stableAuthorityText);
	const staleAfterFailedSave = (await requestChild(retainedChild, {
		action: "load",
		file: evictionFile,
		token: "stale-token",
	})).config;
	assert.equal(staleAfterFailedSave.epoch, staleFirst.epoch,
		"a failed save must not convert old process-local history into intentional change");

	await requestChild(retainedChild, {
		action: "save",
		file: evictionFile,
		config: { token: "stale-token", guildId: "12345" },
	});
	assert.equal(await readFile(`${evictionFile}.authority.json`, "utf8"), stableAuthorityText,
		"an explicit save must not mutate authority before its config is loaded");
	const savedChange = (await requestChild(retainedChild, { action: "load", file: evictionFile })).config;
	assert.ok(savedChange.epoch > current.epoch,
		"a successful save of old stale config must advance beyond current global authority");
	assert.equal((await readAuthority(evictionFile)).currentFingerprint,
		fingerprint({ token: "stale-token", guildId: "12345" }));

	const intentionalChange = (await requestChild(retainedChild, {
		action: "load",
		file: evictionFile,
		token: "changed-token",
	})).config;
	assert.ok(intentionalChange.epoch > savedChange.epoch, "a same-process effective config change must advance authority");
	const sameProcessReconnect = (await requestChild(retainedChild, {
		action: "load",
		file: evictionFile,
		token: "changed-token",
	})).config;
	assert.equal(sameProcessReconnect.epoch, intentionalChange.epoch, "a same-process reconnect must reuse its current epoch");
	const retainedExit = once(retainedChild, "exit");
	retainedChild.kill();
	await retainedExit;
	retainedChild = undefined;

	const legacyFile = join(dataDir, "legacy-v1.json");
	await writeConfig(legacyFile, "legacy-current");
	const legacySources = {
		"old-process-one": { fingerprint: "old-one", epoch: 40, updatedAt: 1 },
		"old-process-two": { fingerprint: "old-two", epoch: 41, updatedAt: 2 },
	};
	const legacyState = {
		version: 1,
		currentFingerprint: fingerprint({ token: "legacy-current", guildId: "12345" }),
		currentEpoch: 42,
		sources: legacySources,
	};
	await writeFile(`${legacyFile}.authority.json`, `${JSON.stringify(legacyState)}\n`);
	const mixedProcess = await importFreshConfig();
	const legacyText = await readFile(`${legacyFile}.authority.json`, "utf8");
	assert.equal((await mixedProcess.loadDiscordConfig(legacyFile, {})).epoch, 42);
	assert.equal(await readFile(`${legacyFile}.authority.json`, "utf8"), legacyText,
		"reading version-1 state must not migrate or append sources");

	await mixedProcess.loadDiscordConfig(legacyFile, { DISCORD_TOKEN: "new-writer" });
	const mixedState = await readAuthority(legacyFile);
	assert.equal(mixedState.version, 1, "mixed writers still require the version-1 schema");
	assert.deepEqual(mixedState.sources, legacySources, "new writers must retain source entries needed by old processes");
	assert.equal(mixedState.currentFingerprint, fingerprint({ token: "new-writer", guildId: "12345" }));

	mixedState.sources["old-process-three"] = { fingerprint: "old-three", epoch: 41, updatedAt: 3 };
	await writeFile(`${legacyFile}.authority.json`, `${JSON.stringify(mixedState)}\n`);
	const oldWriterText = await readFile(`${legacyFile}.authority.json`, "utf8");
	await mixedProcess.loadDiscordConfig(legacyFile, { DISCORD_TOKEN: "new-writer" });
	assert.equal(await readFile(`${legacyFile}.authority.json`, "utf8"), oldWriterText,
		"new readers must preserve source entries added by a mixed-version writer");

	const unsupportedFile = join(dataDir, "unsupported.json");
	await writeConfig(unsupportedFile, "unsupported-token");
	const unsupportedState = `${JSON.stringify({ ...legacyState, version: 2 })}\n`;
	await writeFile(`${unsupportedFile}.authority.json`, unsupportedState);
	const unsupportedProcess = await importFreshConfig();
	await assert.rejects(
		() => unsupportedProcess.loadDiscordConfig(unsupportedFile, {}),
		/unsupported version 2/,
	);
	assert.equal(await readFile(`${unsupportedFile}.authority.json`, "utf8"), unsupportedState,
		"unsupported authority state must fail closed without replacement");
	const unsupportedConfig = await readFile(unsupportedFile, "utf8");
	await assert.rejects(
		() => unsupportedProcess.saveDiscordConfig({ token: "must-not-save", guildId: "12345" }, unsupportedFile),
		/unsupported version 2/,
	);
	assert.equal(await readFile(unsupportedFile, "utf8"), unsupportedConfig,
		"config writes must fail closed against unsupported authority state");
	await assert.rejects(() => stat(`${unsupportedFile}.lock`), { code: "ENOENT" });
	await assert.rejects(() => stat(`${unsupportedFile}.authority.json.lock`), { code: "ENOENT" });

	const malformedFile = join(dataDir, "malformed.json");
	await writeFile(malformedFile, "{oops");
	const failureProcess = await importFreshConfig();
	await assert.rejects(() => failureProcess.loadDiscordConfig(malformedFile, {}), /Cannot read Discord bridge config/);
	await assert.rejects(() => stat(`${malformedFile}.authority.json.lock`), { code: "ENOENT" });
	await writeConfig(malformedFile, "recovered-token");
	assert.equal((await failureProcess.loadDiscordConfig(malformedFile, {})).token, "recovered-token",
		"a failed read must release the authority lock");

	const concurrentFile = join(dataDir, "concurrent.json");
	await writeConfig(concurrentFile, "before-lock");
	const concurrencyProcess = await importFreshConfig();
	await concurrencyProcess.loadDiscordConfig(concurrentFile, {});
	const configLock = `${concurrentFile}.lock`;
	const authorityLock = `${concurrentFile}.authority.json.lock`;
	const heldLock = await open(configLock, "wx", 0o600);
	const waitingLoad = concurrencyProcess.loadDiscordConfig(concurrentFile, {});
	await wait(75);
	const replacement = `${concurrentFile}.replacement`;
	await writeConfig(replacement, "after-lock");
	await rename(replacement, concurrentFile);
	await heldLock.close();
	await unlink(configLock);
	const serializedLoad = await waitingLoad;
	assert.equal(serializedLoad.token, "after-lock", "config must be read only after acquiring the config lock");
	assert.equal((await readAuthority(concurrentFile)).currentFingerprint,
		fingerprint({ token: "after-lock", guildId: "12345" }));

	const saveLock = await open(authorityLock, "wx", 0o600);
	const waitingSave = concurrencyProcess.saveDiscordConfig({ token: "saved-under-lock", guildId: "12345" }, concurrentFile);
	await wait(75);
	assert.equal(JSON.parse(await readFile(concurrentFile, "utf8")).token, "after-lock",
		"config writes must participate in authority serialization");
	await saveLock.close();
	await unlink(authorityLock);
	await waitingSave;
	assert.equal((await concurrencyProcess.loadDiscordConfig(concurrentFile, {})).token, "saved-under-lock");
	await assert.rejects(() => stat(`${concurrentFile}.lock`), { code: "ENOENT" });
	await assert.rejects(() => stat(authorityLock), { code: "ENOENT" });

	console.log("discord config authority tests passed");
} finally {
	if (retainedChild?.exitCode === null && retainedChild.signalCode === null) {
		const retainedExit = once(retainedChild, "exit");
		retainedChild.kill();
		await retainedExit;
	}
	await rm(output, { recursive: true, force: true });
	await rm(dataDir, { recursive: true, force: true });
}
