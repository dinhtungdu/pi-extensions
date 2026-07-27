import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AudioIO } from "./audio.js";
import { BargeInDetector } from "./barge-in.js";
import type { VoiceConfig, VoiceInputMode } from "./config.js";
import { SentenceChunker, SpeechSanitizer } from "./speech-text.js";
import { SttClient, type SttEvent } from "./stt-client.js";
import { TranscriptCleanupCancelled, TranscriptPreprocessor } from "./transcript-preprocessor.js";
import { TtsClient } from "./tts-client.js";

type VoicePhase = "starting" | "muted" | "armed" | "listening" | "hearing" | "thinking" | "speaking" | "error" | "off";

const STATUS_KEY = "voice";
const TRANSCRIPT_WIDGET = "voice-transcript";
const PLAYBACK_DETECTION_DELAY_MS = 300;
const PLAYBACK_COOLDOWN_MS = 400;
const PUSH_TO_TALK_WAIT_MS = 10_000;
const STOP_PHRASES = new Set(["stop", "pi stop", "stop talking", "be quiet", "quiet", "cancel speech"]);

function isStopPhrase(text: string): boolean {
	const normalized = text
		.toLowerCase()
		.replace(/[^a-z\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (STOP_PHRASES.has(normalized)) return true;
	return ["pi stop", "stop talking", "be quiet", "cancel speech"].some(
		(phrase) => normalized.includes(phrase),
	);
}

export class VoiceRuntime {
	private ctx: ExtensionContext;
	private phase: VoicePhase = "off";
	private readonly stt: SttClient;
	private readonly tts: TtsClient;
	private readonly audio: AudioIO;
	private readonly detector: BargeInDetector;
	private readonly chunker = new SentenceChunker();
	private readonly sanitizer = new SpeechSanitizer();
	private readonly transcriptPreprocessor: TranscriptPreprocessor;
	private transcriptQueue: Promise<void> = Promise.resolve();
	private transcriptGeneration = 0;
	private responseEnded = true;
	private playbackActive = false;
	private playbackStartedAt = 0;
	private cooldownUntil = 0;
	private generation = 0;
	private readonly requestGenerations = new Map<number, number>();
	private pendingTranscript?: string;
	private sttReady = false;
	private ttsReady = false;
	private readyAnnounced = false;
	private spokenCharacters = 0;
	private speechLimitReached = false;
	private stopped = false;
	private pushToTalkArmed = false;
	private pushToTalkPending = false;
	private pushToTalkTimer?: ReturnType<typeof setTimeout>;
	private microphoneAvailable?: boolean;

	constructor(
		private readonly pi: ExtensionAPI,
		ctx: ExtensionContext,
		private readonly config: VoiceConfig,
	) {
		this.ctx = ctx;
		this.transcriptPreprocessor = new TranscriptPreprocessor(config, (message) =>
			this.debug(`cleanup fallback: ${message}`),
		);
		this.detector = new BargeInDetector({
			micThreshold: config.micThreshold,
			residualThreshold: config.residualThreshold,
			triggerFrames: config.bargeInFrames,
			maxEchoDelayMs: config.maxEchoDelayMs,
		});
		this.audio = new AudioIO(
			config,
			(pcm) => this.handleMicFrame(pcm),
			() => this.handlePlaybackEnd(),
			(message) => this.fail(message),
			(available, message) => this.handleMicrophoneState(available, message),
		);
		this.stt = new SttClient(
			config.sttWorkerPath,
			config.sttModelPath,
			(event) => this.handleSttEvent(event),
			(message) => this.debug(`stt: ${message}`),
		);
		this.tts = new TtsClient(config, {
			onReady: () => {
				this.ttsReady = true;
				this.debug("tts: ready");
				this.maybeAnnounceReady();
			},
			onAudioStart: (id, sampleRate) => this.handleTtsStart(id, sampleRate),
			onAudio: (id, pcm) => this.handleTtsAudio(id, pcm),
			onDone: (id) => this.handleTtsDone(id),
			onError: (message, id) => this.handleTtsError(message, id),
			onLog: (message) => this.debug(`tts: ${message}`),
		});
	}

	start(): void {
		if (process.platform !== "darwin" || process.arch !== "arm64") {
			this.fail("voice currently requires Apple Silicon macOS");
			return;
		}
		this.stopped = false;
		this.setPhase("starting");
		this.stt.start();
		this.tts.start();
		this.audio.startCapture();
	}

	stop(): void {
		this.cancelTranscriptProcessing();
		this.finishPushToTalk(false);
		this.stopped = true;
		this.audio.stop();
		this.stt.stop();
		this.tts.stop();
		this.requestGenerations.clear();
		this.ctx.ui.setStatus(STATUS_KEY, undefined);
		this.ctx.ui.setWidget(TRANSCRIPT_WIDGET, undefined);
		this.phase = "off";
	}

	setContext(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	setInputMode(mode: VoiceInputMode): void {
		this.finishPushToTalk(false);
		this.config.inputMode = mode;
		this.stt.reset();
		if (this.phase === "listening" || this.phase === "hearing" || this.phase === "armed" || this.phase === "muted") {
			this.setPhase(this.inputRestPhase());
		}
	}

	armPushToTalk(): void {
		if (this.stopped) return;
		if (this.config.inputMode !== "push-to-talk") this.setInputMode("push-to-talk");
		if (!this.sttReady) {
			this.pushToTalkPending = true;
			this.ctx.ui.notify("voice: loading speech recognition; push-to-talk will arm when ready", "info");
			return;
		}
		this.pushToTalkPending = false;
		this.cancelTranscriptProcessing();
		if (this.playbackActive || this.currentPendingRequests() > 0) this.cancelSpeech("push-to-talk");
		this.stt.reset();
		this.pushToTalkArmed = true;
		if (this.pushToTalkTimer) clearTimeout(this.pushToTalkTimer);
		this.pushToTalkTimer = setTimeout(() => {
			this.debug("push-to-talk timed out before speech");
			this.finishPushToTalk();
		}, PUSH_TO_TALK_WAIT_MS);
		this.setPhase("armed");
		this.ctx.ui.setWidget(TRANSCRIPT_WIDGET, [this.ctx.ui.theme.fg("accent", "Push-to-talk: speak now")]);
	}

	status(): string {
		const cleanup = this.config.transcriptCleanup ? this.config.cleanupModel : "off";
		const microphone = this.microphoneAvailable === undefined ? "connecting" : this.microphoneAvailable ? "available" : "unavailable";
		return `${this.phase}; mode=${this.config.inputMode}; input=${this.config.inputDevice}; microphone=${microphone}; voice=${this.config.ttsVoice}; cleanup=${cleanup}; STT=${this.config.sttModelPath}; TTS=${this.config.ttsModelPath}`;
	}

	testOutput(text = "Voice output is working."): void {
		if (this.stopped) return;
		this.cancelSpeech("voice output test");
		this.spokenCharacters = 0;
		this.speechLimitReached = false;
		this.responseEnded = true;
		this.setPhase("thinking");
		this.queueSpeech(text);
	}

	interruptSpeech(reason = "user interrupt", abortAgent = false): void {
		if (this.stopped) return;
		this.cancelTranscriptProcessing();
		this.finishPushToTalk(false);
		this.cancelSpeech(reason);
		this.stt.reset();
		this.ctx.ui.setWidget(TRANSCRIPT_WIDGET, undefined);
		if (abortAgent && !this.ctx.isIdle()) this.ctx.abort();
		this.setPhase(this.inputRestPhase());
	}

	onUserInput(ctx: ExtensionContext, external = true): void {
		this.setContext(ctx);
		if (external) {
			this.cancelTranscriptProcessing();
			this.finishPushToTalk(false);
		}
		if (this.playbackActive || this.currentPendingRequests() > 0) {
			this.interruptSpeech("new user input");
		}
	}

	onAgentStart(ctx: ExtensionContext): void {
		this.setContext(ctx);
		this.cancelSpeech("new agent response");
		this.responseEnded = false;
		this.spokenCharacters = 0;
		this.speechLimitReached = false;
		this.chunker.reset();
		this.sanitizer.reset();
		this.setPhase("thinking");
	}

	onAssistantStart(ctx: ExtensionContext): void {
		this.setContext(ctx);
		this.chunker.reset();
		this.sanitizer.reset();
	}

	onAssistantText(delta: string, ctx: ExtensionContext): void {
		this.setContext(ctx);
		for (const chunk of this.chunker.push(delta)) this.queueSpeech(chunk);
	}

	onAssistantEnd(ctx: ExtensionContext): void {
		this.setContext(ctx);
		const tail = this.chunker.flush();
		if (tail) this.queueSpeech(tail);
	}

	onAgentSettled(ctx: ExtensionContext): void {
		this.setContext(ctx);
		this.responseEnded = true;
		this.finishPlaybackWhenReady();
		this.sendPendingTranscript();
	}

	onToolActivity(ctx: ExtensionContext): void {
		this.setContext(ctx);
		if (this.phase !== "speaking" && this.phase !== "hearing" && this.phase !== "armed") this.setPhase("thinking");
	}

	private handleMicFrame(pcm: Buffer): void {
		if (this.stopped) return;
		if (this.config.inputMode === "push-to-talk") {
			if (this.pushToTalkArmed) this.stt.pushPcm(pcm);
			return;
		}
		if (Date.now() < this.cooldownUntil) return;
		if (this.phase === "listening" || this.phase === "hearing") {
			this.stt.pushPcm(pcm);
			return;
		}
		if (this.phase !== "thinking" && this.phase !== "speaking") return;

		// Keep STT active while Pi works so spoken stop commands do not depend on
		// the acoustic barge-in heuristic. Normal speech cannot interrupt thinking;
		// use push-to-talk for an intentional interruption.
		this.stt.pushPcm(pcm);
		if (this.phase === "thinking") return;
		const detected = this.detector.observe(pcm, true);
		if (this.phase === "speaking" && Date.now() - this.playbackStartedAt < PLAYBACK_DETECTION_DELAY_MS) return;
		if (detected) this.handleBargeIn();
	}

	private handleBargeIn(): void {
		this.debug("barge-in detected");
		const preroll = this.detector.preroll();
		this.cancelSpeech("barge-in");
		this.stt.reset();
		// Acoustic energy only opens the recognition gate. Abort active work later,
		// after STT confirms a non-empty utterance; noise alone must not cancel it.
		this.setPhase("hearing");
		if (preroll.length) this.stt.pushPcm(preroll);
	}

	private handleSttEvent(event: SttEvent): void {
		if (event.type === "ready") {
			this.sttReady = true;
			this.setPhase(this.inputRestPhase());
			if (this.pushToTalkPending) {
				this.armPushToTalk();
				return;
			}
			this.maybeAnnounceReady();
			return;
		}
		if (event.type === "error") {
			this.fail(event.message);
			return;
		}
		if (this.config.inputMode === "push-to-talk" && !this.pushToTalkArmed) return;
		if (event.type === "interim") {
			if (this.config.inputMode === "push-to-talk") {
				if (this.pushToTalkTimer) clearTimeout(this.pushToTalkTimer);
				this.pushToTalkTimer = undefined;
				this.setPhase("hearing");
				this.ctx.ui.setWidget(TRANSCRIPT_WIDGET, [this.ctx.ui.theme.fg("dim", `Heard: ${event.text}`)]);
				return;
			}
			if ((this.phase === "speaking" || this.phase === "thinking") && isStopPhrase(event.text)) {
				this.interruptSpeech("spoken stop command", true);
				return;
			}
			// While Pi is working, only the acoustic detector may promote normal speech
			// to "hearing". STT remains active solely so stop commands bypass that gate.
			if (this.phase === "speaking" || this.phase === "thinking") return;
			this.setPhase("hearing");
			this.ctx.ui.setWidget(TRANSCRIPT_WIDGET, [this.ctx.ui.theme.fg("dim", `Heard: ${event.text}`)]);
			return;
		}
		if (event.type === "final") {
			const pushToTalk = this.config.inputMode === "push-to-talk";
			if (pushToTalk) this.finishPushToTalk(false);
			this.ctx.ui.setWidget(TRANSCRIPT_WIDGET, undefined);
			const text = event.text.trim();
			if (!pushToTalk && (this.phase === "speaking" || this.phase === "thinking")) {
				if (isStopPhrase(text)) this.interruptSpeech("spoken stop command", true);
				else this.stt.reset();
				return;
			}
			if (!text) {
				this.setPhase(this.inputRestPhase());
				return;
			}
			this.submitTranscript(text);
		}
	}

	private finishPushToTalk(updatePhase = true): void {
		this.pushToTalkArmed = false;
		this.pushToTalkPending = false;
		if (this.pushToTalkTimer) clearTimeout(this.pushToTalkTimer);
		this.pushToTalkTimer = undefined;
		this.stt.reset();
		this.ctx.ui.setWidget(TRANSCRIPT_WIDGET, undefined);
		if (updatePhase && !this.stopped && this.phase !== "speaking" && this.phase !== "error") {
			this.setPhase(this.inputRestPhase());
		}
	}

	private inputRestPhase(): VoicePhase {
		if (!this.ctx.isIdle()) return "thinking";
		return this.config.inputMode === "push-to-talk" ? "muted" : "listening";
	}

	private maybeAnnounceReady(): void {
		if (!this.sttReady || !this.ttsReady || this.readyAnnounced) return;
		this.readyAnnounced = true;
		if (this.config.announceReady) this.testOutput("Voice mode ready.");
	}

	private submitTranscript(raw: string): void {
		const generation = this.transcriptGeneration;
		const ctx = this.ctx;
		this.debug(`raw transcript: ${raw}`);
		this.setPhase("thinking");
		this.transcriptQueue = this.transcriptQueue.then(async () => {
			if (this.stopped || generation !== this.transcriptGeneration) return;
			let text: string;
			try {
				text = await this.transcriptPreprocessor.process(raw, ctx);
			} catch (error) {
				if (error instanceof TranscriptCleanupCancelled) return;
				this.debug(`cleanup fallback: ${String(error)}`);
				text = raw;
			}
			if (this.stopped || generation !== this.transcriptGeneration) return;
			this.debug(`transcript: ${text}`);
			this.deliverTranscript(text);
		}).catch((error) => {
			if (!(error instanceof TranscriptCleanupCancelled)) this.debug(`transcript submission failed: ${String(error)}`);
			if (!this.stopped && this.ctx.isIdle()) this.setPhase(this.inputRestPhase());
		});
	}

	private deliverTranscript(text: string): void {
		if (this.ctx.isIdle()) {
			this.setPhase("thinking");
			this.pi.sendUserMessage(text);
			return;
		}
		this.pendingTranscript = text;
		this.ctx.abort();
		this.setPhase("thinking");
	}

	private cancelTranscriptProcessing(): void {
		this.transcriptGeneration++;
		this.transcriptPreprocessor?.cancel();
		this.pendingTranscript = undefined;
	}

	private sendPendingTranscript(): void {
		if (!this.pendingTranscript || !this.ctx.isIdle()) return;
		const text = this.pendingTranscript;
		this.pendingTranscript = undefined;
		this.pi.sendUserMessage(text);
	}

	private queueSpeech(raw: string): void {
		if (this.phase === "armed" || this.phase === "hearing") return;
		const text = this.sanitizer.clean(raw);
		if (!text || this.speechLimitReached) return;
		if (this.spokenCharacters + text.length > this.config.maxSpokenCharacters) {
			this.speechLimitReached = true;
			const notice = "I put the rest of the answer on screen.";
			const id = this.tts.speak(notice);
			this.requestGenerations.set(id, this.generation);
			return;
		}
		this.spokenCharacters += text.length;
		const id = this.tts.speak(text);
		this.requestGenerations.set(id, this.generation);
	}

	private handleTtsStart(id: number, sampleRate: number): void {
		if (this.requestGenerations.get(id) !== this.generation) return;
		this.stt.reset();
		this.audio.startPlayback(sampleRate);
		this.detector.startPlayback();
		this.playbackActive = true;
		this.playbackStartedAt = Date.now();
		this.setPhase("speaking");
	}

	private handleTtsAudio(id: number, pcm: Buffer): void {
		if (this.requestGenerations.get(id) !== this.generation) return;
		this.detector.pushPlayback(pcm, 24000);
		this.audio.writePlayback(pcm);
	}

	private handleTtsDone(id: number): void {
		this.requestGenerations.delete(id);
		this.finishPlaybackWhenReady();
	}

	private handleTtsError(message: string, id?: number): void {
		if (!id) this.ttsReady = false;
		if (id) this.requestGenerations.delete(id);
		this.fail(`TTS: ${message}`);
		this.finishPlaybackWhenReady();
	}

	private finishPlaybackWhenReady(): void {
		if (this.phase === "hearing" || this.phase === "armed" || !this.responseEnded || this.currentPendingRequests() > 0) return;
		this.audio.finishPlayback();
	}

	private currentPendingRequests(): number {
		let count = 0;
		for (const generation of this.requestGenerations.values()) {
			if (generation === this.generation) count++;
		}
		return count;
	}

	private handlePlaybackEnd(): void {
		const hadPlayback = this.playbackActive;
		this.playbackActive = false;
		this.detector.reset();
		this.stt.reset();
		if (hadPlayback) this.cooldownUntil = Date.now() + PLAYBACK_COOLDOWN_MS;
		if (this.stopped || this.phase === "hearing" || this.phase === "armed") return;
		this.setPhase(this.inputRestPhase());
	}

	private cancelSpeech(reason: string): void {
		this.debug(`cancel speech: ${reason}`);
		this.generation++;
		this.tts.cancelAll();
		this.audio.cancelPlayback();
		this.playbackActive = false;
		this.detector.reset();
		this.ctx.ui.setWidget(TRANSCRIPT_WIDGET, undefined);
		this.responseEnded = true;
	}

	private setPhase(phase: VoicePhase): void {
		if (this.stopped) return;
		this.phase = phase;
		this.refreshStatus();
	}

	private refreshStatus(): void {
		if (this.microphoneAvailable === false && this.phase !== "error") {
			this.ctx.ui.setStatus(STATUS_KEY, "voice: microphone unavailable; retrying");
			return;
		}
		const labels: Record<VoicePhase, string> = {
			starting: "voice: loading",
			muted: "voice: push-to-talk ready",
			armed: "voice: speak now",
			listening: "voice: listening",
			hearing: "voice: hearing",
			thinking: "voice: thinking",
			speaking: "voice: speaking",
			error: "voice: error",
			off: "voice: off",
		};
		this.ctx.ui.setStatus(STATUS_KEY, labels[this.phase]);
	}

	private handleMicrophoneState(available: boolean, message?: string): void {
		const previous = this.microphoneAvailable;
		this.microphoneAvailable = available;
		this.refreshStatus();
		if (!available && previous !== false) {
			this.debug(`microphone unavailable; retrying: ${message ?? "unknown error"}`);
			this.ctx.ui.notify("voice: microphone unavailable; retrying", "warning");
		} else if (available && previous === false) {
			this.ctx.ui.notify("voice: microphone reconnected", "info");
		}
	}

	private fail(message: string): void {
		if (this.stopped) return;
		console.error(`voice: ${message}`);
		this.setPhase("error");
		this.ctx.ui.notify(`voice: ${message}`, "error");
	}

	private debug(message: string): void {
		if (process.env.PI_VOICE_DEBUG === "1") console.error(`voice: ${message}`);
	}
}
