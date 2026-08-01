import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import type { RelayPaths } from "./config.js";

const INCOMPLETE_LOCK_GRACE_MS = 5_000;
const execFileAsync = promisify(execFile);

interface LeaderMetadata {
	pid: number;
	nonce: string;
	createdAt: number;
	processIdentity: string;
}

export interface LeaderLease {
	pid: number;
	nonce: string;
	heartbeat(): Promise<boolean>;
	release(): Promise<void>;
}

function parseMetadata(value: string): LeaderMetadata | undefined {
	try {
		const parsed = JSON.parse(value) as Partial<LeaderMetadata>;
		if (typeof parsed.pid !== "number" || typeof parsed.nonce !== "string" || typeof parsed.createdAt !== "number" ||
			typeof parsed.processIdentity !== "string") return undefined;
		return { pid: parsed.pid, nonce: parsed.nonce, createdAt: parsed.createdAt, processIdentity: parsed.processIdentity };
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

async function processIdentity(pid: number): Promise<string | undefined> {
	try {
		if (process.platform === "linux") {
			const fields = (await readFile(`/proc/${pid}/stat`, "utf8")).trim().split(" ");
			return `linux:${fields[21]}`;
		}
		if (process.platform === "win32") {
			const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToFileTimeUtc()`;
			const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
			const identity = stdout.trim();
			return identity ? `win32:${identity}` : undefined;
		}
		const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="]);
		const identity = stdout.trim();
		return identity ? `${process.platform}:${identity}` : undefined;
	} catch {
		return undefined;
	}
}

async function socketReachable(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(path);
		const done = (reachable: boolean) => {
			socket.destroy();
			resolve(reachable);
		};
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
		setTimeout(() => done(false), 200).unref();
	});
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
	if (metadata && processExists(metadata.pid)) {
		const sameProcess = (await processIdentity(metadata.pid)) === metadata.processIdentity;
		if (sameProcess && await socketReachable(paths.socket)) return false;
		const ownerStat = await stat(paths.leaderLock).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (!ownerStat) return true;
		if (sameProcess && Date.now() - ownerStat.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) return false;
	}
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
		if (rechecked && processExists(rechecked.pid) &&
			(await processIdentity(rechecked.pid)) === rechecked.processIdentity &&
			await socketReachable(paths.socket)) return false;
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
	const identity = await processIdentity(process.pid);
	if (!identity) {
		await handle.close();
		await unlink(paths.leaderLock).catch(() => {});
		throw new Error("Cannot determine local Discord relay process identity");
	}
	const metadata: LeaderMetadata = { pid: process.pid, nonce, createdAt: Date.now(), processIdentity: identity };
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
		async heartbeat() {
			const current = await currentMetadata(paths);
			if (current?.nonce !== nonce) return false;
			const now = new Date();
			await utimes(paths.leaderLock, now, now);
			return (await currentMetadata(paths))?.nonce === nonce;
		},
		async release() {
			const current = await currentMetadata(paths);
			if (current?.nonce !== nonce) return;
			await unlink(paths.leaderLock).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		},
	};
}
