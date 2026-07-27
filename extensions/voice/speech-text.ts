const MAX_CHARS = 320;
const TARGET_CHARS = 220;

export class SentenceChunker {
	private buffer = "";

	push(delta: string): string[] {
		this.buffer += delta;
		const chunks: string[] = [];
		while (true) {
			const boundary = this.findBoundary();
			if (boundary <= 0) break;
			const chunk = this.buffer.slice(0, boundary).trim();
			this.buffer = this.buffer.slice(boundary).trimStart();
			if (chunk) chunks.push(chunk);
		}
		return chunks;
	}

	flush(): string | undefined {
		const value = this.buffer.trim();
		this.buffer = "";
		return value || undefined;
	}

	reset(): void {
		this.buffer = "";
	}

	private findBoundary(): number {
		const sentence = /[.!?](?:["')\]]*)\s+/g;
		let match: RegExpExecArray | null;
		while ((match = sentence.exec(this.buffer))) {
			const end = match.index + match[0].length;
			if (end >= 24) return end;
		}
		const newline = this.buffer.indexOf("\n");
		if (newline >= 24) return newline + 1;
		if (this.buffer.length <= MAX_CHARS) return -1;
		const space = this.buffer.lastIndexOf(" ", TARGET_CHARS);
		return space >= 80 ? space + 1 : TARGET_CHARS;
	}
}

export class SpeechSanitizer {
	private inCodeFence = false;

	clean(chunk: string): string {
		let spoken = "";
		let remaining = chunk;
		while (remaining) {
			const fence = remaining.indexOf("```");
			if (fence < 0) {
				if (!this.inCodeFence) spoken += remaining;
				break;
			}
			if (!this.inCodeFence) spoken += remaining.slice(0, fence);
			this.inCodeFence = !this.inCodeFence;
			remaining = remaining.slice(fence + 3);
		}

		return spoken
			.replace(/!\[([^\]]*)]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
			.replace(/https?:\/\/\S+/g, "link")
			.replace(/^\s{0,3}(?:#{1,6}|[-*+] |\d+[.)] )/gm, "")
			.replace(/[*_~]/g, "")
			.replace(/`([^`]+)`/g, "$1")
			.replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}|\uFE0F/gu, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	reset(): void {
		this.inCodeFence = false;
	}
}
