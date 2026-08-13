import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { marked } from "marked";

export const MAX_OUTBOUND_IMAGE_REFERENCES = 16;
export const MAX_OUTBOUND_IMAGES = 4;
export const MAX_OUTBOUND_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_OUTBOUND_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024;
export const MAX_OUTBOUND_IMAGE_PATH_LENGTH = 4_096;
const MAX_OUTBOUND_SNAPSHOT_ENTRIES = 2_000;
const LOGICAL_HASH_VERSION = "discord-outbound-v1";

export const OUTBOUND_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type OutboundImageMimeType = typeof OUTBOUND_IMAGE_MIME_TYPES[number];

export interface OutboundImageDescriptor {
	snapshot: string;
	digest: string;
	mimeType: OutboundImageMimeType;
	size: number;
	filename: string;
}

export interface DiscordOutboundAttachment {
	data: Buffer;
	mimeType: OutboundImageMimeType;
	filename: string;
}

export interface PreparedOutboundImages {
	images: OutboundImageDescriptor[];
	omitted: number;
}

const EXTENSION_MIME_TYPES = new Map<string, OutboundImageMimeType>([
	[".gif", "image/gif"],
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".png", "image/png"],
	[".webp", "image/webp"],
]);

function isDescendant(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function detectedMimeType(bytes: Uint8Array): OutboundImageMimeType | undefined {
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
		bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 6) {
		const signature = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
		if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
	}
	if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
		Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
	return undefined;
}

function generatedFilename(path: string, mimeType: OutboundImageMimeType, index: number): string {
	const extension = mimeType === "image/jpeg" ? ".jpg" : `.${mimeType.slice("image/".length)}`;
	const rawStem = basename(path, extname(path)).normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	const stem = (rawStem || "image").slice(0, 72);
	return `${stem}-${index + 1}${extension}`;
}

function normalizedReference(reference: string): string | undefined {
	if (!reference || reference.length > MAX_OUTBOUND_IMAGE_PATH_LENGTH || reference.includes("\0") || /^[a-z][a-z0-9+.-]*:/i.test(reference)) {
		return undefined;
	}
	try {
		return decodeURIComponent(reference);
	} catch {
		return undefined;
	}
}

export function assistantImagePaths(text: string): string[] {
	const paths: string[] = [], visited = new WeakSet<object>();
	const visit = (node: unknown): void => {
		if (!node || typeof node !== "object" || visited.has(node)) return; visited.add(node);
		if (Array.isArray(node)) { for (const child of node) visit(child); return; }
		const token = node as Record<string, unknown>;
		if (token.type === "image" && typeof token.href === "string") paths.push(token.href);
		for (const value of Object.values(token)) visit(value);
	};
	try { visit(marked.lexer(text)); } catch { return []; } return paths.slice(0, MAX_OUTBOUND_IMAGE_REFERENCES);
}

export function outboundLogicalHash(text: string, responseTo: readonly string[], references: readonly string[]): string {
	return createHash("sha256").update(LOGICAL_HASH_VERSION).update("\0")
		.update(JSON.stringify([text, responseTo, references])).digest("hex");
}

export function isOutboundImageDescriptor(value: unknown): value is OutboundImageDescriptor {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const image = value as Record<string, unknown>;
	const mimeType = image.mimeType as OutboundImageMimeType;
	return typeof image.snapshot === "string" && /^[0-9a-f-]{36}\.image$/.test(image.snapshot) &&
		typeof image.digest === "string" && /^[a-f0-9]{64}$/.test(image.digest) &&
		OUTBOUND_IMAGE_MIME_TYPES.includes(mimeType) && Number.isSafeInteger(image.size) &&
		Number(image.size) > 0 && Number(image.size) <= MAX_OUTBOUND_IMAGE_BYTES &&
		typeof image.filename === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(image.filename) &&
		EXTENSION_MIME_TYPES.get(extname(image.filename).toLowerCase()) === mimeType;
}

export function isOutboundImageDescriptorList(value: unknown): value is OutboundImageDescriptor[] {
	return Array.isArray(value) && value.length > 0 && value.length <= MAX_OUTBOUND_IMAGES &&
		value.every(isOutboundImageDescriptor) &&
		value.reduce((total, image) => total + image.size, 0) <= MAX_OUTBOUND_IMAGE_TOTAL_BYTES;
}

export function appendOutboundImageWarning(text: string, omitted = 0): string {
	if (omitted <= 0) return text;
	const notice = `⚠️ Discord omitted ${omitted} image attachment${omitted === 1 ? "" : "s"}.`;
	return text ? `${text}\n\n${notice}` : notice;
}

