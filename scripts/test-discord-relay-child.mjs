#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(root, ".discord-child-test-"));
const directory = await mkdtemp(join(tmpdir(), "pi-discord-child-data-"));
const eventsFile = join(directory, "events.jsonl");
const configFile = join(directory, "config.json");
const clientFixture = join(root, "scripts", "fixtures", "discord-relay-client.mjs");
const workers = new Set();
const relayPids = new Set();

function compileExtensions() {
	const compile = spawnSync(
		join(root, "node_modules", ".bin", "tsc"),
		["--noEmit", "false", "--rootDir", ".", "--outDir", output],
		{ cwd: root, encoding: "utf8" },
	);
	if (compile.status !== 0) throw new Error(`${compile.stdout}\n${compile.stderr}`.trim());
}

async function events() {
	try {
		return (await readFile(eventsFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

async function waitFor(predicate, description, attempts = 500) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (await predicate()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 20));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

function startClient(token, sessionId) {
	const child = spawn(process.execPath, [clientFixture, output, directory, eventsFile, configFile, token, sessionId], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	workers.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (data) => { stdout += data; });
	child.stderr.on("data", (data) => { stderr += data; });
	child.once("exit", () => workers.delete(child));
	return {
		child,
		stdout: () => stdout,
		async ready() {
			await waitFor(() => stdout.includes("READY\n"), `${sessionId} ready`);
		},
		async restart() {
			const offset = stdout.length;
			child.kill("SIGUSR1");
			await waitFor(() => stdout.slice(offset).includes("RESTARTED ") || stdout.slice(offset).includes("RESTART_ERROR "), `${sessionId} restart result`);
			const result = stdout.slice(offset);
			assert.doesNotMatch(result, /RESTART_ERROR /);
			return result;
		},
		async stop() {
			if (child.exitCode !== null) return;
			child.kill("SIGTERM");
			await waitFor(() => child.exitCode !== null, `${sessionId} exit`);
			assert.equal(stderr, "");
		},
	};
}

try {
	compileExtensions();
	const entrySmokeDirectory = await mkdtemp(join(tmpdir(), "pi-discord-entry-smoke-"));
	const entrySmoke = spawnSync(process.execPath, [join(root, "extensions", "discord", "relay-child-entry.mjs"), entrySmokeDirectory], {
		cwd: root,
		encoding: "utf8",
	});
	assert.notEqual(entrySmoke.status, 0);
	assert.match(entrySmoke.stderr, /Cannot read Discord relay configuration intent/);
	await rm(entrySmokeDirectory, { recursive: true, force: true });
	await writeFile(configFile, `${JSON.stringify({ token: "file", guildId: "12345" })}\n`);
	await writeFile(eventsFile, "");

	const first = startClient("environment-old", "child-a");
	const second = startClient("environment-old", "child-b");
	const third = startClient("environment-old", "child-c");
	await Promise.all([first.ready(), second.ready(), third.ready()]);
	let recorded = await events();
	assert.equal(recorded.filter((event) => event.event === "connect").length, 1, "concurrent startups must create one gateway child");
	let relayPid = recorded.find((event) => event.event === "connect").pid;
	relayPids.add(relayPid);

	const updater = startClient("environment-new", "child-new-config");
	await updater.ready();
	await waitFor(async () => (await events()).some((event) => event.event === "connect" && event.token === "environment-new"), "environment config child rollover");
	recorded = await events();
	const newConnect = recorded.findLast((event) => event.event === "connect" && event.token === "environment-new");
	relayPid = newConnect.pid;
	relayPids.add(relayPid);
	assert.equal(recorded.filter((event) => event.event === "connect").length - recorded.filter((event) => event.event === "disconnect").length, 1);
	await updater.stop();
	await new Promise((resolveWait) => setTimeout(resolveWait, 1_300));
	assert.doesNotThrow(() => process.kill(relayPid, 0), "relay must survive the client that introduced its effective config");
	assert.equal((await events()).filter((event) => event.event === "disconnect" && event.pid === relayPid).length, 0);

	process.kill(relayPid, "SIGSTOP");
	const suspendedContender = startClient("environment-new", "child-suspended-contender");
	await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
	assert.equal((await events()).filter((event) => event.event === "connect").length, 2, "suspended live relay must not get a successor");
	process.kill(relayPid, "SIGCONT");
	await suspendedContender.ready();

	process.kill(relayPid, "SIGKILL");
	await waitFor(async () => (await events()).some((event) => event.event === "connect" && event.pid !== relayPid && event.token === "environment-new"), "child crash recovery");
	const recovered = (await events()).findLast((event) => event.event === "connect" && event.pid !== relayPid);
	relayPids.add(recovered.pid);
	assert.equal((await events()).filter((event) => event.event === "connect").length - (await events()).filter((event) => event.event === "disconnect").length, 2,
		"SIGKILL leaves one unmatched historical connect plus exactly one live replacement");

	const activeClients = [first, second, third, suspendedContender];
	await waitFor(() => activeClients.every((client) => client.stdout().trim().split("\n").at(-1) === "STATUS connected"),
		"all clients connected to crash replacement");
	const outputOffsets = activeClients.map((client) => client.stdout().length);
	const restartEventOffset = (await events()).length;
	const restartResult = await first.restart();
	assert.match(restartResult, new RegExp(`RESTARTED ${recovered.pid} \\d+`));
	await waitFor(async () => {
		const recent = (await events()).slice(restartEventOffset);
		return recent.some((event) => event.event === "disconnect" && event.pid === recovered.pid) &&
			recent.some((event) => event.event === "connect" && event.pid !== recovered.pid);
	}, "deliberate detached relay replacement");
	for (let index = 0; index < activeClients.length; index++) {
		await waitFor(() => /STATUS disconnected[\s\S]*STATUS connected/.test(activeClients[index].stdout().slice(outputOffsets[index])),
			`client ${index + 1} convergence after relay restart`);
	}
	await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
	const restartEvents = (await events()).slice(restartEventOffset);
	const replacementConnects = restartEvents.filter((event) => event.event === "connect");
	assert.equal(replacementConnects.length, 1, "all reconnecting clients must converge on exactly one replacement gateway");
	assert.equal(restartEvents.filter((event) => event.event === "disconnect" && event.pid === recovered.pid).length, 1,
		"the prior gateway must shut down gracefully exactly once");
	const replacementPid = replacementConnects[0].pid;
	relayPids.add(replacementPid);

	await Promise.all(activeClients.map((client) => client.stop()));
	await waitFor(async () => (await events()).some((event) => event.event === "disconnect" && event.pid === replacementPid), "zero-client child shutdown");
	await waitFor(async () => {
		try {
			await access(join(directory, "relay.sock"));
			return false;
		} catch {
			return true;
		}
	}, "relay socket cleanup");
	await waitFor(() => {
		try {
			process.kill(replacementPid, 0);
			return false;
		} catch {
			return true;
		}
	}, "relay child process exit");
	console.log("[discord relay child test] passed");
} finally {
	for (const worker of workers) worker.kill("SIGKILL");
	for (const pid of relayPids) {
		try { process.kill(pid, "SIGCONT"); } catch {}
		try { process.kill(pid, "SIGKILL"); } catch {}
	}
	await rm(output, { recursive: true, force: true });
	await rm(directory, { recursive: true, force: true });
}
