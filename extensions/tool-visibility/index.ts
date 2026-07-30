import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	installToolVisibilityShim,
	MINIMUM_PI_VERSION,
	type ToolVisibilityController,
} from "./visibility-shim.js";

const STATUS_KEY = "tool-visibility";

type VisibilityAction = "toggle" | "show" | "hide";

export default function toolVisibilityExtension(pi: ExtensionAPI) {
	let controller: ToolVisibilityController | undefined;
	let compatibilityError: string | undefined;

	function stateLabel(): "shown" | "hidden" {
		return controller?.isVisible() === false ? "hidden" : "shown";
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, `TOOLS: ${stateLabel()}`);
	}

	function install(ctx: ExtensionContext): void {
		controller?.dispose();
		controller = undefined;
		compatibilityError = undefined;
		try {
			controller = installToolVisibilityShim();
		} catch (error) {
			compatibilityError = error instanceof Error ? error.message : String(error);
		}
		updateStatus(ctx);
		if (compatibilityError) ctx.ui.notify(compatibilityError, "error");
	}

	function requireTui(ctx: ExtensionContext): ToolVisibilityController | undefined {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("tool visibility controls tool rows only in interactive TUI mode", "warning");
			return undefined;
		}
		if (!controller) {
			ctx.ui.notify(
				compatibilityError ?? "tool visibility shim is not active; run /tools diagnostics",
				"error",
			);
			return undefined;
		}
		return controller;
	}

	function setVisibility(action: VisibilityAction, ctx: ExtensionContext): void {
		const activeController = requireTui(ctx);
		if (!activeController) return;
		const visible = action === "show" || (action === "toggle" && !activeController.isVisible());
		activeController.setVisible(visible);
		// setStatus requests a TUI render, so existing rows disappear or return immediately.
		updateStatus(ctx);
		ctx.ui.notify(`TOOLS: ${visible ? "shown" : "hidden"}`, "info");
	}

	function reportStatus(ctx: ExtensionContext): void {
		ctx.ui.notify(`TOOLS: ${stateLabel()}${compatibilityError ? " (compatibility error)" : ""}`, compatibilityError ? "error" : "info");
	}

	function reportDiagnostics(ctx: ExtensionContext): void {
		if (!controller) {
			ctx.ui.notify(
				`TOOLS diagnostics: Pi compatibility requires >=${MINIMUM_PI_VERSION}; shim inactive; ${compatibilityError ?? `mode=${ctx.mode}`}`,
				compatibilityError ? "error" : "warning",
			);
			return;
		}
		const diagnostics = controller.diagnostics();
		ctx.ui.notify(
			`TOOLS diagnostics: Pi ${diagnostics.piVersion}; minimum ${diagnostics.minimumVersion}; runtime-compatible=${diagnostics.patched}; tools=${diagnostics.visible ? "shown" : "hidden"}; owners=${diagnostics.ownerCount}`,
			diagnostics.patched ? "info" : "error",
		);
	}

	async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
		const action = args.trim().toLowerCase();
		switch (action) {
			case "":
				setVisibility("toggle", ctx);
				return;
			case "show":
				setVisibility("show", ctx);
				return;
			case "hide":
				setVisibility("hide", ctx);
				return;
			case "status":
				reportStatus(ctx);
				return;
			case "diagnostics":
				reportDiagnostics(ctx);
				return;
			default:
				ctx.ui.notify("Usage: /tools [hide|show|status|diagnostics]", "warning");
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") install(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (controller && !controller.dispose()) {
			ctx.ui.notify(
				"tool visibility could not safely restore ToolExecutionComponent.render because another patch replaced it",
				"error",
			);
		}
		controller = undefined;
	});

	pi.registerCommand("tools", {
		description: "Toggle, show, or hide tool rows in chat",
		getArgumentCompletions: (prefix) => {
			const values = ["hide", "show", "status", "diagnostics"];
			const matches = values.filter((value) => value.startsWith(prefix));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: handleCommand,
	});
}
