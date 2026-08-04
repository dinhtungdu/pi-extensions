#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [buildRoot, mode, configFile] = process.argv.slice(2);
if (!buildRoot || !mode) throw new Error("usage: discord-config-process.mjs <build-root> <once|retained> [config-file]");

const configModule = await import(pathToFileURL(join(buildRoot, "extensions/discord/config.js")));

if (mode === "once") {
	if (!configFile) throw new Error("one-shot config process requires a config file");
	const config = await configModule.loadDiscordConfig(configFile, {});
	console.log(JSON.stringify({ pid: process.pid, config }));
} else if (mode === "retained") {
	process.on("message", async (request) => {
		if (!request || typeof request !== "object" || typeof request.id !== "number") return;
		try {
			if (request.action === "load") {
				const environment = request.token ? { DISCORD_TOKEN: request.token } : {};
				const config = await configModule.loadDiscordConfig(request.file, environment);
				process.send?.({ id: request.id, ok: true, config, pid: process.pid });
			} else if (request.action === "save") {
				await configModule.saveDiscordConfig(request.config, request.file);
				process.send?.({ id: request.id, ok: true, pid: process.pid });
			} else {
				throw new Error(`unsupported action ${String(request.action)}`);
			}
		} catch (error) {
			process.send?.({
				id: request.id,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				pid: process.pid,
			});
		}
	});
	process.send?.({ ready: true, pid: process.pid });
} else {
	throw new Error(`unsupported mode ${mode}`);
}
