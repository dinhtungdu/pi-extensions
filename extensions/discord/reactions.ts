export const DISCORD_LIFECYCLE_REACTIONS = ["👀", "🤔", "⚙️", "✅", "❌"] as const;

export type DiscordLifecycleReaction = typeof DISCORD_LIFECYCLE_REACTIONS[number];
export type DiscordLifecycleStatus = "accepted" | "thinking" | "tool" | "succeeded" | "failed";

const REACTION_BY_STATUS: Record<DiscordLifecycleStatus, DiscordLifecycleReaction> = {
	accepted: "👀",
	thinking: "🤔",
	tool: "⚙️",
	succeeded: "✅",
	failed: "❌",
};

const STATUS_RANK: Record<DiscordLifecycleStatus, number> = {
	accepted: 0,
	thinking: 1,
	tool: 2,
	succeeded: 3,
	failed: 3,
};

export function lifecycleReaction(status: DiscordLifecycleStatus): DiscordLifecycleReaction {
	return REACTION_BY_STATUS[status];
}

export function canAdvanceLifecycleStatus(current: DiscordLifecycleStatus, next: DiscordLifecycleStatus): boolean {
	if (current === next) return true;
	if (STATUS_RANK[current] >= 3) return false;
	return STATUS_RANK[next] >= STATUS_RANK[current];
}
