import { watch, type FSWatcher, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	FooterComponent,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { VoicePhase } from "./runtime.js";

const FAST_STATE_FILE = join(getAgentDir(), "openai-codex-fast-mode.json");
const VOICE_ICON = "🎙";

type FooterRenderer = Pick<Component, "render">;

function readFastModeEnabled(): boolean {
	try {
		const value = JSON.parse(readFileSync(FAST_STATE_FILE, "utf8")) as { enabled?: unknown };
		return value.enabled === true;
	} catch {
		return false;
	}
}

function alignLeftRight(left: string, right: string, width: number, ellipsis: string): string {
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, ellipsis);

	const leftWidth = Math.max(0, width - rightWidth - 2);
	const compactLeft = leftWidth > 0 ? truncateToWidth(left, leftWidth, ellipsis) : "";
	const padding = " ".repeat(Math.max(0, width - visibleWidth(compactLeft) - rightWidth));
	return compactLeft + padding + right;
}

export function renderTwoLineFooter(
	defaultFooter: FooterRenderer,
	width: number,
	badgeSuffix: string,
	ellipsis = "...",
): string[] {
	const fullLines = defaultFooter.render(width);
	const statusLine = fullLines.slice(2).join(" ");
	const firstLine = statusLine
		? alignLeftRight(fullLines[0] ?? "", statusLine, width, ellipsis)
		: truncateToWidth(fullLines[0] ?? "", width, ellipsis);

	const suffixWidth = visibleWidth(badgeSuffix);
	const statsWidth = Math.max(0, width - suffixWidth);
	const compactLines = statsWidth > 0 ? defaultFooter.render(statsWidth) : [];
	const statsLine = truncateToWidth(compactLines[1] ?? "", statsWidth, "");
	const secondLine = truncateToWidth(statsLine + badgeSuffix, width, "");

	return [firstLine, secondLine];
}

function voiceColor(phase: VoicePhase): "dim" | "accent" | "success" | "error" {
	switch (phase) {
		case "listening":
			return "success";
		case "armed":
		case "hearing":
		case "speaking":
			return "accent";
		case "error":
			return "error";
		default:
			return "dim";
	}
}

export class VoiceFooterController {
	private ctx?: ExtensionContext;
	private phase?: VoicePhase;
	private fastModeEnabled = readFastModeEnabled();
	private watcher?: FSWatcher;
	private footerInstalled = false;
	private requestRender?: () => void;
	private refreshPending = false;

	constructor(private readonly pi: ExtensionAPI) {}

	activate(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.phase = "starting";
		this.fastModeEnabled = readFastModeEnabled();
		this.startFastModeWatcher();
		this.installFooter(true);
	}

	setPhase(phase: VoicePhase): void {
		this.phase = phase;
		this.requestRender?.();
	}

	deactivate(): void {
		this.phase = undefined;
		this.stopFastModeWatcher();
		this.fastModeEnabled = readFastModeEnabled();
		if (this.fastModeEnabled) {
			this.installFooter(true);
			this.requestRender?.();
		} else {
			this.restoreDefaultFooter();
		}
	}

	dispose(): void {
		this.phase = undefined;
		this.stopFastModeWatcher();
		this.restoreDefaultFooter();
		this.ctx = undefined;
	}

	private installFooter(force = false): void {
		const ctx = this.ctx;
		if (!ctx || ctx.mode !== "tui" || (this.footerInstalled && !force)) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const thisController = this;
			const sessionAdapter = {
				get state() {
					return {
						model: ctx.model,
						thinkingLevel: thisController.pi.getThinkingLevel(),
					};
				},
				sessionManager: ctx.sessionManager,
				modelRuntime: {
					isUsingOAuth(providerId: string) {
						const model = ctx.model;
						return model?.provider === providerId && ctx.modelRegistry.isUsingOAuth(model);
					},
				},
				getContextUsage: () => ctx.getContextUsage(),
			};
			const defaultFooter = new FooterComponent(sessionAdapter as never, footerData);
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			this.requestRender = () => tui.requestRender();

			return {
				dispose() {
					unsubscribe();
					defaultFooter.dispose();
				},
				invalidate() {
					defaultFooter.invalidate();
				},
				render(width: number): string[] {
					const badges: string[] = [];
					if (thisController.fastModeEnabled) badges.push(theme.fg("dim", "fast"));
					if (thisController.phase && thisController.phase !== "off") {
						badges.push(theme.fg(voiceColor(thisController.phase), VOICE_ICON));
					}
					const suffix = badges.length ? ` ${theme.fg("dim", "•")} ${badges.join(` ${theme.fg("dim", "•")} `)}` : "";
					return renderTwoLineFooter(defaultFooter, width, suffix, theme.fg("dim", "..."));
				},
			};
		});

		this.footerInstalled = true;
	}

	private restoreDefaultFooter(): void {
		if (!this.footerInstalled || this.ctx?.mode !== "tui") return;
		this.ctx.ui.setFooter(undefined);
		this.footerInstalled = false;
		this.requestRender = undefined;
	}

	private startFastModeWatcher(): void {
		if (this.watcher) return;
		try {
			this.watcher = watch(dirname(FAST_STATE_FILE), { persistent: false }, (_event, filename) => {
				if (filename && basename(String(filename)) === basename(FAST_STATE_FILE)) this.scheduleFastModeRefresh();
			});
		} catch {
			// Fast Mode integration is optional; voice footer still works without it.
		}
	}

	private stopFastModeWatcher(): void {
		this.watcher?.close();
		this.watcher = undefined;
		this.refreshPending = false;
	}

	private scheduleFastModeRefresh(): void {
		if (this.refreshPending) return;
		this.refreshPending = true;
		queueMicrotask(() => {
			this.refreshPending = false;
			if (!this.phase || this.phase === "off") return;
			this.fastModeEnabled = readFastModeEnabled();
			// Fast Mode owns a custom footer too. Reinstall after its atomic state
			// write so both badges remain on the same two-line footer.
			this.installFooter(true);
		});
	}
}
