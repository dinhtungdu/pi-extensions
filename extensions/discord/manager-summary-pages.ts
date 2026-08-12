import { createHash } from "node:crypto";
import type { ManagerPresentation } from "./manager-presentation.js";

export const DISCORD_MANAGER_SUMMARY_PAGE_LIMIT = 2_000;
export const MANAGER_SUMMARY_PAGE_PAYLOAD_LIMIT = 1_900;
export const MAX_MANAGER_SUMMARY_PAGES = 99;

const PAGE_MARKER = /(?:^|\n)-# Manager summary · ([a-f0-9]{64}) · ([1-9]\d?)\/([1-9]\d?)$/;

export interface ManagerSummaryPageMetadata {
	revision: string;
	page: number;
	total: number;
}

export interface ManagerSummaryPage extends ManagerSummaryPageMetadata {
	payload: string;
	content: string;
	presentation: ManagerPresentation;
}

export function managerSummaryPageMetadata(content: string): ManagerSummaryPageMetadata | undefined {
	const match = PAGE_MARKER.exec(content);
	if (!match) return undefined;
	const page = Number(match[2]);
	const total = Number(match[3]);
	if (page > total || total > MAX_MANAGER_SUMMARY_PAGES) return undefined;
	return { revision: match[1]!, page, total };
}

function splitManagerSummaryContent(content: string): string[] {
	const chunks: string[] = [];
	let offset = 0;
	while (content.length - offset > MANAGER_SUMMARY_PAGE_PAYLOAD_LIMIT) {
		const maximum = offset + MANAGER_SUMMARY_PAGE_PAYLOAD_LIMIT;
		const minimum = offset + Math.floor(MANAGER_SUMMARY_PAGE_PAYLOAD_LIMIT / 2);
		let cut = content.lastIndexOf("\n", maximum - 1);
		if (cut >= minimum) cut++;
		else {
			cut = content.lastIndexOf(" ", maximum - 1);
			if (cut >= minimum) cut++;
			else cut = maximum;
		}
		if (cut > offset && /[\uD800-\uDBFF]/.test(content[cut - 1]!) && /[\uDC00-\uDFFF]/.test(content[cut]!)) cut--;
		chunks.push(content.slice(offset, cut));
		offset = cut;
	}
	chunks.push(content.slice(offset));
	return chunks;
}

export function paginateManagerPresentation(presentation: ManagerPresentation): ManagerSummaryPage[] {
	const chunks = splitManagerSummaryContent(presentation.content);
	if (chunks.length > MAX_MANAGER_SUMMARY_PAGES) throw new Error("Discord manager summary exceeds the 99-page limit");
	const batchRevision = createHash("sha256").update(JSON.stringify(presentation)).digest("hex");
	return chunks.map((chunk, index) => {
		const page = index + 1;
		const marker = `${chunk.endsWith("\n") ? "" : "\n"}-# Manager summary · ${batchRevision} · ${page}/${chunks.length}`;
		const content = `${chunk}${marker}`;
		if (content.length > DISCORD_MANAGER_SUMMARY_PAGE_LIMIT) throw new Error("Discord manager summary page exceeds 2000 characters");
		return {
			revision: batchRevision,
			page,
			payload: chunk,
			total: chunks.length,
			content,
			presentation: {
				...presentation,
				content,
				controls: page === chunks.length ? presentation.controls.map((control) => ({ ...control })) : [],
				warnings: [...presentation.warnings],
			},
		};
	});
}
