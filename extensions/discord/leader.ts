import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import type { RelayPaths } from "./config.js";

const INCOMPLETE_LOCK_GRACE_MS = 2_000;

interface LeaderMetadata {
	pid: number;
	nonce: string;
	createdAt: number;
}

export interface LeaderLease {
	pid: number;
	nonce: string;
	release(): Promise<void>;
}

function parseMetadata(value: string): LeaderMetadata | undefined {
	try {
		const parsed = JSON.parse(value) as Partial<LeaderMetadata>;
		if (typeof parsed.pid !== "number" || typeof parsed.nonce !== "string" || typeof parsed.createdAt !== "number") return undefined;
		return { pid: parsed.pid, nonce: parsed.nonce, createdAt: parsed.createdAt };
	} catch {
		return undefined;
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function currentMetadata(paths: RelayPaths): Promise<LeaderMetadata | undefined> {
	try {
		return parseMetadata(await readFile(paths.leaderLock, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function recoverStaleLeader(paths: RelayPaths): Promise<boolean> {
	const metadata = await currentMetadata(paths);
	if (metadata && processExists(metadata.pid)) return false;
	if (!metadata) {
		try {
			const ownerStat = await stat(paths.leaderLock);
			if (Date.now() - ownerStat.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
			throw error;
		}
	}

	let recovery;
	try {
		recovery = await open(paths.recoveryLock, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		try {
			const recoveryStat = await stat(paths.recoveryLock);
			if (Date.now() - recoveryStat.mtimeMs > INCOMPLETE_LOCK_GRACE_MS) await unlink(paths.recoveryLock);
		} catch (statError) {
			if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
		}
		return false;
	}
	try {
		const rechecked = await currentMetadata(paths);
		if (rechecked && processExists(rechecked.pid)) return false;
		await unlink(paths.leaderLock).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (process.platform !== "win32") {
			await unlink(paths.socket).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
		return true;
	} finally {
		await recovery.close();
		await unlink(paths.recoveryLock).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

export async function tryAcquireLeader(paths: RelayPaths): Promise<LeaderLease | undefined> {
	await mkdir(paths.directory, { recursive: true, mode: 0o700 });
	await chmod(paths.directory, 0o700);
	const nonce = randomUUID();
	let handle;
	try {
		handle = await open(paths.leaderLock, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		await recoverStaleLeader(paths);
		return undefined;
	}
	const metadata: LeaderMetadata = { pid: process.pid, nonce, createdAt: Date.now() };
	try {
		await handle.writeFile(`${JSON.stringify(metadata)}\n`);
		await handle.close();
	} catch (error) {
		await handle.close().catch(() => {});
		await unlink(paths.leaderLock).catch(() => {});
		throw error;
	}
	return {
		pid: process.pid,
		nonce,
		async release() {
			const current = await currentMetadata(paths);
			if (current?.nonce !== nonce) return;
			await unlink(paths.leaderLock).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		},
	};
}
