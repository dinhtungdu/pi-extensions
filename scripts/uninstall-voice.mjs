#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/)/, homedir());
const agentDir = configuredAgentDir ? resolve(configuredAgentDir) : join(homedir(), ".pi", "agent");
const cacheDir = join(agentDir, "cache", "pi-voice");
const configPath = join(agentDir, "voice.json");

function log(message) {
	process.stdout.write(`[voice uninstall] ${message}\n`);
}

async function disableVoice() {
	if (!existsSync(configPath)) return;
	try {
		const raw = JSON.parse(await readFile(configPath, "utf8"));
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			log(`kept invalid config unchanged: ${configPath}`);
			return;
		}
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, `${JSON.stringify({ ...raw, enabled: false }, null, "\t")}\n`, "utf8");
		log(`disabled voice in ${configPath}`);
	} catch (error) {
		log(`kept unreadable config unchanged: ${configPath} (${String(error)})`);
	}
}

async function main() {
	await rm(cacheDir, { recursive: true, force: true });
	log(`removed ${cacheDir}`);
	await disableVoice();
	log("complete. Configuration was preserved; run /voice setup to reinstall local data.");
}

main().catch((error) => {
	console.error(`[voice uninstall] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exitCode = 1;
});
