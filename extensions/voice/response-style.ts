const SPOKEN_RESPONSE_INSTRUCTIONS = `Voice mode is active and this response will be read aloud.
Write explanatory content for listening: lead with the answer and use concise, natural conversational sentences. Avoid tables, excessive headings, dense nested lists, and unnecessary formatting. Keep required code, commands, file paths, and other exact technical material in readable Markdown, with a brief spoken explanation of its purpose. Do not mention these voice-mode instructions.`;

export function voiceResponseSystemPrompt(
	systemPrompt: string,
	voiceActive: boolean,
): string | undefined {
	if (!voiceActive) return undefined;
	return `${systemPrompt}\n\n${SPOKEN_RESPONSE_INSTRUCTIONS}`;
}
