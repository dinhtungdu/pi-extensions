import { isManagerTaskTerminal, type ManagerTaskTerminal } from "./manager-task-terminal.js";

export interface ManagerTaskTerminalState {
	desired: ManagerTaskTerminal;
	pendingSend?: {
		nonce: string;
		terminal: ManagerTaskTerminal;
	};
	delivery?: {
		messageId: string;
		terminal: ManagerTaskTerminal;
	};
	locked: boolean;
	archived: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameTerminal(left: ManagerTaskTerminal, right: ManagerTaskTerminal): boolean {
	return left.schemaVersion === right.schemaVersion && left.revision === right.revision && left.taskId === right.taskId &&
		left.content === right.content && left.closeThread === right.closeThread;
}

export function parseManagerTaskTerminalState(value: unknown, file: string): ManagerTaskTerminalState | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !isManagerTaskTerminal(value.desired) || typeof value.locked !== "boolean" ||
		typeof value.archived !== "boolean") {
		throw new Error(`Discord bridge state ${file} has an invalid manager task terminal`);
	}
	let pendingSend: ManagerTaskTerminalState["pendingSend"];
	if (value.pendingSend !== undefined) {
		if (!isRecord(value.pendingSend) || typeof value.pendingSend.nonce !== "string" ||
			!isManagerTaskTerminal(value.pendingSend.terminal)) {
			throw new Error(`Discord bridge state ${file} has an invalid pending manager task terminal`);
		}
		pendingSend = { nonce: value.pendingSend.nonce, terminal: structuredClone(value.pendingSend.terminal) };
	}
	let delivery: ManagerTaskTerminalState["delivery"];
	if (value.delivery !== undefined) {
		if (!isRecord(value.delivery) || typeof value.delivery.messageId !== "string" ||
			!isManagerTaskTerminal(value.delivery.terminal)) {
			throw new Error(`Discord bridge state ${file} has an invalid delivered manager task terminal`);
		}
		delivery = { messageId: value.delivery.messageId, terminal: structuredClone(value.delivery.terminal) };
	}
	if (pendingSend && !sameTerminal(pendingSend.terminal, value.desired) ||
		delivery && !sameTerminal(delivery.terminal, value.desired) ||
		pendingSend && delivery || value.locked && !delivery || value.archived && !value.locked) {
		throw new Error(`Discord bridge state ${file} has inconsistent manager task terminal state`);
	}
	return {
		desired: structuredClone(value.desired),
		...(pendingSend ? { pendingSend } : {}),
		...(delivery ? { delivery } : {}),
		locked: value.locked,
		archived: value.archived,
	};
}

interface TerminalMappedSession {
	managerTaskSnapshotTaskId?: string;
	managerTaskTerminal?: ManagerTaskTerminalState;
	lastActiveAt: number;
}

export function setManagerTaskTerminalDesired(
	sessions: Record<string, TerminalMappedSession>,
	terminal: ManagerTaskTerminal,
	now: number,
): { accepted: boolean; sessionId: string; revision: string } {
	const matches = Object.entries(sessions)
		.filter(([, mapping]) => mapping.managerTaskSnapshotTaskId === terminal.taskId);
	if (matches.length === 0) throw new Error(`Manager task ${terminal.taskId} has no Discord session mapping`);
	if (matches.length !== 1) throw new Error(`Manager task ${terminal.taskId} has ambiguous Discord session mappings`);
	const [sessionId, session] = matches[0]!;
	const existing = session.managerTaskTerminal;
	if (existing) {
		if (!sameTerminal(existing.desired, terminal)) {
			throw new Error(`Manager task ${terminal.taskId} has conflicting terminal state`);
		}
		return { accepted: false, sessionId, revision: terminal.revision };
	}
	session.lastActiveAt = now;
	session.managerTaskTerminal = { desired: structuredClone(terminal), locked: false, archived: false };
	return { accepted: true, sessionId, revision: terminal.revision };
}

export function prepareManagerTaskTerminalSend(
	state: ManagerTaskTerminalState | undefined,
	expectedRevision: string,
	createNonce: () => string,
	isValidNonce: (nonce: string) => boolean,
): ManagerTaskTerminalState["pendingSend"] | undefined {
	if (!state || state.desired.revision !== expectedRevision || state.delivery) return undefined;
	if (!state.pendingSend) state.pendingSend = {
		nonce: createNonce(),
		terminal: structuredClone(state.desired),
	};
	else if (!isValidNonce(state.pendingSend.nonce)) state.pendingSend.nonce = createNonce();
	return structuredClone(state.pendingSend);
}

export function recordManagerTaskTerminalSent(
	state: ManagerTaskTerminalState | undefined,
	nonce: string,
	messageId: string,
	expectedRevision: string,
): void {
	if (!state?.pendingSend || state.pendingSend.nonce !== nonce ||
		state.pendingSend.terminal.revision !== expectedRevision) return;
	state.delivery = { messageId, terminal: structuredClone(state.pendingSend.terminal) };
	delete state.pendingSend;
}

export function recordManagerTaskTerminalLocked(
	state: ManagerTaskTerminalState | undefined,
	expectedRevision: string,
): void {
	if (state?.delivery?.terminal.revision === expectedRevision) state.locked = true;
}

export function recordManagerTaskTerminalArchived(
	state: ManagerTaskTerminalState | undefined,
	expectedRevision: string,
): void {
	if (state?.locked && state.delivery?.terminal.revision === expectedRevision) state.archived = true;
}