export class OutboundImageStore {
	constructor(readonly directory: string) {}

	async initialize(referenced: ReadonlySet<string>): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700);
		const entries = await readdir(this.directory, { withFileTypes: true });
		if (entries.length > MAX_OUTBOUND_SNAPSHOT_ENTRIES) throw new Error("Discord outbound image snapshot directory is full");
		for (const entry of entries) if (entry.isFile() && /^[0-9a-f-]{36}\.image$/.test(entry.name) && !referenced.has(entry.name))
			await unlink(resolve(this.directory, entry.name)).catch(() => {});
	}

	async prepare(root: string, references: readonly string[]): Promise<PreparedOutboundImages> {
		if ((await readdir(this.directory)).length + Math.min(references.length, MAX_OUTBOUND_IMAGES) > MAX_OUTBOUND_SNAPSHOT_ENTRIES) return { images: [], omitted: references.length };
		let canonicalRoot; try { canonicalRoot = await realpath(resolve(root)); } catch { return { images: [], omitted: references.length }; }
		const images: OutboundImageDescriptor[] = [], identities = new Set<string>();
		let omitted = Math.max(0, references.length - MAX_OUTBOUND_IMAGE_REFERENCES), totalBytes = 0;
		for (const rawReference of references.slice(0, MAX_OUTBOUND_IMAGE_REFERENCES)) {
			if (images.length >= MAX_OUTBOUND_IMAGES) { omitted++; continue; }
			let source, snapshot;
			const snapshotName = `${randomUUID()}.image`;
			try {
				const reference = normalizedReference(rawReference); if (!reference) throw new Error("unsafe reference");
				const lexicalPath = resolve(root, reference), lexicalStat = await lstat(lexicalPath), canonicalPath = await realpath(lexicalPath);
				if (lexicalStat.isSymbolicLink() || !isDescendant(canonicalRoot, canonicalPath)) throw new Error("unsafe reference");
				const mimeType = EXTENSION_MIME_TYPES.get(extname(canonicalPath).toLowerCase()); if (!mimeType) throw new Error("unsupported image");
				source = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
				const sourceStat = await source.stat(), pathStat = await lstat(canonicalPath);
				if (!sourceStat.isFile() || pathStat.isSymbolicLink() || sourceStat.dev !== pathStat.dev || sourceStat.ino !== pathStat.ino ||
					sourceStat.size <= 0 || sourceStat.size > MAX_OUTBOUND_IMAGE_BYTES) throw new Error("invalid image identity");
				const data = await source.readFile(); if (data.byteLength !== sourceStat.size ||
					detectedMimeType(data.subarray(0, 16)) !== mimeType) throw new Error("invalid image content");
				const digest = createHash("sha256").update(data).digest("hex"), identity = `${digest}:${data.byteLength}`;
				if (identities.has(identity) || totalBytes + data.byteLength > MAX_OUTBOUND_IMAGE_TOTAL_BYTES) throw new Error("duplicate or oversized");
				await mkdir(this.directory, { recursive: true, mode: 0o700 });
				snapshot = await open(resolve(this.directory, snapshotName), "wx", 0o600); await snapshot.writeFile(data);
				identities.add(identity); totalBytes += data.byteLength;
				images.push({ snapshot: snapshotName, digest, mimeType, size: data.byteLength,
					filename: generatedFilename(reference, mimeType, images.length) });
			} catch { omitted++; await unlink(resolve(this.directory, snapshotName)).catch(() => {}); }
			finally { await source?.close().catch(() => {}); await snapshot?.close().catch(() => {}); }
		}
		return { images, omitted };
	}

	async load(images: readonly OutboundImageDescriptor[]): Promise<{ files: DiscordOutboundAttachment[]; omitted: number }> {
		if (!isOutboundImageDescriptorList(images)) throw new Error("Discord outbound image metadata is invalid");
		const files: DiscordOutboundAttachment[] = []; let omitted = 0;
		for (const image of images) try {
			const path = resolve(this.directory, image.snapshot), fileStat = await lstat(path);
			if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== image.size) throw new Error("invalid snapshot");
			const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW), data = await handle.readFile().finally(() => handle.close());
			if (createHash("sha256").update(data).digest("hex") !== image.digest || detectedMimeType(data.subarray(0, 16)) !== image.mimeType)
				throw new Error("invalid snapshot");
			files.push({ data, mimeType: image.mimeType, filename: image.filename });
		} catch { omitted++; }
		return { files, omitted };
	}

	async remove(names: readonly string[]): Promise<void> {
		for (const name of names) if (/^[0-9a-f-]{36}\.image$/.test(name)) await unlink(resolve(this.directory, name)).catch(() => {});
	}
}
