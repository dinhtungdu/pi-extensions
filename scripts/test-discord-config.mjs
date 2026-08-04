#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".discord-config-test-"));
const dataDir = await mkdtemp(join(tmpdir(), "pi-discord-config-data-"));
let importSequence = 0;

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

try {
	compileExtensions();
	await mkdir(dataDir, { recursive: true });

	const evictionFile = join(dataDir, "eviction.json");
	const staleProcess = await importFreshConfig();
	await writeConfig(evictionFile, "stale-token");
	const staleFirst = await staleProcess.loadDiscordConfig(relative(process.cwd(), evictionFile), {});
	assert.ok(staleFirst);

	await writeConfig(evictionFile, "current-token", staleFirst.epoch + 1);
	const currentProcess = await importFreshConfig();
	const current = await currentProcess.loadDiscordConfig(evictionFile, {});
	assert.ok(current.epoch > staleFirst.epoch, "a new effective config must advance global authority");
	const stableAuthorityText = await readFile(`${evictionFile}.authority.json`, "utf8");
	const stableAuthorityStat = await stat(`${evictionFile}.authority.json`);
	assert.deepEqual((await readAuthority(evictionFile)).sources, {}, "new processes must not add durable source history");

	for (let launch = 0; launch < 257; launch++) {
		const interveningProcess = await importFreshConfig();
		const observed = await interveningProcess.loadDiscordConfig(evictionFile, {});
		assert.equal(observed.epoch, current.epoch);
	}
	const authorityAfterLaunches = await stat(`${evictionFile}.authority.json`);
	assert.equal(await readFile(`${evictionFile}.authority.json`, "utf8"), stableAuthorityText,
		">256 process launches must not grow or rewrite stable authority state");
	assert.equal(authorityAfterLaunches.size, stableAuthorityStat.size);
	assert.equal(authorityAfterLaunches.mtimeMs, stableAuthorityStat.mtimeMs);

	const staleReconnect = await staleProcess.loadDiscordConfig(evictionFile, { DISCORD_TOKEN: "stale-token" });
	assert.equal(staleReconnect.epoch, staleFirst.epoch, "an evicted long-lived stale process must not reclaim authority");
	assert.equal((await readAuthority(evictionFile)).currentFingerprint,
		fingerprint({ token: "current-token", guildId: "12345" }));

	const intentionalChange = await staleProcess.loadDiscordConfig(evictionFile, { DISCORD_TOKEN: "changed-token" });
	assert.ok(intentionalChange.epoch > current.epoch, "a same-process effective config change must advance authority");
	const sameProcessReconnect = await staleProcess.loadDiscordConfig(evictionFile, { DISCORD_TOKEN: "changed-token" });
	assert.equal(sameProcessReconnect.epoch, intentionalChange.epoch, "a same-process reconnect must reuse its current epoch");

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
	await rm(output, { recursive: true, force: true });
	await rm(dataDir, { recursive: true, force: true });
}
