import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	VERSION,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi has no public API for hiding every tool row or collapsed thinking-only
 * placeholder. Keep the unsupported prototype patches in this file so a future
 * Pi upgrade has one obvious failure point. The wrappers only change rendering;
 * component state keeps updating.
 */
export const MINIMUM_PI_VERSION = "0.82.1";

const PATCH_KEY = Symbol.for("pi-extensions.tool-visibility.v1");
const THINKING_PATCH_KEY = Symbol.for("pi-extensions.tool-visibility.thinking.v1");

type Render = (width: number, ...args: unknown[]) => string[];
type Owner = { visible: boolean };
type ToolExecutionPrototype = {
	render: Render;
	[PATCH_KEY]?: PatchRecord;
};
type ToolExecutionClass = { prototype: ToolExecutionPrototype };
type AssistantContent = { type?: string; text?: string; thinking?: string };
type AssistantMessagePrototype = {
	render: Render;
	hideThinkingBlock?: boolean;
	lastMessage?: { content?: AssistantContent[]; stopReason?: string };
	[THINKING_PATCH_KEY]?: ThinkingPatchRecord;
};
type AssistantMessageClass = { prototype: AssistantMessagePrototype };
type ThinkingPatchRecord = {
	kind: "pi-extensions.tool-visibility.thinking.v1";
	originalDescriptor: PropertyDescriptor;
	originalRender: Render;
	wrapper: Render;
	owners: Set<Owner>;
};
type PatchRecord = {
	kind: "pi-extensions.tool-visibility.v1";
	originalDescriptor: PropertyDescriptor;
	originalRender: Render;
	wrapper: Render;
	owners: Set<Owner>;
	thinkingPatch: ThinkingPatchRecord;
};

export type ToolVisibilityDiagnostics = {
	piVersion: string;
	minimumVersion: string;
	visible: boolean;
	ownerCount: number;
	patched: boolean;
};

export type ToolVisibilityController = {
	isVisible(): boolean;
	setVisible(visible: boolean): void;
	diagnostics(): ToolVisibilityDiagnostics;
	dispose(): boolean;
};

type InstallOptions = {
	piVersion?: string;
	ToolExecutionClass?: ToolExecutionClass;
	AssistantMessageClass?: AssistantMessageClass;
};

function parseVersion(version: string): { parts: [number, number, number]; prerelease: boolean } | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
	if (!match) return undefined;
	return {
		parts: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: match[4] !== undefined,
	};
}

function isSupportedVersion(piVersion: string): boolean {
	const current = parseVersion(piVersion);
	const minimum = parseVersion(MINIMUM_PI_VERSION);
	if (!current || !minimum) return false;
	for (let index = 0; index < current.parts.length; index++) {
		if (current.parts[index] !== minimum.parts[index]) {
			return current.parts[index] > minimum.parts[index];
		}
	}
	return !current.prerelease;
}

function assertCompatible(
	piVersion: string,
	toolPrototype: ToolExecutionPrototype,
	assistantPrototype: AssistantMessagePrototype,
): void {
	if (!isSupportedVersion(piVersion)) {
		throw new Error(
			`tool-visibility compatibility error: requires Pi >=${MINIMUM_PI_VERSION}; found ${piVersion}. Compact rendering was left unchanged.`,
		);
	}
	if (typeof toolPrototype.render !== "function") {
		throw new Error(
			"tool-visibility compatibility error: ToolExecutionComponent.render is unavailable. Compact rendering was left unchanged.",
		);
	}
	if (typeof assistantPrototype.render !== "function") {
		throw new Error(
			"tool-visibility compatibility error: AssistantMessageComponent.render is unavailable. Compact rendering was left unchanged.",
		);
	}
}

function patchableDescriptor(prototype: object, componentName: string): PropertyDescriptor {
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
	if (!descriptor || typeof descriptor.value !== "function" || descriptor.writable !== true) {
		throw new Error(
			`tool-visibility compatibility error: ${componentName}.render cannot be patched safely. Compact rendering was left unchanged.`,
		);
	}
	return descriptor;
}

function isCollapsedThinkingOnly(component: AssistantMessagePrototype): boolean {
	if (!component.hideThinkingBlock) return false;
	const message = component.lastMessage;
	if (!message || ["length", "aborted", "error"].includes(message.stopReason ?? "")) return false;
	const content = message.content ?? [];
	const hasThinking = content.some(
		(item) => item.type === "thinking" && typeof item.thinking === "string" && item.thinking.trim(),
	);
	const hasText = content.some(
		(item) => item.type === "text" && typeof item.text === "string" && item.text.trim(),
	);
	return hasThinking && !hasText;
}

/**
 * Install one shared render wrapper. Multiple extension instances become owners
 * of that wrapper, preventing nested patches during reload or duplicate loading.
 */
