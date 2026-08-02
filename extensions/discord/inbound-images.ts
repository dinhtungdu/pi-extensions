import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export const MAX_INBOUND_IMAGES = 4;
export const MAX_INBOUND_ATTACHMENTS = 10;
export const MAX_INBOUND_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_INBOUND_MESSAGE_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_INBOUND_IMAGE_SPOOL_BYTES = 128 * 1024 * 1024;
export const MAX_INBOUND_IMAGE_URL_LENGTH = 2_048;
export const MAX_INBOUND_IMAGE_PATH_LENGTH = 4_096;
export const MAX_INBOUND_IMAGE_WARNING_LENGTH = 240;
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

export interface InboundImagePreparation {
	images: QueuedInboundImage[];
	warnings: string[];
}

type FetchImage = (url: string, init: RequestInit) => Promise<Response>;

class PermanentInboundImageError extends Error {}
export class TransientInboundImageError extends Error {}

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

export function isQueuedInboundImageList(value: unknown): value is QueuedInboundImage[] {
	return Array.isArray(value) && value.length <= MAX_INBOUND_IMAGES && value.every(isQueuedInboundImage) &&
		value.reduce((total, image) => total + image.size, 0) <= MAX_INBOUND_MESSAGE_IMAGE_BYTES;
}

function permanent(message: string): PermanentInboundImageError {
	return new PermanentInboundImageError(message.slice(0, MAX_INBOUND_IMAGE_WARNING_LENGTH));
}

function warning(message: string): string {
	return `[Discord attachment warning: images were not injected: ${message.slice(0, MAX_INBOUND_IMAGE_WARNING_LENGTH)}.]`;
}

