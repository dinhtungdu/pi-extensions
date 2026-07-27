import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VoiceConfig } from "./config.js";
import { cleanTranscriptDeterministically, preservesTechnicalText } from "./transcript-cleanup.js";

const CLEANUP_PROMPT = `You clean speech-to-text transcripts for a coding agent.
Return only the cleaned transcript, with no commentary or Markdown wrapper.
Remove filler words, exact repeated phrases, and obvious false starts. Restore punctuation and sentence boundaries.
Do not summarize, answer, infer missing details, or change intent.
Preserve verbatim every code fragment, command, identifier, path, URL, version, number, proper name, quoted span, and negation.
If the transcript is already clear, return it unchanged.`;

export class TranscriptCleanupCancelled extends Error {
	constructor() {
		super("transcript cleanup cancelled");
		this.name = "TranscriptCleanupCancelled";
	}
}

export type TranscriptModelCleaner = (
	text: string,
	modelName: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
	timeoutMs: number,
) => Promise<string>;

async function cleanWithAuthenticatedModel(
	text: string,
	modelName: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<string> {
	let model = ctx.model;
	if (modelName === "current") {
		model = ctx.model;
	} else {
		const separator = modelName.indexOf("/");
		if (separator <= 0 || separator === modelName.length - 1) {
			throw new Error(`invalid cleanupModel ${JSON.stringify(modelName)}; use "current" or "provider/model"`);
		}
		model = ctx.modelRegistry.find(modelName.slice(0, separator), modelName.slice(separator + 1));
	}
	if (!model) throw new Error(`cleanup model ${modelName} is unavailable`);

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	const provider = ctx.modelRegistry.getProvider(model.provider);
	if (!provider) throw new Error(`cleanup provider ${model.provider} is unavailable`);

	const stream = provider.streamSimple(
		model,
		{
			systemPrompt: CLEANUP_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			signal,
			timeoutMs,
			maxRetries: 0,
			maxTokens: Math.min(4096, Math.max(1024, text.length * 2)),
			reasoning: "minimal",
			cacheRetention: "none",
		},
	);
	for await (const _event of stream) {
		// Drain streaming events; cleanup is only exposed after the final message.
	}
	const response = await stream.result();
	if (response.stopReason === "error") throw new Error(response.errorMessage || "cleanup request failed");
	if (response.stopReason === "aborted") throw new Error("cleanup request aborted");
	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

interface ActiveCleanup {
	controller: AbortController;
	cancelled: boolean;
}

export class TranscriptPreprocessor {
	private active?: ActiveCleanup;

	constructor(
		private readonly config: VoiceConfig,
		private readonly onFallback: (message: string) => void,
		private readonly modelCleaner: TranscriptModelCleaner = cleanWithAuthenticatedModel,
	) {}

	cancel(): void {
		if (!this.active) return;
		this.active.cancelled = true;
		this.active.controller.abort();
	}

	async process(raw: string, ctx: ExtensionContext): Promise<string> {
		if (!this.config.transcriptCleanup) return raw;
		const deterministic = cleanTranscriptDeterministically(raw);
		if (raw.length < Math.max(0, this.config.cleanupMinChars)) return deterministic || raw;

		const timeoutMs = Math.max(100, this.config.cleanupTimeoutMs);
		const active: ActiveCleanup = { controller: new AbortController(), cancelled: false };
		this.active = active;
		let timer: NodeJS.Timeout | undefined;
		try {
			const timeout = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					active.controller.abort();
					reject(new Error(`cleanup timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			});
			const aborted = new Promise<never>((_resolve, reject) => {
				active.controller.signal.addEventListener("abort", () => reject(new TranscriptCleanupCancelled()), {
					once: true,
				});
			});
			const cleaned = await Promise.race([
				this.modelCleaner(
					deterministic || raw,
					this.config.cleanupModel,
					ctx,
					active.controller.signal,
					timeoutMs,
				),
				timeout,
				aborted,
			]);
			if (!cleaned) throw new Error("cleanup model returned empty text");
			if (cleaned.length > raw.length * 2 + 200) throw new Error("cleanup model expanded the transcript unexpectedly");
			if (!preservesTechnicalText(raw, cleaned)) throw new Error("cleanup model changed protected technical text");
			return cleaned;
		} catch (error) {
			if (active.cancelled) throw new TranscriptCleanupCancelled();
			this.onFallback(error instanceof Error ? error.message : String(error));
			return raw;
		} finally {
			if (timer) clearTimeout(timer);
			if (this.active === active) this.active = undefined;
		}
	}
}
