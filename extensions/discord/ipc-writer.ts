import type { Socket } from "node:net";

export const MAX_QUEUED_IPC_FRAMES = 64;
export const MAX_QUEUED_IPC_BYTES = 16 * 1_048_576;

interface WritableSocket {
	destroyed: boolean;
	write(data: string): boolean;
	on(event: "drain", listener: () => void): unknown;
	off(event: "drain", listener: () => void): unknown;
}

export class BoundedSocketWriter {
	private readonly queue: Array<{ data: string; bytes: number }> = [];
	private queuedBytes = 0;
	private blocked = false;
	private closed = false;
	private readonly handleDrain = () => this.drain();

	constructor(
		private readonly socket: WritableSocket | Socket,
		private readonly onCapacity: () => void = () => {},
	) {
		socket.on("drain", this.handleDrain);
	}

	write(data: string): boolean {
		if (this.closed || this.socket.destroyed) return false;
		const bytes = Buffer.byteLength(data);
		if (bytes > MAX_QUEUED_IPC_BYTES) return false;
		if (this.blocked || this.queue.length > 0) {
			if (this.queue.length >= MAX_QUEUED_IPC_FRAMES || this.queuedBytes + bytes > MAX_QUEUED_IPC_BYTES) return false;
			this.queue.push({ data, bytes });
			this.queuedBytes += bytes;
			return true;
		}
		this.blocked = !this.socket.write(data);
		return true;
	}

	writeBestEffort(data: string): boolean {
		if (this.closed || this.socket.destroyed || this.blocked || this.queue.length > 0) return false;
		const bytes = Buffer.byteLength(data);
		if (bytes > MAX_QUEUED_IPC_BYTES) return false;
		this.blocked = !this.socket.write(data);
		return true;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.socket.off("drain", this.handleDrain);
		this.queue.length = 0;
		this.queuedBytes = 0;
	}

	queuedFrameCount(): number {
		return this.queue.length;
	}

	queuedByteCount(): number {
		return this.queuedBytes;
	}

	private drain(): void {
		if (this.closed || this.socket.destroyed) return;
		this.blocked = false;
		while (this.queue.length > 0) {
			const frame = this.queue.shift()!;
			this.queuedBytes -= frame.bytes;
			if (!this.socket.write(frame.data)) {
				this.blocked = true;
				break;
			}
		}
		if (!this.blocked && this.queue.length === 0) this.onCapacity();
	}
}
