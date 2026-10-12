import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const CONFIG_ENTRY = "pi-extensions-tree-memory-config-v1";
export const NODE_ENTRY = "pi-extensions-tree-memory-node-v1";
export const NODE_BYTES = 512;
export const VIEW_BYTES = 64_000;
export const SEARCH_SCAN_LIMIT = 2_048;

export interface TreeConfig {
	epoch: string;
	enabled: boolean;
	phase: "ready" | "error" | "disabled";
	backfill: boolean;
	createdAt: string;
	error?: string;
}

export interface TreeNode {
	epoch: string;
	id: number;
	n: number;
	text: string;
	sourceEntryId?: string;
	date?: string;
	usage?: unknown;
}

export interface Evidence {
	id: number;
	entryId: string;
	date: string;
	text: string;
}

export interface TreeSnapshot {
	config?: TreeConfig;
	evidence: Evidence[];
	nodes: Map<string, TreeNode>;
	view?: TreeNode[];
}

interface ContentPart {
	type?: string;
	text?: string;
	mimeType?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

function partsText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((raw) => {
			const part = raw as ContentPart;
			if (part.type === "thinking") return [];
			if (part.type === "text") return [part.text ?? ""];
			if (part.type === "image") return [`[image: ${part.mimeType ?? "unknown"}; original media remains in the Pi session]`];
			if (part.type === "toolCall") {
				return [JSON.stringify({ id: part.id, name: part.name, arguments: part.arguments })];
			}
			return [];
		})
		.join("\n");
}

/** Exact model-visible evidence, excluding hidden reasoning and opaque image bytes. */
export function visibleEvidence(message: unknown): string | undefined {
	const candidate = message as { role?: string; toolName?: string; toolCallId?: string; content?: unknown };
	if (candidate.role === "system") return undefined;
	const body = partsText(candidate.content);
	if (!body) return undefined;
	const role = candidate.role === "toolResult"
		? `toolResult ${candidate.toolName ?? "unknown"} (${candidate.toolCallId ?? "unknown"})`
		: candidate.role;
	return `${role}: ${body}`;
}

export const nodeKey = (id: number, n: number): string => `${id}+${n}`;
export const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

export function latestConfig(entries: readonly SessionEntry[]): TreeConfig | undefined {
	let config: TreeConfig | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CONFIG_ENTRY) continue;
		const value = entry.data as Partial<TreeConfig> | undefined;
		if (
			value && typeof value.epoch === "string" && typeof value.enabled === "boolean" &&
			(value.phase === "ready" || value.phase === "error" || value.phase === "disabled")
		) {
			config = value as TreeConfig;
		}
	}
	return config;
}

export function collectEvidence(entries: readonly SessionEntry[], omitLastUser = false): Evidence[] {
	const messages = entries.filter((entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message");
	let omitted = false;
	const selected = omitLastUser
		? [...messages].reverse().filter((entry) => {
			if (!omitted && entry.message.role === "user") {
				omitted = true;
				return false;
			}
			return true;
		}).reverse()
		: messages;
	const result: Evidence[] = [];
	for (const entry of selected) {
		const text = visibleEvidence(entry.message);
		if (text === undefined) continue;
		result.push({ id: result.length, entryId: entry.id, date: entry.timestamp, text });
	}
	return result;
}

export function collectNodes(entries: readonly SessionEntry[], epoch: string): Map<string, TreeNode> {
	const nodes = new Map<string, TreeNode>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== NODE_ENTRY) continue;
		const node = entry.data as Partial<TreeNode> | undefined;
		if (
			node?.epoch === epoch && Number.isSafeInteger(node.id) && Number.isSafeInteger(node.n) &&
			(node.id ?? -1) >= 0 && (node.n ?? 0) >= 1 && typeof node.text === "string" &&
			utf8Bytes(node.text) <= NODE_BYTES
		) {
			nodes.set(nodeKey(node.id!, node.n!), node as TreeNode);
		}
	}
	return nodes;
}

export function validateAddress(id: number, n: number, count: number): void {
	if (
		!Number.isSafeInteger(id) || !Number.isSafeInteger(n) || id < 0 || n < 1 ||
		!Number.isInteger(Math.log2(n)) || id % n !== 0 || id + n > count
	) throw new Error("Invalid tree range");
}

export function buildView(nodes: ReadonlyMap<string, TreeNode>, count: number, budget = VIEW_BYTES): TreeNode[] | undefined {
	const view: TreeNode[] = [];
	for (let id = 0; id < count; id++) {
		const leaf = nodes.get(nodeKey(id, 1));
		if (!leaf) return undefined;
		view.push(leaf);
	}
	const renderedBytes = () => utf8Bytes(renderView(view));
	while (renderedBytes() > budget) {
		let merged = false;
		for (let index = 0; index + 1 < view.length; index++) {
			const left = view[index]!;
			const right = view[index + 1]!;
			const n = left.n * 2;
			if (left.n !== right.n || right.id !== left.id + left.n || left.id % n !== 0) continue;
			const parent = nodes.get(nodeKey(left.id, n));
			if (!parent) continue;
			view.splice(index, 2, parent);
			merged = true;
			break;
		}
		if (!merged) return undefined;
	}
	return view;
}

export function renderView(view: readonly TreeNode[]): string {
	return `<chat>\n${view.map((node) => `${nodeKey(node.id, node.n)}|${node.text.replace(/\r?\n/g, " ")}`).join("\n")}\n</chat>`;
}

export function snapshot(entries: readonly SessionEntry[], omitLastUser = false): TreeSnapshot {
	const config = latestConfig(entries);
	const evidence = collectEvidence(entries, omitLastUser);
	const nodes = config ? collectNodes(entries, config.epoch) : new Map<string, TreeNode>();
	return { config, evidence, nodes, view: config?.enabled ? buildView(nodes, evidence.length) : undefined };
}

export function bytePage(text: string, offset: number, limit = 12_000): { text: string; nextOffset: number | null; totalBytes: number } {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid evidence offset");
	const bytes = Buffer.from(text, "utf8");
	if (offset > bytes.length) throw new Error("Evidence offset exceeds original length");
	if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) throw new Error("Evidence offset must be a page cursor");
	let end = Math.min(bytes.length, offset + limit);
	while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
	return {
		text: bytes.subarray(offset, end).toString("utf8"),
		nextOffset: end < bytes.length ? end : null,
		totalBytes: bytes.length,
	};
}

export function searchEvidence(
	evidence: readonly Evidence[], query: string, cursor = 0, limit = 8,
): { matches: Array<Evidence & { offset: number; snippet: string }>; scanned: number; nextCursor: number | null } {
	const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
	if (query.length > 200 || terms.length === 0 || terms.length > 8) throw new Error("Search query requires 1–8 keywords, at most 200 characters");
	if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > evidence.length) throw new Error("Invalid search cursor");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid search limit (1–20)");
	const lowered = terms.map((term) => term.toLocaleLowerCase());
	const matches: Array<Evidence & { offset: number; snippet: string }> = [];
	const end = Math.min(evidence.length, cursor + SEARCH_SCAN_LIMIT);
	let next = cursor;
	while (next < end && matches.length < limit) {
		const item = evidence[next++]!;
		const source = item.text.toLocaleLowerCase();
		const hit = lowered.map((term) => source.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0];
		if (hit === undefined) continue;
		const start = Math.max(0, hit - 120);
		matches.push({ ...item, offset: Buffer.byteLength(item.text.slice(0, start), "utf8"), snippet: item.text.slice(start, start + 600) });
	}
	return { matches, scanned: next - cursor, nextCursor: next < evidence.length ? next : null };
}