function assertAttachmentUrl(value: string): string {
	if (!value || value.length > MAX_INBOUND_IMAGE_URL_LENGTH) throw permanent("URL is invalid or too long");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw permanent("URL is invalid");
	}
	if (url.protocol !== "https:" || url.hostname !== "cdn.discordapp.com" || url.port || url.username || url.password || url.hash ||
		!/^\/attachments\/\d{1,25}\/\d{1,25}\//.test(url.pathname)) {
		throw permanent("URL is outside the Discord attachment CDN");
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

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export function appendInboundImageContext(
	text: string,
	images: readonly QueuedInboundImage[],
	warnings: readonly string[] = [],
): string {
	const references = images.map((image, index) =>
		`[Discord image ${index + 1}/${images.length}: local_path=${JSON.stringify(image.localPath)}; mime=${image.mimeType}; bytes=${image.size}]`,
	);
	const blocks = [...references, ...warnings.map((value) => value.slice(0, MAX_INBOUND_IMAGE_WARNING_LENGTH + 64))];
	return blocks.length === 0 ? text : `${text}${text ? "\n\n" : ""}${blocks.join("\n")}`;
}

export function appendImageCapabilityWarning(text: string): string {
	return `${text}${text ? "\n" : ""}[Discord image warning: the current Pi model does not support image input; local files were not natively injected.]`;
}

export class InboundImageStore {
	private operation: Promise<void> = Promise.resolve();
	private spooledBytes = 0;

	constructor(
		readonly directory: string,
		private readonly fetchImage: FetchImage = (url, init) => fetch(url, init),
	) {}

	initialize(referencedPaths: ReadonlySet<string>): Promise<void> {
		return this.serialize(async () => {
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			await chmod(this.directory, 0o700);
			const entries = await readdir(this.directory, { withFileTypes: true });
			if (entries.length > MAX_INBOUND_IMAGE_DIRECTORY_ENTRIES) {
				throw new Error(`Discord image directory exceeds ${MAX_INBOUND_IMAGE_DIRECTORY_ENTRIES} entries`);
			}
			let retainedBytes = 0;
			for (const entry of entries) {
				if (!/^[0-9a-f-]{36}\.(?:image|part)$/.test(entry.name)) continue;
				const path = resolve(this.directory, entry.name);
				if (entry.isFile() && entry.name.endsWith(".image") && referencedPaths.has(path)) {
					const fileStat = await lstat(path);
					retainedBytes += fileStat.size;
					continue;
				}
				if (entry.isDirectory()) continue;
				await unlink(path).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			}
			// Existing referenced files are never deleted merely to satisfy a newer budget.
			// Counting them above the cap prevents further downloads until safe acknowledgements release enough space.
			this.spooledBytes = retainedBytes;
		});
	}

	prepare(attachments: readonly DiscordInboundAttachment[]): Promise<InboundImagePreparation> {
		return this.serialize(() => this.prepareExclusive(attachments));
	}

	remove(paths: readonly string[]): Promise<void> {
		return this.serialize(() => this.removeExclusive(paths));
	}

	private async prepareExclusive(attachments: readonly DiscordInboundAttachment[]): Promise<InboundImagePreparation> {
		if (attachments.length === 0) return { images: [], warnings: [] };
		if (attachments.length > MAX_INBOUND_ATTACHMENTS) {
			return { images: [], warnings: [warning(`message has more than ${MAX_INBOUND_ATTACHMENTS} attachments`)] };
		}
		const candidates: Array<DiscordInboundAttachment & { mimeType: InboundImageMimeType }> = [];
		for (const attachment of attachments) {
			if (!/^\d{1,25}$/.test(attachment.id)) {
				return { images: [], warnings: [warning("attachment metadata has an invalid ID")] };
			}
			const mimeType = normalizedMimeType(attachment.contentType);
			if (!isInboundImageMimeType(mimeType)) {
				return { images: [], warnings: [warning("attachment MIME type is missing or unsupported")] };
			}
			if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > MAX_INBOUND_IMAGE_BYTES) {
				return { images: [], warnings: [warning(`declared image size must be 1-${MAX_INBOUND_IMAGE_BYTES} bytes`)] };
			}
			try {
				assertAttachmentUrl(attachment.url);
			} catch (error) {
				return { images: [], warnings: [warning((error as Error).message)] };
			}
			candidates.push({ ...attachment, mimeType });
		}
		if (candidates.length > MAX_INBOUND_IMAGES) {
			return { images: [], warnings: [warning(`message has more than ${MAX_INBOUND_IMAGES} supported images`)] };
		}
		const messageBytes = candidates.reduce((total, attachment) => total + attachment.size, 0);
		if (messageBytes > MAX_INBOUND_MESSAGE_IMAGE_BYTES) {
			return { images: [], warnings: [warning(`declared image total exceeds ${MAX_INBOUND_MESSAGE_IMAGE_BYTES} bytes`)] };
		}
		if (this.spooledBytes + messageBytes > MAX_INBOUND_IMAGE_SPOOL_BYTES) {
			return { images: [], warnings: [warning(`relay image spool budget of ${MAX_INBOUND_IMAGE_SPOOL_BYTES} bytes is full`)] };
		}

		const downloaded: QueuedInboundImage[] = [];
		try {
			for (const attachment of candidates) downloaded.push(await this.downloadOne(attachment));
			return { images: downloaded, warnings: [] };
		} catch (error) {
			await this.removeExclusive(downloaded.map((image) => image.localPath));
			if (error instanceof PermanentInboundImageError) {
				return { images: [], warnings: [warning(error.message)] };
			}
			throw error;
		}
	}

	private async removeExclusive(paths: readonly string[]): Promise<void> {
		const root = resolve(this.directory);
		for (const path of paths) {
			if (dirname(resolve(path)) !== root || !/^[0-9a-f-]{36}\.image$/.test(basename(path))) continue;
			let size = 0;
			try {
				const fileStat = await lstat(path);
				if (fileStat.isFile() && !fileStat.isSymbolicLink()) size = fileStat.size;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await unlink(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
			this.spooledBytes = Math.max(0, this.spooledBytes - size);
		}
	}

	private async downloadOne(
		attachment: DiscordInboundAttachment & { mimeType: InboundImageMimeType },
	): Promise<QueuedInboundImage> {
		const url = assertAttachmentUrl(attachment.url);
		let lastError: unknown;
		for (let attempt = 1; attempt <= INBOUND_IMAGE_DOWNLOAD_ATTEMPTS; attempt++) {
			try {
				return await this.downloadAttempt(attachment.id, url, attachment.mimeType, attachment.size);
			} catch (error) {
				lastError = error;
				if (error instanceof PermanentInboundImageError) throw error;
				if (attempt < INBOUND_IMAGE_DOWNLOAD_ATTEMPTS) await delay(100 * 2 ** (attempt - 1));
			}
		}
		const detail = lastError instanceof Error ? lastError.message.slice(0, 120) : "unknown download failure";
		throw new TransientInboundImageError(`Discord image download exhausted ${INBOUND_IMAGE_DOWNLOAD_ATTEMPTS} attempts: ${detail}`);
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
				if ((response.status >= 300 && response.status < 400) || response.redirected) throw permanent("redirects are not allowed");
				throw permanent(`Discord image CDN returned ${response.status}`);
			}
			if (normalizedMimeType(response.headers.get("content-type")) !== mimeType) {
				await response.body?.cancel().catch(() => {});
				throw permanent("response MIME type does not match metadata");
			}
			const contentLength = response.headers.get("content-length");
			if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== declaredSize)) {
				await response.body?.cancel().catch(() => {});
				throw permanent("response size does not match metadata");
			}
			if (!response.body) throw permanent("response body is missing");
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
					throw permanent("response exceeds declared or maximum size");
				}
				if (headerBytes < header.length) {
					const copied = Math.min(header.length - headerBytes, value.byteLength);
					header.set(value.subarray(0, copied), headerBytes);
					headerBytes += copied;
				}
				await handle.write(value);
			}
			if (size !== declaredSize) throw permanent("response size does not match metadata");
			if (detectedMimeType(header.subarray(0, headerBytes)) !== mimeType) throw permanent("file signature does not match MIME type");
			await handle.close();
			handle = undefined;
			await rename(temporary, localPath);
			this.spooledBytes += size;
			return { attachmentId, localPath, mimeType, size };
		} finally {
			clearTimeout(timer);
			await handle?.close().catch(() => {});
			await unlink(temporary).catch(() => {});
		}
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operation.then(operation, operation);
		this.operation = result.then(() => {}, () => {});
		return result;
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
	let totalBytes = 0;
	for (const image of images) {
		if (!isQueuedInboundImage(image)) throw new Error("Discord inbound image metadata is invalid");
		totalBytes += image.size;
		if (totalBytes > MAX_INBOUND_MESSAGE_IMAGE_BYTES) throw new Error("Discord inbound image total exceeds the message byte limit");
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
