import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getCurrentSystemMessage, getSystemMessageText } from '@earendil-works/pi-ai';

const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(process.env.OPTCHAT_FAUX_MODULE!);
export default function fixture(pi: ExtensionAPI) {
  const provider = fauxProvider({ provider: 'optchat-fixture', models: [{ id: 'fixture', name: 'Offline OptChat fixture', contextWindow: 100_000, maxTokens: 1024 }] });
  const reply = (context: any) => {
    const content = context.messages.flatMap((message: any) => typeof message.content === 'string' ? [message.content] : message.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text) ?? []);
    const view = content.find((text: string) => text.startsWith('<chat>'));
    const system = context.messages.filter((message: any) => message.role === 'system');
    const currentSystem = getCurrentSystemMessage(context.messages);
    assert.ok(currentSystem, 'Pi system-prompt fixture did not observe a system message');
    const systemPrompt = getSystemMessageText(currentSystem);
    const loadout = new Set<string>();
    for (const message of system) {
      for (const tool of message.toolsAdded ?? []) loadout.add(tool.name);
      for (const tool of message.toolsRemoved ?? []) loadout.delete(tool.name ?? tool);
    }
    const tools = [...loadout];
    assert.ok(tools.includes('read'), 'Pi tool-loadout fixture did not observe native tools');
    assert.ok(!tools.includes('spawn') && !tools.includes('tell'), 'subagent tools leaked into the fork');
    appendFileSync(process.env.OPTCHAT_TEST_LOG!, JSON.stringify({ view, hash: view && createHash('sha256').update(view).digest('hex'), tools, systemPrompt, text: content.join('\n') }) + '\n');
    if (view) {
      assert.ok(tools.includes('zoom') && tools.includes('date'), 'active memory tools missing');
      assert.ok(!view.includes('(not summarized yet: zoom it)'), 'inference used unfinished summaries');
      assert.ok(!systemPrompt.includes('start a subagent'), 'subagent instructions leaked');
      assert.ok(systemPrompt.includes('OptChat memory view'), 'active turn omitted OptChat instructions');
      assert.ok((!process.env.OPTCHAT_EXPECT_INSTRUCTIONS || systemPrompt.includes(process.env.OPTCHAT_EXPECT_INSTRUCTIONS)), 'active turn omitted profile instructions');
      const current = context.messages.filter((message: any) => message.role !== 'system').at(-1);
      if (current?.role === 'user' && content.at(-1)?.includes('REFRESH_FIXTURE')) return fauxAssistantMessage(fauxToolCall('fixture_chunk', { large: true }), { stopReason: 'toolUse' });
      if (current?.role === 'toolResult' && current.toolName === 'fixture_chunk') {
        if (current.content[0].text.length > 1000) return fauxAssistantMessage(fauxToolCall('fixture_chunk', { large: false }), { stopReason: 'toolUse' });
        assert.ok(content.some((text: string) => text.includes("this turn grew long")), 'long turn did not refresh');
        return fauxAssistantMessage('REFRESH_OK');
      }
      const task = content.findLast((text: string) => text.includes('RECALL_FIXTURE'));
      if (task) {
        const last = context.messages.at(-1);
        if (last.role !== 'toolResult') return fauxAssistantMessage(fauxToolCall('zoom', { id: 0, n: 1 }), { stopReason: 'toolUse' });
        assert.ok(!last.isError, 'native memory retrieval failed');
        if (last.toolName === 'zoom') return fauxAssistantMessage(fauxToolCall('date', { id: 0 }), { stopReason: 'toolUse' });
        return fauxAssistantMessage('RECALL_OK');
      }
      return fauxAssistantMessage('MEMORY_OK');
    }
    assert.ok(!tools.includes('zoom') && !tools.includes('date') && !tools.includes('search'), 'off state exposed memory tools');
    assert.ok(!systemPrompt.includes('OptChat memory view'), 'off state retained memory instructions');
    return fauxAssistantMessage('PLAIN_OK');
  };
  provider.setResponses(Array.from({ length: 128 }, () => reply));
  pi.registerProvider(provider.provider);
  pi.registerCommand('fixture-kick', { description: 'Offline idle continuation', handler: async () => {
    pi.sendMessage({ customType: 'fixture-kick', content: 'Continue the current task.', display: true }, { triggerTurn: true });
  } });
  pi.registerTool({ name: 'fixture_chunk', label: 'Fixture chunk', description: 'Offline long-turn fixture',
    parameters: { type: 'object', properties: { large: { type: 'boolean' } }, required: ['large'] } as any,
    execute: async (_id, args: any) => ({ content: [{ type: 'text' as const, text: args.large ? 'REFRESH_HISTORY '.repeat(1000) : 'small step' }], details: {} }) });
  const compressor = fauxProvider({ provider: 'optchat-compressor', api: 'optchat-compression', models: [{ id: 'fixture', name: 'Offline compression', contextWindow: 100_000, maxTokens: 1024 }] });
  compressor.setResponses(Array.from({ length: 512 }, () => async () => {
    appendFileSync(process.env.OPTCHAT_TEST_LOG!, JSON.stringify({ compression: 'start' }) + '\n');
    while (process.env.OPTCHAT_COMPRESS_GATE && !existsSync(process.env.OPTCHAT_COMPRESS_GATE)) await new Promise(resolve => setTimeout(resolve, 25));
    if (process.env.OPTCHAT_COMPRESS_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.OPTCHAT_COMPRESS_DELAY)));
    const fail = process.env.OPTCHAT_COMPRESS_FAIL;
    if (fail && existsSync(fail)) {
      const left = Number(readFileSync(fail, 'utf8'));
      if (left > 0) { writeFileSync(fail, String(left - 1)); throw new Error('FIXTURE_TRANSIENT_COMPRESSOR_FAILURE'); }
    }
    appendFileSync(process.env.OPTCHAT_TEST_LOG!, JSON.stringify({ compression: 'end' }) + '\n');
    return fauxAssistantMessage('fixture: remembered ORBIT marker and exact historical record');
  }));
  pi.registerProvider(compressor.provider);
}
