import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";

export const MAX_OUTBOUND_IMAGES = 4;
export const MAX_OUTBOUND_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_OUTBOUND_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_OUTBOUND_SNAPSHOT_ENTRIES = 2_000;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_OUTBOUND_IMAGE_BYTES / 3);
const LOGICAL_HASH_VERSION = "discord-native-outbound-v2";

export const OUTBOUND_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type OutboundImageMimeType = typeof OUTBOUND_IMAGE_MIME_TYPES[number];

export interface NativeOutboundImage {
	type: "image";
	data: string;
	mimeType: OutboundImageMimeType;
}

export interface OutboundImageDescriptor {
	version: 1;
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

export interface SettledReply {
	messageId: string;
	text: string;
	responseTo: string[];
	images: NativeOutboundImage[];
}

interface ValidatedImage {
	data: Buffer;
	digest: string;
	mimeType: OutboundImageMimeType;
}

const MIME_EXTENSIONS: Record<OutboundImageMimeType, string> = {
	"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
};

function detectedMimeType(bytes: Uint8Array): OutboundImageMimeType | undefined {
	if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	const ascii = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
	if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
	if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
	return undefined;
}

function validateImage(value: unknown): ValidatedImage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const image = value as Record<string, unknown>, mimeType = image.mimeType as OutboundImageMimeType;
	if (image.type !== "image" || typeof image.data !== "string" || image.data.length === 0 ||
		image.data.length > MAX_BASE64_LENGTH || !OUTBOUND_IMAGE_MIME_TYPES.includes(mimeType) ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) return undefined;
	const data = Buffer.from(image.data, "base64");
	if (data.length === 0 || data.length > MAX_OUTBOUND_IMAGE_BYTES || data.toString("base64") !== image.data ||
		detectedMimeType(data.subarray(0, 16)) !== mimeType) return undefined;
	return { data, mimeType, digest: createHash("sha256").update(data).digest("hex") };
}

export function isNativeOutboundImageList(value: unknown): value is NativeOutboundImage[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OUTBOUND_IMAGES) return false;
	const validated = value.map(validateImage);
	return validated.every(Boolean) && validated.reduce((total, image) => total + image!.data.length, 0) <= MAX_OUTBOUND_IMAGE_TOTAL_BYTES &&
		new Set(validated.map((image) => image!.digest)).size === validated.length;
}

export function isOutboundImageDescriptor(value: unknown): value is OutboundImageDescriptor {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const image = value as Record<string, unknown>, mimeType = image.mimeType as OutboundImageMimeType;
	return image.version === 1 && typeof image.snapshot === "string" && /^[0-9a-f-]{36}\.image$/.test(image.snapshot) &&
		typeof image.digest === "string" && /^[a-f0-9]{64}$/.test(image.digest) && OUTBOUND_IMAGE_MIME_TYPES.includes(mimeType) &&
		Number.isSafeInteger(image.size) && Number(image.size) > 0 && Number(image.size) <= MAX_OUTBOUND_IMAGE_BYTES &&
		typeof image.filename === "string" && /^image-[1-4]\.(?:jpg|png|gif|webp)$/.test(image.filename) &&
		image.filename === `image-${image.filename.slice(6, 7)}.${MIME_EXTENSIONS[mimeType]}`;
}

export function isOutboundImageDescriptorList(value: unknown): value is OutboundImageDescriptor[] {
	return Array.isArray(value) && value.length > 0 && value.length <= MAX_OUTBOUND_IMAGES && value.every((image, index) =>
		isOutboundImageDescriptor(image) && image.filename === `image-${index + 1}.${MIME_EXTENSIONS[image.mimeType]}`) &&
		value.reduce((total, image) => total + image.size, 0) <= MAX_OUTBOUND_IMAGE_TOTAL_BYTES &&
		new Set(value.map((image) => image.digest)).size === value.length;
}

export function isLegacyOutboundImageDescriptorList(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0 && value.length <= MAX_OUTBOUND_IMAGES && value.every((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
		const image = entry as Record<string, unknown>;
		return image.version === undefined && typeof image.snapshot === "string" && /^[0-9a-f-]{36}\.image$/.test(image.snapshot) &&
			typeof image.digest === "string" && /^[a-f0-9]{64}$/.test(image.digest);
	});
}

function logicalDescriptors(images: readonly NativeOutboundImage[]): Array<Record<string, unknown>> {
	return images.map((image, index) => {
		const validated = validateImage(image);
		if (!validated) throw new Error("Discord native outbound image is invalid");
		return { version: 1, digest: validated.digest, mimeType: validated.mimeType, size: validated.data.length,
			filename: `image-${index + 1}.${MIME_EXTENSIONS[validated.mimeType]}` };
	});
}

export function outboundLogicalHash(text: string, responseTo: readonly string[], images: readonly NativeOutboundImage[]): string {
	return createHash("sha256").update(LOGICAL_HASH_VERSION).update("\0")
		.update(JSON.stringify([text, responseTo, logicalDescriptors(images)])).digest("hex");
}

