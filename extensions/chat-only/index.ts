import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	installToolVisibilityShim,
	SUPPORTED_PI_VERSION,
	type ToolVisibilityController,
} from "./visibility-shim.js";

const STATUS_KEY = "chat-only";

type VisibilityAction = "toggle" | "show" | "hide";

export default function chatOnlyExtension(pi: ExtensionAPI) {
	let controller: ToolVisibilityController | undefined;
	let compatibilityError: string | undefined;

	function stateLabel(): "shown" | "hidden" {
		return controller?.isVisible() === false ? "hidden" : "shown";
	}

	function updateStatus(ctx: ExtensionContext): void {
		const warning = compatibilityError ? " ⚠" : "";
		ctx.ui.setStatus(STATUS_KEY, `CHAT tools: ${stateLabel()}${warning}`);
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
			ctx.ui.notify("chat-only controls tool rows only in interactive TUI mode", "warning");
			return undefined;
		}
		if (!controller) {
			ctx.ui.notify(
				compatibilityError ?? "chat-only visibility shim is not active; run /chat-only diagnostics",
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
		ctx.ui.notify(`CHAT tools ${visible ? "shown" : "hidden"}`, "info");
	}

	function reportStatus(ctx: ExtensionContext): void {
		ctx.ui.notify(`CHAT tools: ${stateLabel()}${compatibilityError ? " (compatibility error)" : ""}`, compatibilityError ? "error" : "info");
	}

	function reportDiagnostics(ctx: ExtensionContext): void {
		if (!controller) {
			ctx.ui.notify(
				`CHAT diagnostics: Pi compatibility target ${SUPPORTED_PI_VERSION}; shim inactive; ${compatibilityError ?? `mode=${ctx.mode}`}`,
				compatibilityError ? "error" : "warning",
			);
			return;
		}
		const diagnostics = controller.diagnostics();
		ctx.ui.notify(
			`CHAT diagnostics: Pi ${diagnostics.piVersion}; target ${diagnostics.supportedVersion}; tools=${diagnostics.visible ? "shown" : "hidden"}; patched=${diagnostics.patched}; owners=${diagnostics.ownerCount}`,
			diagnostics.patched ? "info" : "error",
		);
	}

	async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
		const action = args.trim().toLowerCase();
		switch (action) {
			case "":
			case "toggle":
				setVisibility("toggle", ctx);
				return;
			case "show":
			case "visible":
			case "off":
			case "disable":
				setVisibility("show", ctx);
				return;
			case "hide":
			case "hidden":
			case "on":
			case "enable":
				setVisibility("hide", ctx);
				return;
			case "status":
				reportStatus(ctx);
				return;
			case "diagnostics":
			case "diagnostic":
			case "diag":
				reportDiagnostics(ctx);
				return;
			default:
				ctx.ui.notify("Usage: /chat-only [toggle|show|hide|status|diagnostics]", "warning");
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") install(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (controller && !controller.dispose()) {
			ctx.ui.notify(
				"chat-only could not safely restore ToolExecutionComponent.render because another patch replaced it",
				"error",
			);
		}
		controller = undefined;
	});

	pi.registerCommand("chat-only", {
		description: "Toggle, show, or hide tool rows in chat",
		getArgumentCompletions: (prefix) => {
			const values = ["toggle", "show", "hide", "status", "diagnostics"];
			const matches = values.filter((value) => value.startsWith(prefix));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: handleCommand,
	});

	pi.registerCommand("chat-tools", {
		description: "Alias for /chat-only",
		handler: handleCommand,
	});

	pi.registerCommand("show-tools", {
		description: "Show all tool rows in chat",
		handler: async (_args, ctx) => setVisibility("show", ctx),
	});

	pi.registerCommand("hide-tools", {
		description: "Hide all tool rows from chat",
		handler: async (_args, ctx) => setVisibility("hide", ctx),
	});
}
