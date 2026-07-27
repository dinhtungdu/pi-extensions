import { AUDIO_SAMPLE_RATE } from "./audio.js";

class SampleRing {
	private readonly samples: Float32Array;
	private total = 0;

	constructor(seconds: number) {
		this.samples = new Float32Array(Math.ceil(AUDIO_SAMPLE_RATE * seconds));
	}

	push(values: Float32Array): void {
		for (const value of values) {
			this.samples[this.total % this.samples.length] = value;
			this.total++;
		}
	}

	readAbsolute(index: number): number {
		const oldest = Math.max(0, this.total - this.samples.length);
		if (index < oldest || index >= this.total) return 0;
		return this.samples[index % this.samples.length] ?? 0;
	}

	tail(length: number): Float32Array {
		const count = Math.min(length, this.total, this.samples.length);
		const output = new Float32Array(count);
		const start = this.total - count;
		for (let index = 0; index < count; index++) output[index] = this.readAbsolute(start + index);
		return output;
	}

	clear(): void {
		this.total = 0;
	}
}

function pcm16ToFloat(pcm: Buffer): Float32Array {
	const output = new Float32Array(Math.floor(pcm.length / 2));
	for (let index = 0; index < output.length; index++) output[index] = pcm.readInt16LE(index * 2) / 32768;
	return output;
}

function floatToPcm16(samples: Float32Array): Buffer {
	const output = Buffer.allocUnsafe(samples.length * 2);
	for (let index = 0; index < samples.length; index++) {
		const value = Math.max(-1, Math.min(1, samples[index] ?? 0));
		output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32768))), index * 2);
	}
	return output;
}

function resample(samples: Float32Array, sourceRate: number): Float32Array {
	if (sourceRate === AUDIO_SAMPLE_RATE) return samples;
	const length = Math.max(1, Math.round((samples.length * AUDIO_SAMPLE_RATE) / sourceRate));
	const output = new Float32Array(length);
	const scale = sourceRate / AUDIO_SAMPLE_RATE;
	for (let index = 0; index < length; index++) {
		const position = index * scale;
		const left = Math.min(samples.length - 1, Math.floor(position));
		const right = Math.min(samples.length - 1, left + 1);
		const fraction = position - left;
		output[index] = (samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction;
	}
	return output;
}

function rms(samples: Float32Array): number {
	let energy = 0;
	for (const sample of samples) energy += sample * sample;
	return Math.sqrt(energy / Math.max(1, samples.length));
}

export interface BargeInConfig {
	micThreshold: number;
	residualThreshold: number;
	triggerFrames: number;
	maxEchoDelayMs: number;
}

export class BargeInDetector {
	private readonly micHistory = new SampleRing(1);
	private readonly playbackHistory = new SampleRing(120);
	private consecutive = 0;
	private playbackStartedAt = 0;

	constructor(private readonly config: BargeInConfig) {}

	startPlayback(): void {
		this.playbackHistory.clear();
		this.playbackStartedAt = Date.now();
	}

	pushPlayback(pcm: Buffer, sampleRate: number): void {
		this.playbackHistory.push(resample(pcm16ToFloat(pcm), sampleRate));
	}

	observe(pcm: Buffer, compareWithPlayback: boolean): boolean {
		const mic = pcm16ToFloat(pcm);
		this.micHistory.push(mic);
		const micRms = rms(mic);
		let triggered = micRms >= this.config.micThreshold;
		if (triggered && compareWithPlayback) {
			const residual = this.smallestResidual(mic, micRms * micRms);
			triggered = residual >= this.config.residualThreshold;
		}
		this.consecutive = triggered ? this.consecutive + 1 : Math.max(0, this.consecutive - 1);
		if (this.consecutive < this.config.triggerFrames) return false;
		this.consecutive = 0;
		return true;
	}

	preroll(): Buffer {
		return floatToPcm16(this.micHistory.tail(AUDIO_SAMPLE_RATE));
	}

	reset(): void {
		this.consecutive = 0;
		this.playbackStartedAt = 0;
		this.playbackHistory.clear();
	}

	private smallestResidual(mic: Float32Array, micEnergy: number): number {
		if (micEnergy < 1e-7) return 0;
		let smallest = 1;
		if (!this.playbackStartedAt) return 1;
		const elapsedSamples = Math.round(((Date.now() - this.playbackStartedAt) * AUDIO_SAMPLE_RATE) / 1000);
		const minDelaySamples = Math.round(AUDIO_SAMPLE_RATE * 0.02);
		const maxDelaySamples = Math.round((AUDIO_SAMPLE_RATE * this.config.maxEchoDelayMs) / 1000);
		const step = Math.round(AUDIO_SAMPLE_RATE * 0.02);
		for (let delay = minDelaySamples; delay <= maxDelaySamples; delay += step) {
			let referenceEnergy = 0;
			let dot = 0;
			const frameStart = elapsedSamples - delay - mic.length;
			for (let index = 0; index < mic.length; index++) {
				const reference = this.playbackHistory.readAbsolute(frameStart + index);
				referenceEnergy += reference * reference;
				dot += (mic[index] ?? 0) * reference;
			}
			referenceEnergy /= Math.max(1, mic.length);
			dot /= Math.max(1, mic.length);
			if (referenceEnergy < 1e-7) continue;
			const explainedEnergy = (dot * dot) / referenceEnergy;
			const residual = Math.max(0, micEnergy - explainedEnergy) / micEnergy;
			smallest = Math.min(smallest, residual);
		}
		return smallest;
	}
}
