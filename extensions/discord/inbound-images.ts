import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export const MAX_INBOUND_IMAGES = 4;
export const MAX_INBOUND_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_INBOUND_IMAGE_URL_LENGTH = 2_048;
export const MAX_INBOUND_IMAGE_PATH_LENGTH = 4_096;
export const INBOUND_IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;
export const INBOUND_IMAGE_DOWNLOAD_ATTEMPTS = 3;
export const MAX_INBOUND_IMAGE_DIRECTORY_ENTRIES = 10_000;

export const INBOUND_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type InboundImageMimeType = typeof INBOUND_IMAGE_MIME_TYPES[number];

export interface DiscordInboundAttachment {
	id: string;
	url: string;
	contentType?: string;
	size: number;
}

export interface QueuedInboundImage {
	attachmentId: string;
	localPath: string;
	mimeType: InboundImageMimeType;
	size: number;
}

export interface NativeInboundImage {
	type: "image";
	data: string;
	mimeType: InboundImageMimeType;
}

type FetchImage = (url: string, init: RequestInit) => Promise<Response>;

function normalizedMimeType(value: string | null | undefined): string | undefined {
	const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
	return normalized || undefined;
}

export function isInboundImageMimeType(value: unknown): value is InboundImageMimeType {
	return typeof value === "string" && INBOUND_IMAGE_MIME_TYPES.includes(value as InboundImageMimeType);
}

export function isQueuedInboundImage(value: unknown): value is QueuedInboundImage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const image = value as Record<string, unknown>;
	return typeof image.attachmentId === "string" && /^\d{1,25}$/.test(image.attachmentId) &&
		typeof image.localPath === "string" && image.localPath.length > 0 && image.localPath.length <= MAX_INBOUND_IMAGE_PATH_LENGTH &&
		isInboundImageMimeType(image.mimeType) && Number.isSafeInteger(image.size) &&
		Number(image.size) > 0 && Number(image.size) <= MAX_INBOUND_IMAGE_BYTES;
}

function assertAttachmentUrl(value: string): string {
	if (!value || value.length > MAX_INBOUND_IMAGE_URL_LENGTH) throw rejected("URL is invalid or too long");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw rejected("URL is invalid");
	}
	if (url.protocol !== "https:" || url.hostname !== "cdn.discordapp.com" || url.port || url.username || url.password || url.hash ||
		!/^\/attachments\/\d{1,25}\/\d{1,25}\//.test(url.pathname)) {
		throw rejected("URL is outside the Discord attachment CDN");
	}
	return url.href;
}

