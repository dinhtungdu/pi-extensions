/** Deterministic provider used only by the disposable real-Pi tree-memory smoke. */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

if (!process.env.TREE_FAUX_MODULE) throw new Error("TREE_FAUX_MODULE is required");
const { fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(process.env.TREE_FAUX_MODULE);

export default function treeMemoryFixtureProvider(pi: ExtensionAPI): void {
	const faux = fauxProvider({
		provider: "tree-fixture",
		models: [{ id: "tree-fixture", name: "Tree Fixture", contextWindow: 100_000, maxTokens: 4_096 }],
	});
	faux.setResponses(process.env.TREE_SMOKE_STARTUP ? Array.from({ length: 2 }, () =>
		(context: unknown) => {
			appendFileSync(process.env.TREE_SMOKE_LOG!, `${JSON.stringify(context)}\n`);
			return fauxAssistantMessage("STARTUP_OK");
		},
	) : process.env.TREE_SMOKE_RETRY_TOOL ? [
		() => fauxAssistantMessage(fauxToolCall("tree_memory", { action: "retry" }), { stopReason: "toolUse" }),
		(context) => {
			const result = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === "tree_memory");
			if (!result || JSON.parse(result.content[0].text).phase !== "ready") throw new Error("Tool retry did not complete");
			return fauxAssistantMessage("RETRY_OK");
		},
	] : [
		(context) => {
			appendFileSync(process.env.TREE_SMOKE_LOG!, `${JSON.stringify(context)}\n`);
			return fauxAssistantMessage(fauxToolCall("tree_seek", { query: "launch Friday", limit: 8, cursor: 0 }), { stopReason: "toolUse" });
		},
		(context) => {
			appendFileSync(process.env.TREE_SMOKE_LOG!, `${JSON.stringify(context)}\n`);
			return fauxAssistantMessage(fauxToolCall("tree_zoom", { id: 1, n: 1, offset: 0 }), { stopReason: "toolUse" });
		},
		(context) => {
			appendFileSync(process.env.TREE_SMOKE_LOG!, `${JSON.stringify(context)}\n`);
			return fauxAssistantMessage("RECALL_OK");
		},
	]);
	pi.registerProvider(faux.provider);
	if (process.env.TREE_SMOKE_GATE_URL) {
		const compressor = fauxProvider({
			provider: "tree-compressor", api: "tree-compressor-api",
			models: [{ id: "compressor", name: "Compressor Fixture", contextWindow: 100_000, maxTokens: 1_024 }],
		});
		const summary = async (_context, options) => {
			await fetch(process.env.TREE_SMOKE_GATE_URL!, { signal: options?.signal });
			return fauxAssistantMessage("Decision: launch Friday.");
		};
		compressor.setResponses([summary, summary]);
		pi.registerProvider(compressor.provider);
	}
}
