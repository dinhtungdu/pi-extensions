import { ToolExecutionComponent, VERSION } from "@earendil-works/pi-coding-agent";

/**
 * Pi 0.82.1 has no public API for hiding every tool row. Keep the unsupported
 * prototype patch in this file so a future Pi upgrade has one obvious failure
 * point. The wrapper only changes rendering; tool component state keeps updating.
 */
export const SUPPORTED_PI_VERSION = "0.82.1";

const PATCH_KEY = Symbol.for("pi-extensions.tool-visibility.v1");

type Render = (width: number) => string[];
type ToolExecutionPrototype = {
	render: Render;
	updateResult?: unknown;
	setExpanded?: unknown;
	setShowImages?: unknown;
	[PATCH_KEY]?: PatchRecord;
};
type ToolExecutionClass = { prototype: ToolExecutionPrototype };
type Owner = { visible: boolean };
type PatchRecord = {
	kind: "pi-extensions.tool-visibility.v1";
	originalDescriptor: PropertyDescriptor;
	originalRender: Render;
	wrapper: Render;
	owners: Set<Owner>;
};

export type ToolVisibilityDiagnostics = {
	piVersion: string;
	supportedVersion: string;
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
};

function assertCompatible(piVersion: string, prototype: ToolExecutionPrototype): void {
	if (piVersion !== SUPPORTED_PI_VERSION) {
		throw new Error(
			`tool-visibility compatibility error: Pi ${SUPPORTED_PI_VERSION} is required; found ${piVersion}. Tool rows were left visible.`,
		);
	}
	if (
		typeof prototype.render !== "function" ||
		typeof prototype.updateResult !== "function" ||
		typeof prototype.setExpanded !== "function" ||
		typeof prototype.setShowImages !== "function"
	) {
		throw new Error(
			"tool-visibility compatibility error: ToolExecutionComponent no longer has the expected Pi 0.82.1 rendering methods. Tool rows were left visible.",
		);
	}
}

/**
 * Install one shared render wrapper. Multiple extension instances become owners
 * of that wrapper, preventing nested patches during reload or duplicate loading.
 */
export function installToolVisibilityShim(options: InstallOptions = {}): ToolVisibilityController {
	const piVersion = options.piVersion ?? VERSION;
	const ToolClass = options.ToolExecutionClass ?? (ToolExecutionComponent as unknown as ToolExecutionClass);
	const prototype = ToolClass.prototype;
	assertCompatible(piVersion, prototype);

	let record = prototype[PATCH_KEY];
	if (record) {
		if (record.kind !== "pi-extensions.tool-visibility.v1" || prototype.render !== record.wrapper) {
			throw new Error(
				"tool-visibility compatibility error: ToolExecutionComponent.render changed after the visibility shim was installed. Tool visibility was not changed.",
			);
		}
	} else {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
		if (!descriptor || typeof descriptor.value !== "function" || descriptor.writable !== true) {
			throw new Error(
				"tool-visibility compatibility error: ToolExecutionComponent.render cannot be patched safely. Tool rows were left visible.",
			);
		}

		record = {
			kind: "pi-extensions.tool-visibility.v1",
			originalDescriptor: descriptor,
			originalRender: descriptor.value as Render,
			wrapper: undefined as unknown as Render,
			owners: new Set(),
		};
		const sharedRecord = record;
		record.wrapper = function (this: ToolExecutionPrototype, width: number): string[] {
			for (const owner of sharedRecord.owners) {
				if (!owner.visible) return [];
			}
			return sharedRecord.originalRender.call(this, width);
		};
		Object.defineProperty(prototype, "render", { ...descriptor, value: record.wrapper });
		Object.defineProperty(prototype, PATCH_KEY, {
			configurable: true,
			value: record,
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
				supportedVersion: SUPPORTED_PI_VERSION,
				visible: owner.visible,
				ownerCount: record.owners.size,
				patched: prototype.render === record.wrapper && prototype[PATCH_KEY] === record,
			};
		},
		dispose() {
			if (disposed) return true;
			disposed = true;
			record.owners.delete(owner);
			if (record.owners.size > 0) return true;

			// Do not overwrite a later third-party patch. Returning false lets the
			// extension report that safe restoration was no longer possible.
			if (prototype.render !== record.wrapper) {
				if (prototype[PATCH_KEY] === record) delete prototype[PATCH_KEY];
				return false;
			}
			Object.defineProperty(prototype, "render", record.originalDescriptor);
			if (prototype[PATCH_KEY] === record) delete prototype[PATCH_KEY];
			return true;
		},
	};
}
