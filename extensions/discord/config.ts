import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface DiscordBridgeConfig {
	token: string;
	guildId: string;
	categoryId?: string;
}

export const DISCORD_BRIDGE_DIR = join(homedir(), ".pi", "agent", "discord-bridge");
export const DISCORD_CONFIG_FILE = join(DISCORD_BRIDGE_DIR, "config.json");
export const DISCORD_STATE_FILE = join(DISCORD_BRIDGE_DIR, "state.json");

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
	return {
		token: requiredString(candidate.token, "token"),
		guildId: discordId(candidate.guildId, "guildId"),
		...(categoryId ? { categoryId: discordId(categoryId, "categoryId") } : {}),
	};
}

export async function loadDiscordConfig(
	file = DISCORD_CONFIG_FILE,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<DiscordBridgeConfig | null> {
	let fromFile: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("config must be a JSON object");
		}
		fromFile = parsed as Record<string, unknown>;
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
	return parseDiscordConfig({ token, guildId, categoryId });
}

export async function saveDiscordConfig(config: DiscordBridgeConfig, file = DISCORD_CONFIG_FILE): Promise<void> {
	const validated = parseDiscordConfig(config);
	await mkdir(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(validated, null, "\t")}\n`, { mode: 0o600 });
	await rename(temporary, file);
	await chmod(file, 0o600);
}