export function installToolVisibilityShim(options: InstallOptions = {}): ToolVisibilityController {
	const piVersion = options.piVersion ?? VERSION;
	const ToolClass = options.ToolExecutionClass ?? (ToolExecutionComponent as unknown as ToolExecutionClass);
	const AssistantClass = options.AssistantMessageClass ?? (AssistantMessageComponent as unknown as AssistantMessageClass);
	const prototype = ToolClass.prototype;
	const assistantPrototype = AssistantClass.prototype;
	assertCompatible(piVersion, prototype, assistantPrototype);

	let record = prototype[PATCH_KEY];
	if (record) {
		const thinkingPatch = assistantPrototype[THINKING_PATCH_KEY];
		if (
			record.kind !== "pi-extensions.tool-visibility.v1" ||
			prototype.render !== record.wrapper ||
			!record.thinkingPatch ||
			!thinkingPatch ||
			thinkingPatch !== record.thinkingPatch ||
			assistantPrototype.render !== thinkingPatch.wrapper
		) {
			throw new Error(
				"tool-visibility compatibility error: compact rendering changed after the visibility shim was installed. Visibility was not changed.",
			);
		}
	} else {
		if (assistantPrototype[THINKING_PATCH_KEY]) {
			throw new Error(
				"tool-visibility compatibility error: an orphaned thinking patch is already installed. Compact rendering was left unchanged.",
			);
		}
		const descriptor = patchableDescriptor(prototype, "ToolExecutionComponent");
		const thinkingDescriptor = patchableDescriptor(assistantPrototype, "AssistantMessageComponent");
		const owners = new Set<Owner>();
		const thinkingPatch: ThinkingPatchRecord = {
			kind: "pi-extensions.tool-visibility.thinking.v1",
			originalDescriptor: thinkingDescriptor,
			originalRender: thinkingDescriptor.value as Render,
			wrapper: undefined as unknown as Render,
			owners,
		};
		thinkingPatch.wrapper = function (
			this: AssistantMessagePrototype,
			width: number,
			...args: unknown[]
		): string[] {
			for (const owner of thinkingPatch.owners) {
				if (!owner.visible && isCollapsedThinkingOnly(this)) return [];
			}
			return thinkingPatch.originalRender.call(this, width, ...args);
		};

		record = {
			kind: "pi-extensions.tool-visibility.v1",
			originalDescriptor: descriptor,
			originalRender: descriptor.value as Render,
			wrapper: undefined as unknown as Render,
			owners,
			thinkingPatch,
		};
		const sharedRecord = record;
		record.wrapper = function (this: ToolExecutionPrototype, width: number, ...args: unknown[]): string[] {
			for (const owner of sharedRecord.owners) {
				if (!owner.visible) return [];
			}
			return sharedRecord.originalRender.call(this, width, ...args);
		};
		Object.defineProperty(prototype, "render", { ...descriptor, value: record.wrapper });
		Object.defineProperty(prototype, PATCH_KEY, {
			configurable: true,
			value: record,
			writable: false,
		});
		Object.defineProperty(assistantPrototype, "render", {
			...thinkingDescriptor,
			value: thinkingPatch.wrapper,
		});
		Object.defineProperty(assistantPrototype, THINKING_PATCH_KEY, {
			configurable: true,
			value: thinkingPatch,
			writable: false,
		});
	}

	const owner: Owner = { visible: true };
	record.owners.add(owner);
	let disposed = false;

	return {
		isVisible: () => owner.visible,
		setVisible(visible) {
			if (disposed) throw new Error("tool-visibility controller is disposed");
			owner.visible = visible;
		},
		diagnostics() {
			return {
				piVersion,
				minimumVersion: MINIMUM_PI_VERSION,
				visible: owner.visible,
				ownerCount: record.owners.size,
				patched:
					prototype.render === record.wrapper &&
					prototype[PATCH_KEY] === record &&
					assistantPrototype.render === record.thinkingPatch.wrapper &&
					assistantPrototype[THINKING_PATCH_KEY] === record.thinkingPatch,
			};
		},
		dispose() {
			if (disposed) return true;
			disposed = true;
			record.owners.delete(owner);
			if (record.owners.size > 0) return true;

			// Do not overwrite later third-party patches. Returning false lets the
			// extension report that safe restoration was no longer possible.
			let restored = true;
			if (prototype.render === record.wrapper) {
				Object.defineProperty(prototype, "render", record.originalDescriptor);
			} else {
				restored = false;
			}
			if (prototype[PATCH_KEY] === record) delete prototype[PATCH_KEY];

			const thinkingPatch = record.thinkingPatch;
			if (assistantPrototype.render === thinkingPatch.wrapper) {
				Object.defineProperty(assistantPrototype, "render", thinkingPatch.originalDescriptor);
			} else {
				restored = false;
			}
			if (assistantPrototype[THINKING_PATCH_KEY] === thinkingPatch) {
				delete assistantPrototype[THINKING_PATCH_KEY];
			}
			return restored;
		},
	};
}
