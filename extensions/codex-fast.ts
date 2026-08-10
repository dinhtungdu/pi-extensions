import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PACKAGE_FOOTER_STATUS_KEYS } from "./footer-status.js";

export const CODEX_FAST_STATUS_KEY = PACKAGE_FOOTER_STATUS_KEYS.codexFast;
export const CODEX_FAST_STATUS_ICON = "⚡";

function isOpenAICodex(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai-codex" && ctx.model.api === "openai-codex-responses";
}

function syncStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus(CODEX_FAST_STATUS_KEY, isOpenAICodex(ctx) ? CODEX_FAST_STATUS_ICON : undefined);
}

export default function codexFastExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		syncStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		syncStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isOpenAICodex(ctx) || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
			return;
		}
		return { ...event.payload, service_tier: "priority" };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(CODEX_FAST_STATUS_KEY, undefined);
	});
}
