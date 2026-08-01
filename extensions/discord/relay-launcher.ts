import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RelayPaths } from "./config.js";

const childEntry = fileURLToPath(new URL("./relay-child-entry.mjs", import.meta.url));

export async function launchRelayChild(paths: RelayPaths): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [childEntry, paths.directory], {
			detached: true,
			stdio: "ignore",
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
