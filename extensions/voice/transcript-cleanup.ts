const PROTECTED_SPAN = /`[^`]*`|"[^"\n]*"|(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])|https?:\/\/\S+|(?:~|\.{1,2})?\/[\w@%+.,:=~-]+(?:\/[\w@%+.,:=~-]+)*|\b\d+(?:[.:/-]\d+)*\b|\b[A-Za-z_$][\w$]*(?:[._:/-][\w@+.-]+)+\b|\b[A-Za-z]+(?:[A-Z][A-Za-z0-9]*)+\b|\b[A-Z][A-Z0-9_]{1,}\b|\b(?:not|no|never|without|cannot|can't|don't|doesn't|didn't|won't|shouldn't|mustn't)\b/gu;
const TECHNICAL_TOKEN = /\b(?:\d+(?:[.:/-]\d+)*|[A-Za-z_$][\w$]*(?:[._:/-][\w@+.-]+)+|[A-Za-z]+(?:[A-Z][A-Za-z0-9]*)+|[A-Z][A-Z0-9_]{1,}|(?:not|no|never|without|cannot|can't|don't|doesn't|didn't|won't|shouldn't|mustn't))\b/gu;

function protect(text: string): { text: string; spans: string[] } {
	const spans: string[] = [];
	return {
		text: text.replace(PROTECTED_SPAN, (span) => {
			const marker = `\uE000${spans.length}\uE001`;
			spans.push(span);
			return marker;
		}),
		spans,
	};
}

function restore(text: string, spans: string[]): string {
	return text.replace(/\uE000(\d+)\uE001/g, (marker, index) => spans[Number(index)] ?? marker);
}

/** Conservative local cleanup. Protected technical and quoted spans are restored byte-for-byte. */
export function cleanTranscriptDeterministically(raw: string): string {
	const protectedText = protect(raw.trim());
	let text = protectedText.text;

	// Remove only unmistakable discourse fillers. Do not remove "like" or words
	// in arbitrary positions because they may be identifiers or meaningful prose.
	text = text
		.replace(/(^|[.!?]\s+)(?:um+|uh+|erm+|hmm+)(?:\s*,\s*|\s+)/giu, "$1")
		.replace(/(^|[.!?]\s+)(?:you know|I mean)\s*,\s*/giu, "$1")
		.replace(/\s*,\s*(?:um+|uh+|erm+|hmm+|you know)\s*,\s*/giu, " ");

	// Collapse exact short restarts: "the login—the login component" and
	// "can you, can you inspect". Exact matching keeps this deliberately narrow.
	text = text
		.replace(/\b([\p{L}\p{N}_'-]+(?:\s+[\p{L}\p{N}_'-]+){0,3})\s*(?:—|--)\s*\1\b/giu, "$1")
		.replace(/\b([\p{L}\p{N}_'-]+(?:\s+[\p{L}\p{N}_'-]+){0,2})\s*,\s*\1\b/giu, "$1");

	text = text
		.replace(/\b(and|or|but),\s+/giu, "$1 ")
		.replace(/\s+([,.;:!?])/g, "$1")
		.replace(/([,.;:!?])(?=\S)/g, "$1 ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());

	return restore(text, protectedText.spans);
}

export function protectedTranscriptTerms(raw: string): string[] {
	const spans = raw.match(PROTECTED_SPAN) ?? [];
	const tokens = raw.match(TECHNICAL_TOKEN) ?? [];
	return [...new Set([...spans, ...tokens])];
}

export function preservesTechnicalText(raw: string, cleaned: string): boolean {
	return protectedTranscriptTerms(raw).every((term) => cleaned.includes(term));
}