export function splitOutboundText(text: string, maximum = 1_900): string[] {
	if (!Number.isInteger(maximum) || maximum < 1 || maximum > 2_000) throw new Error("Invalid Discord outbound text limit");
	const chunks: string[] = []; let remaining = text;
	while (remaining.length > maximum) {
		let cut = remaining.lastIndexOf("\n", maximum - 1);
		if (cut >= Math.floor(maximum / 2)) cut++;
		else { cut = remaining.lastIndexOf(" ", maximum); if (cut < 1) cut = maximum; }
		if (/^[\uDC00-\uDFFF]$/.test(remaining[cut] ?? "") && /[\uD800-\uDBFF]/.test(remaining[cut - 1] ?? "")) cut--;
		chunks.push(remaining.slice(0, cut)); remaining = remaining.slice(cut);
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

export class SettledReplyCollector {
	private images: NativeOutboundImage[] = [];
	private digests = new Set<string>();
	private totalBytes = 0;
	private candidate?: SettledReply;

	recordToolResult(message: { role?: string; content?: unknown }): void {
		if (message.role !== "toolResult" || !Array.isArray(message.content)) return;
		for (const block of message.content) {
			const image = validateImage(block);
			if (!image || this.images.length >= MAX_OUTBOUND_IMAGES || this.totalBytes + image.data.length > MAX_OUTBOUND_IMAGE_TOTAL_BYTES ||
				this.digests.has(image.digest)) continue;
			this.images.push({ type: "image", data: image.data.toString("base64"), mimeType: image.mimeType });
			this.digests.add(image.digest); this.totalBytes += image.data.length;
		}
	}

	recordAssistant(message: { role?: string; content?: unknown; stopReason?: string }, responseTo: readonly string[]): void {
		this.candidate = undefined;
		if (message.role !== "assistant" || (message.stopReason !== "stop" && message.stopReason !== "length") ||
			!Array.isArray(message.content) || message.content.some((part) => part && typeof part === "object" &&
				(part as { type?: unknown }).type === "toolCall")) return;
		const text = message.content.filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object" &&
			(part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string").map((part) => part.text).join("");
		if (!/\S/u.test(text)) return;
		this.candidate = { messageId: randomUUID(), text, responseTo: [...responseTo], images: this.images.map((image) => ({ ...image })) };
	}

	settle(): SettledReply | undefined {
		const candidate = this.candidate;
		this.images = []; this.digests.clear(); this.totalBytes = 0; this.candidate = undefined;
		return candidate;
	}
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

	async prepare(payloads: readonly NativeOutboundImage[]): Promise<OutboundImageDescriptor[]> {
		if ((await readdir(this.directory)).length + payloads.length > MAX_OUTBOUND_SNAPSHOT_ENTRIES) return [];
		const images: OutboundImageDescriptor[] = [], digests = new Set<string>(); let totalBytes = 0;
		for (const payload of payloads.slice(0, MAX_OUTBOUND_IMAGES)) {
			const image = validateImage(payload), snapshotName = `${randomUUID()}.image`; let snapshot;
			try {
				if (!image || digests.has(image.digest) || totalBytes + image.data.length > MAX_OUTBOUND_IMAGE_TOTAL_BYTES) continue;
				snapshot = await open(resolve(this.directory, snapshotName), "wx", 0o600); await snapshot.writeFile(image.data);
				digests.add(image.digest); totalBytes += image.data.length;
				images.push({ version: 1, snapshot: snapshotName, digest: image.digest, mimeType: image.mimeType, size: image.data.length,
					filename: `image-${images.length + 1}.${MIME_EXTENSIONS[image.mimeType]}` });
			} catch { await unlink(resolve(this.directory, snapshotName)).catch(() => {}); }
			finally { await snapshot?.close().catch(() => {}); }
		}
		return images;
	}

	async load(images: readonly OutboundImageDescriptor[]): Promise<DiscordOutboundAttachment[]> {
		if (!isOutboundImageDescriptorList(images)) throw new Error("Discord outbound image metadata is invalid");
		const files: DiscordOutboundAttachment[] = [];
		for (const image of images) try {
			const path = resolve(this.directory, image.snapshot), fileStat = await lstat(path);
			if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== image.size) continue;
			const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW), data = await handle.readFile().finally(() => handle.close());
			if (createHash("sha256").update(data).digest("hex") === image.digest && detectedMimeType(data.subarray(0, 16)) === image.mimeType)
				files.push({ data, mimeType: image.mimeType, filename: image.filename });
		} catch {}
		return files;
	}

	async remove(names: readonly string[]): Promise<void> {
		for (const name of names) if (/^[0-9a-f-]{36}\.image$/.test(name)) await unlink(resolve(this.directory, name)).catch(() => {});
	}
}
