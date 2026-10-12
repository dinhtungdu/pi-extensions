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
	faux.setResponses([
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
}