function detectedMimeType(bytes: Uint8Array): InboundImageMimeType | undefined {
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

function retryable(error: unknown): boolean {
	return !(error instanceof Error) || !error.message.startsWith("Discord image attachment rejected:");
}

function rejected(message: string): Error {
	return new Error(`Discord image attachment rejected: ${message}`);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export class InboundImageStore {
	constructor(
		readonly directory: string,
		private readonly fetchImage: FetchImage = (url, init) => fetch(url, init),
	) {}

	async initialize(referencedPaths: ReadonlySet<string>): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700);
		const entries = await readdir(this.directory, { withFileTypes: true });
		if (entries.length > MAX_INBOUND_IMAGE_DIRECTORY_ENTRIES) {
			throw new Error(`Discord image directory exceeds ${MAX_INBOUND_IMAGE_DIRECTORY_ENTRIES} entries`);
		}
		for (const entry of entries) {
			if (!/^[0-9a-f-]{36}\.(?:image|part)$/.test(entry.name)) continue;
			const path = resolve(this.directory, entry.name);
			if (entry.name.endsWith(".image") && referencedPaths.has(path)) continue;
			await unlink(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}

	async download(attachments: readonly DiscordInboundAttachment[]): Promise<QueuedInboundImage[]> {
		const candidates = attachments.filter((attachment) => isInboundImageMimeType(normalizedMimeType(attachment.contentType)));
		if (candidates.length > MAX_INBOUND_IMAGES) throw rejected(`more than ${MAX_INBOUND_IMAGES} supported images`);
		const downloaded: QueuedInboundImage[] = [];
		try {
			for (const attachment of candidates) downloaded.push(await this.downloadOne(attachment));
			return downloaded;
		} catch (error) {
			await this.remove(downloaded.map((image) => image.localPath));
			throw error;
		}
	}

	async remove(paths: readonly string[]): Promise<void> {
		const root = resolve(this.directory);
		for (const path of paths) {
			if (dirname(resolve(path)) !== root || !/^[0-9a-f-]{36}\.image$/.test(basename(path))) continue;
			await unlink(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
	}

	private async downloadOne(attachment: DiscordInboundAttachment): Promise<QueuedInboundImage> {
		if (!/^\d{1,25}$/.test(attachment.id)) throw rejected("invalid attachment ID");
		const mimeType = normalizedMimeType(attachment.contentType);
		if (!isInboundImageMimeType(mimeType)) throw rejected("unsupported MIME type");
		if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > MAX_INBOUND_IMAGE_BYTES) {
			throw rejected(`declared size must be 1-${MAX_INBOUND_IMAGE_BYTES} bytes`);
		}
		const url = assertAttachmentUrl(attachment.url);
		let lastError: unknown;
		for (let attempt = 1; attempt <= INBOUND_IMAGE_DOWNLOAD_ATTEMPTS; attempt++) {
			try {
				return await this.downloadAttempt(attachment.id, url, mimeType, attachment.size);
			} catch (error) {
				lastError = error;
				if (!retryable(error) || attempt === INBOUND_IMAGE_DOWNLOAD_ATTEMPTS) throw error;
				await delay(100 * 2 ** (attempt - 1));
			}
		}
		throw lastError;
	}

	private async downloadAttempt(
		attachmentId: string,
		url: string,
		mimeType: InboundImageMimeType,
		declaredSize: number,
	): Promise<QueuedInboundImage> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700);
		const id = randomUUID();
		const temporary = resolve(this.directory, `${id}.part`);
		const localPath = resolve(this.directory, `${id}.image`);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), INBOUND_IMAGE_DOWNLOAD_TIMEOUT_MS);
		timer.unref();
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			const response = await this.fetchImage(url, {
				method: "GET",
				redirect: "manual",
				credentials: "omit",
				signal: controller.signal,
				headers: { accept: mimeType },
			});
			if (response.status !== 200 || response.redirected) {
				await response.body?.cancel().catch(() => {});
				if (response.status >= 500 || response.status === 429) throw new Error(`Discord image CDN returned ${response.status}`);
				if ((response.status >= 300 && response.status < 400) || response.redirected) throw rejected("redirects are not allowed");
				throw rejected(`Discord image CDN returned ${response.status}`);
			}
			if (normalizedMimeType(response.headers.get("content-type")) !== mimeType) {
				await response.body?.cancel().catch(() => {});
				throw rejected("response MIME type does not match metadata");
			}
			const contentLength = response.headers.get("content-length");
			if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== declaredSize)) {
				await response.body?.cancel().catch(() => {});
				throw rejected("response size does not match metadata");
			}
			if (!response.body) throw rejected("response body is missing");
			handle = await open(temporary, "wx", 0o600);
			const reader = response.body.getReader();
			let size = 0;
			const header = Buffer.alloc(16);
			let headerBytes = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > declaredSize || size > MAX_INBOUND_IMAGE_BYTES) {
					await reader.cancel();
					throw rejected("response exceeds declared or maximum size");
				}
				if (headerBytes < header.length) {
					const copied = Math.min(header.length - headerBytes, value.byteLength);
					header.set(value.subarray(0, copied), headerBytes);
					headerBytes += copied;
				}
				await handle.write(value);
			}
			if (size !== declaredSize) throw rejected("response size does not match metadata");
			if (detectedMimeType(header.subarray(0, headerBytes)) !== mimeType) throw rejected("file signature does not match MIME type");
			await handle.close();
			handle = undefined;
			await rename(temporary, localPath);
			return { attachmentId, localPath, mimeType, size };
		} finally {
			clearTimeout(timer);
			await handle?.close().catch(() => {});
			await unlink(temporary).catch(() => {});
		}
	}
}

export async function loadInboundImages(
	directory: string,
	images: readonly QueuedInboundImage[],
): Promise<NativeInboundImage[]> {
	if (images.length > MAX_INBOUND_IMAGES) throw new Error(`Discord inbound image count exceeds ${MAX_INBOUND_IMAGES}`);
	const lexicalRoot = resolve(directory);
	const canonicalRoot = await realpath(lexicalRoot);
	const result: NativeInboundImage[] = [];
	for (const image of images) {
		if (!isQueuedInboundImage(image)) throw new Error("Discord inbound image metadata is invalid");
		const lexicalPath = resolve(image.localPath);
		if (dirname(lexicalPath) !== lexicalRoot || !/^[0-9a-f-]{36}\.image$/.test(basename(lexicalPath))) {
			throw new Error("Discord inbound image path is outside the relay image directory");
		}
		const fileStat = await lstat(lexicalPath);
		if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== image.size || fileStat.size > MAX_INBOUND_IMAGE_BYTES) {
			throw new Error("Discord inbound image file metadata does not match the relay record");
		}
		const canonicalPath = await realpath(lexicalPath);
		if (dirname(canonicalPath) !== canonicalRoot) throw new Error("Discord inbound image resolves outside the relay image directory");
		const data = await readFile(canonicalPath);
		if (data.byteLength !== image.size || detectedMimeType(data.subarray(0, 16)) !== image.mimeType) {
			throw new Error("Discord inbound image file content does not match the relay record");
		}
		result.push({ type: "image", data: data.toString("base64"), mimeType: image.mimeType });
	}
	return result;
}
