// Pi 0.83 renders extension statuses by key.localeCompare(); this package must precede the installed "agentmemory" key.
export const PACKAGE_FOOTER_STATUS_PREFIX = "aa-pi-extensions";

export const PACKAGE_FOOTER_STATUS_KEYS = {
	discord: `${PACKAGE_FOOTER_STATUS_PREFIX}-discord`,
	goal: `${PACKAGE_FOOTER_STATUS_PREFIX}-goal`,
	toolVisibility: `${PACKAGE_FOOTER_STATUS_PREFIX}-tool-visibility`,
	voice: `${PACKAGE_FOOTER_STATUS_PREFIX}-voice`,
} as const;
