import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

const TASK_FILE = "TASK.md";
const MAX_TASK_FILE_BYTES = 16_384;
const MAX_TASK_TITLE_LENGTH = 200;

function validTitle(value: string): string | undefined {
	const title = value.trim();
	if (!title || [...title].length > MAX_TASK_TITLE_LENGTH) return undefined;
	if ([...title].some((character) => {
		const code = character.codePointAt(0)!;
		return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
	})) return undefined;
	return title;
}

function frontmatterTitle(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const quote = trimmed[0];
	if (quote === '"' || quote === "'") {
		if (trimmed.at(-1) !== quote || trimmed.slice(1, -1).includes(quote)) return undefined;
		return validTitle(trimmed.slice(1, -1));
	}
	if ("|>{}[]!&*".includes(trimmed[0]!) || /["']$/u.test(trimmed)) return undefined;
	return validTitle(trimmed);
}

export function parseTaskTitle(content: string): string | undefined {
	if (content.includes("\0")) return undefined;
	const lines = content.replace(/^\uFEFF/u, "").split(/\r?\n/);
	let bodyStart = 0;
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
		if (end < 0) return undefined;
		let title: string | undefined;
		for (const line of lines.slice(1, end)) {
			const match = line.match(/^title\s*:\s*(.*)$/u);
			if (!match) continue;
			if (title !== undefined) return undefined;
			title = frontmatterTitle(match[1] ?? "");
			if (!title) return undefined;
		}
		if (title) return title;
		bodyStart = end + 1;
	}
	for (const line of lines.slice(bodyStart)) {
		const match = line.match(/^#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u);
		if (!match) continue;
		return validTitle(match[1] ?? "");
	}
	return undefined;
}

async function readBoundedTaskFile(path: string): Promise<string | undefined> {
	const before = await lstat(path);
	if (!before.isFile() || before.size > MAX_TASK_FILE_BYTES) return undefined;
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const after = await file.stat();
		if (!after.isFile() || after.size > MAX_TASK_FILE_BYTES || after.dev !== before.dev || after.ino !== before.ino) return undefined;
		const buffer = Buffer.alloc(MAX_TASK_FILE_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > MAX_TASK_FILE_BYTES) return undefined;
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
	} finally {
		await file.close();
	}
}

export async function discoverTaskTitle(checkoutRoot: string): Promise<string | undefined> {
	try {
		const root = await realpath(checkoutRoot);
		return parseTaskTitle(await readBoundedTaskFile(join(root, TASK_FILE)) ?? "");
	} catch {
		return undefined;
	}
}
