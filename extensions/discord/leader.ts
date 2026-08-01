import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import type { RelayPaths } from "./config.js";
import { encodeFrame, isServerFrame, parseFrame } from "./protocol.js";

const INCOMPLETE_LOCK_GRACE_MS = 5_000;
const OWNER_HEARTBEAT_TIMEOUT_MS = 5_000;
const OWNER_FENCE_WAIT_MS = 1_100;
const execFileAsync = promisify(execFile);

interface LeaderMetadata {
	pid: number;
	nonce: string;
	createdAt: number;
	processIdentity: string;
}

export interface LeaderInspection {
	lookupProcessIdentity(pid: number): Promise<string | undefined>;
	probeRelay(path: string): Promise<boolean>;
	wait(milliseconds: number): Promise<void>;
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

async function protocolReachable(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(path);
		let settled = false;
		let buffer = "";
		const done = (reachable: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(reachable);
		};
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(encodeFrame({ type: "ping" })));
		socket.on("data", (data: string) => {
			buffer += data;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			try {
				const frame = parseFrame(buffer.slice(0, newline));
				done(isServerFrame(frame) && frame.type === "pong");
			} catch {
				done(false);
			}
		});
		socket.once("error", () => done(false));
		setTimeout(() => done(false), 200).unref();
	});
}

const defaultInspection: LeaderInspection = {
	lookupProcessIdentity: processIdentity,
	probeRelay: protocolReachable,
	wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

async function currentMetadata(paths: RelayPaths): Promise<LeaderMetadata | undefined> {
	try {
		return parseMetadata(await readFile(paths.leaderLock, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function takeoverEligible(
	paths: RelayPaths,
	inspection: LeaderInspection,
): Promise<{ eligible: boolean; requiresFenceWait: boolean }> {
	const metadata = await currentMetadata(paths);
	const ownerStat = await stat(paths.leaderLock).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!ownerStat) return { eligible: true, requiresFenceWait: false };
	const heartbeatExpired = Date.now() - ownerStat.mtimeMs >= OWNER_HEARTBEAT_TIMEOUT_MS;
	if (!metadata) {
		if (!heartbeatExpired) return { eligible: false, requiresFenceWait: false };
		return { eligible: !(await inspection.probeRelay(paths.socket)), requiresFenceWait: true };
	}
	if (!processExists(metadata.pid)) return { eligible: true, requiresFenceWait: false };
	const identity = await inspection.lookupProcessIdentity(metadata.pid);
	if (identity !== undefined && identity !== metadata.processIdentity) {
		return { eligible: true, requiresFenceWait: false };
	}
	if (!heartbeatExpired) return { eligible: false, requiresFenceWait: false };
	if (await inspection.probeRelay(paths.socket)) return { eligible: false, requiresFenceWait: false };
	return { eligible: true, requiresFenceWait: true };
}

async function recoverStaleLeader(paths: RelayPaths, inspection: LeaderInspection): Promise<boolean> {
	if (!(await takeoverEligible(paths, inspection)).eligible) return false;
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
		const rechecked = await takeoverEligible(paths, inspection);
		if (!rechecked.eligible) return false;
		await unlink(paths.leaderLock).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (process.platform !== "win32") {
			await unlink(paths.socket).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
		if (rechecked.requiresFenceWait) await inspection.wait(OWNER_FENCE_WAIT_MS);
		return true;
	} finally {
		await recovery.close();
		await unlink(paths.recoveryLock).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

export async function tryAcquireLeader(
	paths: RelayPaths,
	inspectionOverrides: Partial<LeaderInspection> = {},
): Promise<LeaderLease | undefined> {
	const inspection: LeaderInspection = { ...defaultInspection, ...inspectionOverrides };
	await mkdir(paths.directory, { recursive: true, mode: 0o700 });
	await chmod(paths.directory, 0o700);
	const nonce = randomUUID();
	let handle;
	try {
		handle = await open(paths.leaderLock, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		await recoverStaleLeader(paths, inspection);
		return undefined;
	}
	const identity = await inspection.lookupProcessIdentity(process.pid);
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
