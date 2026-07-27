export function makeFrame(type: number, id: number, payload: Uint8Array = new Uint8Array()): Buffer {
	const frame = Buffer.allocUnsafe(9 + payload.byteLength);
	frame.writeUInt8(type, 0);
	frame.writeUInt32LE(id >>> 0, 1);
	frame.writeUInt32LE(payload.byteLength, 5);
	Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(frame, 9);
	return frame;
}

export function makeSimpleFrame(type: number, payload: Uint8Array = new Uint8Array()): Buffer {
	const frame = Buffer.allocUnsafe(5 + payload.byteLength);
	frame.writeUInt8(type, 0);
	frame.writeUInt32LE(payload.byteLength, 1);
	Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(frame, 5);
	return frame;
}

export interface BinaryFrame {
	type: number;
	id: number;
	payload: Buffer;
}

export class BinaryFrameParser {
	private buffered: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): BinaryFrame[] {
		this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
		const frames: BinaryFrame[] = [];
		while (this.buffered.length >= 9) {
			const type = this.buffered.readUInt8(0);
			const id = this.buffered.readUInt32LE(1);
			const length = this.buffered.readUInt32LE(5);
			if (length > 64 * 1024 * 1024) throw new Error(`voice protocol frame too large: ${length}`);
			const frameLength = 9 + length;
			if (this.buffered.length < frameLength) break;
			frames.push({ type, id, payload: this.buffered.subarray(9, frameLength) });
			this.buffered = this.buffered.subarray(frameLength);
		}
		return frames;
	}
}
