import { open, lstat, readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_OUTBOUND_IMAGE_REFERENCES = 16;
export const MAX_OUTBOUND_IMAGES = 4;
export const MAX_OUTBOUND_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_OUTBOUND_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024;
export const MAX_OUTBOUND_IMAGE_PATH_LENGTH = 4_096;

export const OUTBOUND_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type OutboundImageMimeType = typeof OUTBOUND_IMAGE_MIME_TYPES[number];

export interface OutboundImageDescriptor {
	localPath: string;
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
	warning?: string;
}

type Rejection = "count" | "duplicate" | "missing" | "oversized" | "unsafe" | "unsupported";

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

function warning(rejections: ReadonlyMap<Rejection, number>): string | undefined {
	if (rejections.size === 0) return undefined;
	const labels: Record<Rejection, string> = {
		count: "count limit",
		duplicate: "duplicate",
		missing: "missing",
		oversized: "oversized",
		unsafe: "unsafe path",
		unsupported: "unsupported type",
	};
	const detail = [...rejections].map(([reason, count]) => `${labels[reason]} ${count}`).join(", ");
	return `⚠️ Images omitted: ${detail}.`.slice(0, 96);
}

function reject(rejections: Map<Rejection, number>, reason: Rejection): void {
	rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
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

async function signature(path: string): Promise<Buffer> {
	const handle = await open(path, "r");
	try {
		const header = Buffer.alloc(16);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		return header.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

export function assistantImagePaths(text: string): string[] {
	const paths: string[] = [];
	const pattern = /!\[[^\]\r\n]{0,512}\]\((?:<([^>\r\n]{1,4096})>|([^()\r\n]{1,4096}))\)/g;
	for (const match of text.matchAll(pattern)) {
		if (paths.length >= MAX_OUTBOUND_IMAGE_REFERENCES) break;
		const path = (match[1] ?? match[2] ?? "").trim();
		if (path) paths.push(path);
	}
	return paths;
}

export function isOutboundImageDescriptor(value: unknown): value is OutboundImageDescriptor {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const image = value as Record<string, unknown>;
	const mimeType = image.mimeType as OutboundImageMimeType;
	return typeof image.localPath === "string" && image.localPath.length > 0 &&
		image.localPath.length <= MAX_OUTBOUND_IMAGE_PATH_LENGTH && isAbsolute(image.localPath) &&
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

export async function prepareOutboundImages(root: string, references: readonly string[]): Promise<PreparedOutboundImages> {
	const canonicalRoot = await realpath(resolve(root));
	const images: OutboundImageDescriptor[] = [];
	const canonicalPaths = new Set<string>();
	const rejections = new Map<Rejection, number>();
	let totalBytes = 0;
	for (const rawReference of references.slice(0, MAX_OUTBOUND_IMAGE_REFERENCES)) {
		if (images.length >= MAX_OUTBOUND_IMAGES) {
			reject(rejections, "count");
			continue;
		}
		const reference = normalizedReference(rawReference);
		if (!reference) {
			reject(rejections, "unsafe");
			continue;
		}
		const lexicalPath = resolve(root, reference);
		let fileStat;
		let canonicalPath: string;
		try {
			fileStat = await lstat(lexicalPath);
			canonicalPath = await realpath(lexicalPath);
		} catch {
			reject(rejections, "missing");
			continue;
		}
		if (!isDescendant(canonicalRoot, canonicalPath) || !fileStat.isFile() || fileStat.isSymbolicLink()) {
			reject(rejections, "unsafe");
			continue;
		}
		if (canonicalPaths.has(canonicalPath)) {
			reject(rejections, "duplicate");
			continue;
		}
		const mimeType = EXTENSION_MIME_TYPES.get(extname(canonicalPath).toLowerCase());
		if (!mimeType) {
			reject(rejections, "unsupported");
			continue;
		}
		if (fileStat.size <= 0 || fileStat.size > MAX_OUTBOUND_IMAGE_BYTES || totalBytes + fileStat.size > MAX_OUTBOUND_IMAGE_TOTAL_BYTES) {
			reject(rejections, "oversized");
			continue;
		}
		if (detectedMimeType(await signature(canonicalPath)) !== mimeType) {
			reject(rejections, "unsupported");
			continue;
		}
		canonicalPaths.add(canonicalPath);
		totalBytes += fileStat.size;
		images.push({
			localPath: canonicalPath,
			mimeType,
			size: fileStat.size,
			filename: generatedFilename(canonicalPath, mimeType, images.length),
		});
	}
	if (references.length > MAX_OUTBOUND_IMAGE_REFERENCES) {
		rejections.set("count", (rejections.get("count") ?? 0) + references.length - MAX_OUTBOUND_IMAGE_REFERENCES);
	}
	const rejectionWarning = warning(rejections);
	return { images, ...(rejectionWarning ? { warning: rejectionWarning } : {}) };
}

export async function loadOutboundImages(root: string, images: readonly OutboundImageDescriptor[]): Promise<DiscordOutboundAttachment[]> {
	if (!isOutboundImageDescriptorList(images)) throw new Error("Discord outbound image metadata is invalid");
	const canonicalRoot = await realpath(resolve(root));
	const result: DiscordOutboundAttachment[] = [];
	let totalBytes = 0;
	for (const image of images) {
		const fileStat = await lstat(image.localPath);
		const canonicalPath = await realpath(image.localPath);
		if (!isDescendant(canonicalRoot, canonicalPath) || !fileStat.isFile() || fileStat.isSymbolicLink() ||
			fileStat.size !== image.size || fileStat.size > MAX_OUTBOUND_IMAGE_BYTES) {
			throw new Error("Discord outbound image file no longer matches validated metadata");
		}
		totalBytes += fileStat.size;
		if (totalBytes > MAX_OUTBOUND_IMAGE_TOTAL_BYTES) throw new Error("Discord outbound images exceed total byte limit");
		const data = await readFile(canonicalPath);
		if (data.byteLength !== image.size || detectedMimeType(data.subarray(0, 16)) !== image.mimeType) {
			throw new Error("Discord outbound image content no longer matches validated metadata");
		}
		result.push({ data, mimeType: image.mimeType, filename: image.filename });
	}
	return result;
}

export function appendOutboundImageWarning(text: string, warningText?: string, failed = false): string {
	const notice = failed ? "⚠️ Discord omitted image attachments: file validation or upload failed." : warningText;
	if (!notice) return text;
	return text ? `${text}\n\n${notice}` : notice;
}
