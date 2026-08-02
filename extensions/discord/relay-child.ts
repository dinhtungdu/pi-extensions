import { join } from "node:path";
import { loadOrCreateRelayToken, loadRelayConfigIntent, relayPaths, type RelayPaths } from "./config.js";
import { tryAcquireLeader } from "./leader.js";
import { DiscordRelayCore } from "./relay-core.js";
import { LocalRelayHost } from "./relay-host.js";
import { DiscordStateStore } from "./state.js";
import { DiscordJsTransport, type DiscordTransport } from "./transport.js";
import { InboundImageStore } from "./inbound-images.js";

export interface RelayChildDependencies {
	createStateStore(): DiscordStateStore;
	createTransport(): DiscordTransport;
}

export async function runRelayChild(
	paths: RelayPaths,
	dependencies?: RelayChildDependencies,
): Promise<boolean> {
	const childDependencies = dependencies ?? {
		createStateStore: () => new DiscordStateStore(join(paths.directory, "state.json")),
		createTransport: () => new DiscordJsTransport(),
	};
	const lease = await tryAcquireLeader(paths);
	if (!lease) return false;
	let host: LocalRelayHost | undefined;
	let stop: (() => void) | undefined;
	try {
		const token = await loadOrCreateRelayToken(paths);
		const intent = await loadRelayConfigIntent(paths);
		const core = new DiscordRelayCore(intent.config, childDependencies.createStateStore(), childDependencies.createTransport(), () => {
			void host?.stop();
		}, new InboundImageStore(paths.attachments));
		host = new LocalRelayHost({
			paths,
			token,
			configFingerprint: intent.fingerprint,
			configEpoch: intent.config.epoch,
			lease,
			core,
		});
		stop = () => void host?.stop();
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		await host.start();
		await host.waitForStop();
		return true;
	} finally {
		if (stop) {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
		}
		if (host) await host.stop().catch(() => {});
		else await lease.release().catch(() => {});
	}
}

export async function runDefaultRelayChild(directory: string): Promise<void> {
	await runRelayChild(relayPaths(directory));
}
