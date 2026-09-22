import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	VERSION,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi has no public API for hiding every tool row or removing collapsed thinking
 * labels without reserved rows. Keep the unsupported prototype patches in this
 * file so a future Pi upgrade has one obvious failure point. The wrappers only
 * change rendering; component state keeps updating.
 */
export const MINIMUM_PI_VERSION = "0.82.1";

/**
 * Applied through the public setHiddenThinkingLabel API while compact mode is
 * active. The zero-width marker cannot wrap into visible fragments; the assistant
 * render wrapper removes rows carrying it without reading component private fields.
 */
export const COMPACT_HIDDEN_THINKING_LABEL = "\u2063\u2064\u2063";

const PATCH_KEY = Symbol.for("pi-extensions.tool-visibility.v1");
const THINKING_PATCH_KEY = Symbol.for("pi-extensions.tool-visibility.thinking.v1");

type Render = (width: number, ...args: unknown[]) => string[];
type Owner = { visible: boolean };
type ToolExecutionPrototype = {
	render: Render;
	[PATCH_KEY]?: PatchRecord;
};
type ToolExecutionClass = { prototype: ToolExecutionPrototype };
type AssistantMessagePrototype = {
	render: Render;
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
	isCompact(): boolean;
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
	if (!Object.isExtensible(prototype)) {
		throw new Error(
			`tool-visibility compatibility error: ${componentName}.prototype cannot store patch metadata. Compact rendering was left unchanged.`,
		);
	}
	return descriptor;
}

function isCompact(owners: Set<Owner>): boolean {
	for (const owner of owners) {
		if (!owner.visible) return true;
	}
	return false;
}

function hasVisibleTerminalContent(line: string): boolean {
	return line
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.trim().length > 0;
}

function deleteOwn(prototype: object, key: symbol): void {
	if (!Reflect.deleteProperty(prototype, key)) {
		throw new Error(`could not remove ${String(key)}`);
	}
}

/**
 * Install shared render wrappers. All target checks happen before mutation, and
 * an unexpected defineProperty failure rolls every completed mutation back.
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

		// Full preflight: neither prototype is mutated until both targets pass.
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
			const lines = thinkingPatch.originalRender.call(this, width, ...args);
			if (!isCompact(thinkingPatch.owners)) return lines;
			const filtered = lines.filter((line) => !line.includes(COMPACT_HIDDEN_THINKING_LABEL));
			return filtered.some(hasVisibleTerminalContent) ? filtered : [];
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
			return isCompact(sharedRecord.owners)
				? []
				: sharedRecord.originalRender.call(this, width, ...args);
		};

		try {
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
		} catch (error) {
			try {
				// Check actual values rather than completed-call flags: a Proxy trap
				// can apply a descriptor and still throw from defineProperty.
				if (assistantPrototype[THINKING_PATCH_KEY] === thinkingPatch) {
					deleteOwn(assistantPrototype, THINKING_PATCH_KEY);
				}
				if (assistantPrototype.render === thinkingPatch.wrapper) {
					Object.defineProperty(assistantPrototype, "render", thinkingDescriptor);
				}
				if (prototype[PATCH_KEY] === record) deleteOwn(prototype, PATCH_KEY);
				if (prototype.render === record.wrapper) Object.defineProperty(prototype, "render", descriptor);
				if (
					prototype.render !== descriptor.value ||
					assistantPrototype.render !== thinkingDescriptor.value ||
					prototype[PATCH_KEY] !== undefined ||
					assistantPrototype[THINKING_PATCH_KEY] !== undefined
				) {
					throw new Error("original render identities or patch metadata were not restored");
				}
			} catch (rollbackError) {
				throw new Error(
					`tool-visibility compatibility error: compact rendering installation failed and rollback failed: ${String(rollbackError)}`,
					{ cause: error },
				);
			}
			throw new Error(
				`tool-visibility compatibility error: compact rendering installation failed and was rolled back: ${String(error)}`,
				{ cause: error },
			);
		}
	}

	const owner: Owner = { visible: true };
	record.owners.add(owner);
	let disposed = false;

	return {
		isVisible: () => owner.visible,
		isCompact: () => isCompact(record.owners),
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
