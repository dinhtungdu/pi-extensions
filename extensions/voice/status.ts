import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VoicePhase } from "./runtime.js";

export const VOICE_STATUS_KEY = "voice";
export const VOICE_STATUS_ICON = "🎙";

function voiceColor(phase: VoicePhase): "dim" | "accent" | "success" | "error" {
	switch (phase) {
		case "listening":
			return "success";
		case "hearing":
		case "speaking":
			return "accent";
		case "error":
			return "error";
		default:
			return "dim";
	}
}

export function syncVoiceStatus(ctx: ExtensionContext, phase: VoicePhase): void {
	ctx.ui.setStatus(
		VOICE_STATUS_KEY,
		phase === "off" ? undefined : ctx.ui.theme.fg(voiceColor(phase), VOICE_STATUS_ICON),
	);
}
