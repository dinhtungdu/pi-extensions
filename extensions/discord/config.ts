import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface DiscordBridgeConfig {
	token: string;
	guildId: string;
	categoryId?: string;
	epoch: number;
}

export const DISCORD_BRIDGE_DIR = join(homedir(), ".pi", "agent", "discord-bridge");
export const DISCORD_CONFIG_FILE = join(DISCORD_BRIDGE_DIR, "config.json");
export const DISCORD_STATE_FILE = join(DISCORD_BRIDGE_DIR, "state.json");

const CONFIG_SOURCE_ID = randomUUID();
const CONFIG_AUTHORITY_VERSION = 1;
const MAX_CONFIG_SOURCES = 256;

export interface RelayPaths {
	directory: string;
	socket: string;
	leaderLock: string;
	recoveryLock: string;
	authToken: string;
	configIntent: string;
}

export function relayPaths(directory = DISCORD_BRIDGE_DIR): RelayPaths {
	return {
		directory,
		socket: process.platform === "win32"
			? `\\\\.\\pipe\\pi-discord-relay-${Buffer.from(directory).toString("hex").slice(-32)}`
			: join(directory, "relay.sock"),
		leaderLock: join(directory, "relay-owner.json"),
		recoveryLock: join(directory, "relay-recovery.lock"),
		authToken: join(directory, "relay-token"),
		configIntent: join(directory, "relay-config-intent.json"),
	};
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function loadOrCreateRelayToken(paths: RelayPaths): Promise<string> {
	await mkdir(paths.directory, { recursive: true, mode: 0o700 });
	await chmod(paths.directory, 0o700);
	try {
		const handle = await open(paths.authToken, "wx", 0o600);
		const token = randomBytes(32).toString("hex");
		try {
			await handle.writeFile(`${token}\n`);
			await handle.close();
			return token;
		} catch (error) {
			await handle.close().catch(() => {});
			await unlink(paths.authToken).catch(() => {});
			throw error;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			const token = (await readFile(paths.authToken, "utf8")).trim();
			if (/^[a-f0-9]{64}$/.test(token)) return token;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return loadOrCreateRelayToken(paths);
			throw error;
		}
		await wait(25);
	}
	throw new Error(`Local Discord relay token ${paths.authToken} is invalid`);
}

interface ConfigAuthorityState {
	version: 1;
	currentFingerprint: string;
	currentEpoch: number;
	sources: Record<string, { fingerprint: string; epoch: number; updatedAt: number }>;
}

async function withExclusiveLock<T>(lockFile: string, operation: () => Promise<T>): Promise<T> {
	let lock;
	for (let attempt = 0; !lock && attempt < 200; attempt++) {
		try {
			lock = await open(lockFile, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const lockStat = await stat(lockFile).catch(() => undefined);
			if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) await unlink(lockFile).catch(() => {});
			await wait(25);
		}
	}
	if (!lock) throw new Error(`Timed out waiting for Discord bridge lock ${lockFile}`);
	try {
		return await operation();
	} finally {
		await lock.close();
		await unlink(lockFile).catch(() => {});
	}
}

function effectiveFingerprint(config: Omit<DiscordBridgeConfig, "epoch">): string {
	return createHash("sha256")
		.update(`${config.token}\0${config.guildId}\0${config.categoryId ?? ""}`)
		.digest("hex");
}

async function authoritativeEpoch(
	file: string,
	config: Omit<DiscordBridgeConfig, "epoch">,
	seedEpoch: number,
): Promise<number> {
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const authorityFile = `${file}.authority.json`;
	return withExclusiveLock(`${authorityFile}.lock`, async () => {
		let authority: ConfigAuthorityState | undefined;
		try {
			const candidate = JSON.parse(await readFile(authorityFile, "utf8")) as Partial<ConfigAuthorityState>;
			if (candidate.version === CONFIG_AUTHORITY_VERSION && typeof candidate.currentFingerprint === "string" &&
				Number.isSafeInteger(candidate.currentEpoch) && candidate.currentEpoch! >= 0 && candidate.sources && typeof candidate.sources === "object") {
				authority = candidate as ConfigAuthorityState;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const fingerprint = effectiveFingerprint(config);
		const previous = authority?.sources[CONFIG_SOURCE_ID];
		let epoch = previous?.epoch;
		if (!authority) {
			epoch = Math.max(0, seedEpoch);
			authority = { version: CONFIG_AUTHORITY_VERSION, currentFingerprint: fingerprint, currentEpoch: epoch, sources: {} };
		} else if (authority.currentFingerprint === fingerprint) {
			epoch = authority.currentEpoch;
		} else if (!previous || previous.fingerprint !== fingerprint) {
			epoch = Math.max(authority.currentEpoch + 1, seedEpoch);
			authority.currentEpoch = epoch;
			authority.currentFingerprint = fingerprint;
		}
		epoch ??= authority.currentEpoch;
		authority.sources[CONFIG_SOURCE_ID] = { fingerprint, epoch, updatedAt: Date.now() };
		const sources = Object.entries(authority.sources)
			.sort((left, right) => right[1].updatedAt - left[1].updatedAt)
			.slice(0, MAX_CONFIG_SOURCES);
		authority.sources = Object.fromEntries(sources);
		const temporary = `${authorityFile}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(authority)}\n`, { mode: 0o600 });
		await rename(temporary, authorityFile);
		return epoch;
	});
}

export interface RelayConfigIntent {
	config: DiscordBridgeConfig;
	fingerprint: string;
}

export async function publishRelayConfigIntent(
	paths: RelayPaths,
	config: DiscordBridgeConfig,
	fingerprint: string,
): Promise<void> {
	await mkdir(paths.directory, { recursive: true, mode: 0o700 });
	await withExclusiveLock(`${paths.configIntent}.lock`, async () => {
		let current: RelayConfigIntent | undefined;
		try {
			const parsed = JSON.parse(await readFile(paths.configIntent, "utf8")) as { config?: unknown; fingerprint?: unknown };
			if (typeof parsed.fingerprint === "string" && parsed.config !== undefined) {
				current = { config: parseDiscordConfig(parsed.config), fingerprint: parsed.fingerprint };
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (current && (current.config.epoch > config.epoch ||
			(current.config.epoch === config.epoch && current.fingerprint === fingerprint))) return;
		if (current?.config.epoch === config.epoch && current.fingerprint !== fingerprint) {
			throw new Error(`Discord relay configuration epoch ${config.epoch} has conflicting fingerprints`);
		}
		const temporary = `${paths.configIntent}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify({ config, fingerprint })}\n`, { mode: 0o600 });
		await rename(temporary, paths.configIntent);
	});
}

export async function loadRelayConfigIntent(paths: RelayPaths): Promise<RelayConfigIntent> {
	try {
		const intent = JSON.parse(await readFile(paths.configIntent, "utf8")) as { config?: unknown; fingerprint?: unknown };
		if (typeof intent.fingerprint !== "string") throw new Error("missing fingerprint");
		return { config: parseDiscordConfig(intent.config), fingerprint: intent.fingerprint };
	} catch (error) {
		throw new Error(`Cannot read Discord relay configuration intent ${paths.configIntent}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function optionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function requiredString(value: unknown, key: string): string {
	const result = optionalString(value);
	if (!result) throw new Error(`Discord bridge config requires ${key}`);
	return result;
}

function discordId(value: unknown, key: string): string {
	const result = requiredString(value, key);
	if (!/^\d{5,25}$/.test(result)) throw new Error(`Discord bridge config ${key} must be a Discord ID`);
	return result;
}

export function parseDiscordConfig(value: unknown): DiscordBridgeConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Discord bridge config must be a JSON object");
	}
	const candidate = value as Record<string, unknown>;
	const categoryId = optionalString(candidate.categoryId);
	const epoch = candidate.epoch === undefined ? 0 : Number(candidate.epoch);
	if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Discord bridge config epoch must be a non-negative integer");
	return {
		token: requiredString(candidate.token, "token"),
		guildId: discordId(candidate.guildId, "guildId"),
		...(categoryId ? { categoryId: discordId(categoryId, "categoryId") } : {}),
		epoch,
	};
}

export async function loadDiscordConfig(
	file = DISCORD_CONFIG_FILE,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<DiscordBridgeConfig | null> {
	let fromFile: Record<string, unknown> = {};
	let fileEpoch = 0;
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("config must be a JSON object");
		}
		fromFile = parsed as Record<string, unknown>;
		fileEpoch = Math.floor((await stat(file)).mtimeMs);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`Cannot read Discord bridge config ${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const token = optionalString(environment.DISCORD_TOKEN) ?? fromFile.token;
	const guildId = optionalString(environment.DISCORD_GUILD_ID) ?? fromFile.guildId;
	const categoryOverride = optionalString(environment.DISCORD_CATEGORY_ID);
	const categoryId = categoryOverride ?? fromFile.categoryId;

	if (!token && !guildId && !categoryId) return null;
	const configuredEpoch = Number.isSafeInteger(fromFile.epoch) ? Number(fromFile.epoch) : 0;
	const effective = parseDiscordConfig({ token, guildId, categoryId, epoch: 0 });
	const epoch = await authoritativeEpoch(file, effective, Math.max(configuredEpoch, fileEpoch));
	return { ...effective, epoch };
}

export async function saveDiscordConfig(config: Omit<DiscordBridgeConfig, "epoch"> | DiscordBridgeConfig, file = DISCORD_CONFIG_FILE): Promise<void> {
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	await chmod(dirname(file), 0o700);
	const lockFile = `${file}.lock`;
	let lock;
	for (let attempt = 0; !lock && attempt < 200; attempt++) {
		try {
			lock = await open(lockFile, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const lockStat = await stat(lockFile).catch(() => undefined);
			if (lockStat && Date.now() - lockStat.mtimeMs > 30_000) await unlink(lockFile).catch(() => {});
			await wait(25);
		}
	}
	if (!lock) throw new Error(`Timed out waiting for Discord bridge config lock ${lockFile}`);
	try {
		let previousEpoch = -1;
		try {
			const existing = JSON.parse(await readFile(file, "utf8")) as { epoch?: unknown };
			const storedEpoch = Number.isSafeInteger(existing.epoch) && Number(existing.epoch) >= 0 ? Number(existing.epoch) : 0;
			previousEpoch = Math.max(storedEpoch, Math.floor((await stat(file)).mtimeMs));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") previousEpoch = -1;
		}
		const requestedEpoch = "epoch" in config ? config.epoch : 0;
		const validated = parseDiscordConfig({ ...config, epoch: Math.max(previousEpoch + 1, requestedEpoch) });
		const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(validated, null, "\t")}\n`, { mode: 0o600 });
		await rename(temporary, file);
		await chmod(file, 0o600);
	} finally {
		await lock.close();
		await unlink(lockFile).catch(() => {});
	}
}
