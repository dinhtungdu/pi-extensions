#!/usr/bin/env node

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/)/, homedir());
const agentDir = configuredAgentDir ? resolve(configuredAgentDir) : join(homedir(), ".pi", "agent");
const cacheDir = join(agentDir, "cache", "pi-voice");

function log(message) {
	process.stdout.write(`[voice uninstall] ${message}\n`);
}

async function main() {
	await rm(cacheDir, { recursive: true, force: true });
	log(`removed ${cacheDir}`);
	log("complete. Configuration was preserved; run /voice setup to reinstall local data.");
}

main().catch((error) => {
	console.error(`[voice uninstall] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
	process.exitCode = 1;
});
