import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { parseSkillBlock } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { Memory, PAGE } from './vendor/memory.ts';
import { atomicWrite, storeFor } from './vendor/store.ts';
import { createCompressor, type ModelChoice } from './vendor/compactor.ts';
import { createProfile, holdProfile, instructions, isWindows, listProfiles, loadConfig, profilePath, saveConfig, type ProfileConfig } from './vendor/profiles.ts';
import { allowSearch, CONTINUITY, IMPORT_GUIDANCE, SEARCH_DOC, TURN_REFRESHED, VIEW_DOC } from './vendor/prompts.ts';
import { cachePayload, record } from './vendor/cache.ts';
import { asUser, boundedMessage, buildContext, logMessage, previousExchange, refreshBudget, refreshFraction, refreshPoint, refreshedRun, RUN_BOUNDARY, textContent, typedText } from './vendor/transcript.ts';
import { loadImages, saveImages } from './vendor/images.ts';
import { Inbox } from './vendor/inbox.ts';
import { UsageLedger } from './vendor/usage.ts';
import { checkpoint } from './vendor/checkpoint.ts';
import { exportBrowser } from './vendor/browser.ts';
import { memoryDirectory, pendingImport, prepareImport, runImport, discardImport } from './vendor/import/job.ts';
import { chooseImport, showProgress } from './vendor/import/ui.ts';
import { showMenu, ACTIONS } from './ui/menu.ts';
import { showModelPicker, showSettings } from './ui/settings-page.ts';
import { showInspector } from './ui/inspector.ts';
import { searchTool } from './vendor/tools.ts';

const STATE = 'optchat.session';
const BINDING = 'optchat.profile';
const TOOLS = ['zoom', 'date', 'search'];
const MASTER = 'Use the following OptChat memory view to continue this conversation. Complete the user\'s tasks with the tools supplied by Pi.';
interface Active { name: string; dir: string; config: ProfileConfig; memory: Memory; inbox: Inbox; usage: UsageLedger; unlock: () => Promise<void> }

/** Profile storage and tree compression are upstream's; activation belongs to this Pi session. */
export default function optchat(pi: ExtensionAPI) {
  let active: Active | undefined;
  let name: string | undefined;
  let fault: string | undefined;
  let run: AgentMessage[] = [];
  let previous: AgentMessage[] = [];
  let logged = 0, keep = 0;
  let view: string | undefined;
  let prompt: string | undefined;
  let runStarted = false;
  let importing = false;
  let stopping = false;
  let importController: AbortController | undefined;
  let importTask: Promise<void> | undefined;
  let checkpoints = Promise.resolve();
  const receipts = new Map<AgentMessage, string>();
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  const required = () => { if (!active) throw new Error('OptChat is off. Use /optchat on.'); return active; };
  const status = (ctx: ExtensionContext) => ctx.ui.setStatus('optchat', active ? `OptChat: ${active.name} · ${active.memory.root.length} messages · ${active.memory.pending} pending${importing ? ' · importing' : pendingImport(active.dir) ? ' · import paused' : ''}` : 'OptChat: off');
  const syncTools = () => {
    const other = pi.getActiveTools().filter(tool => !TOOLS.includes(tool));
    pi.setActiveTools(active ? [...other, 'zoom', 'date', ...(active.config.memorySearch ? ['search'] : [])] : other);
  };
  const saveState = (enabled: boolean) => pi.appendEntry(STATE, { enabled, profile: name });
  const memoryPrompt = (config: ProfileConfig) => allowSearch(`${MASTER}\n\n${VIEW_DOC}${config.previousExchange ? CONTINUITY : ''}${config.memorySearch ? SEARCH_DOC : ''}`, config.memorySearch);
  const collectUsage = (ctx: ExtensionContext, a: Active) => {
    let enabled = false;
    const entries = ctx.sessionManager.getEntries().filter(entry => {
      if (entry.type === 'custom' && entry.customType === RUN_BOUNDARY && record(entry.data)) enabled = entry.data.state === 'start';
      return enabled;
    });
    a.usage.backfill(entries, ctx.sessionManager.getSessionId());
  };
  const flush = () => {
    if (!active) return;
    while (logged < run.length) {
      const message = run[logged], receipt = receipts.get(message);
      logMessage(active.memory, message, receipt); logged++;
      if (receipt) active.inbox.acknowledge(receipt);
      receipts.delete(message);
    }
  };
  const close = async (ctx: ExtensionContext) => {
    stopping = true; importController?.abort(); await importTask?.catch(() => {});
    if (!active) return;
    const old = active;
    try {
      await checkpoints; flush(); old.inbox.dropReturned(); await old.memory.close();
      try { await checkpoint(old.dir); } catch (error) { ctx.ui.notify(`Local checkpoint failed: ${errorText(error)}`, 'error'); }
    }
    finally { await old.memory.close(); await old.unlock(); active = undefined; runStarted = false; prompt = undefined; run = []; previous = []; logged = 0; keep = 0; view = undefined; receipts.clear(); }
  };
  const open = async (selected: string, ctx: ExtensionContext) => {
    const dir = profilePath(selected);
    const reports: unknown = existsSync(join(dir, 'pending-reports.json')) ? JSON.parse(readFileSync(join(dir, 'pending-reports.json'), 'utf8')) : [];
    if (!Array.isArray(reports) || reports.length) throw new Error('This profile has pending subagent reports. Finish them with upstream OptChat first.');
    const config = loadConfig(dir), usage = new UsageLedger(dir), session = ctx.sessionManager.getSessionId();
    const unlock = await holdProfile(storeFor(dir), dir, selected, `Pi session ${session} · PID ${process.pid}`, text => ctx.ui.notify(text, 'warning'));
    let memory: Memory | undefined;
    try {
      memory = await Memory.open(memoryDirectory(dir), createCompressor(ctx.modelRegistry, () => config.compactor, message => usage.compression(message, 'compactor', session), () => config.summaryAcceptBytes), text => ctx.ui.notify(text, 'error'));
      const inbox = new Inbox(dir);
      if (!pendingImport(dir)) inbox.recover(memory);
      active = { name: selected, dir, config, memory, inbox, usage, unlock }; name = selected; fault = undefined;
      collectUsage(ctx, active);
      stopping = false;
      syncTools(); status(ctx);
      ctx.ui.notify(`OptChat on · ${selected} · ${memory.root.length} messages\nCompactor: ${config.compactor.provider}/${config.compactor.model}`, 'info');
    } catch (error) { await memory?.close(); await unlock(); throw error; }
  };
  pi.registerFlag('optchat-profile', { description: 'Explicitly enable an existing OptChat profile', type: 'string' });
  pi.on('session_start', async (_event, ctx) => {
    await close(ctx); name = undefined; fault = undefined;
    const entries = ctx.sessionManager.getBranch();
    const saved = entries.findLast(entry => entry.type === 'custom' && entry.customType === STATE);
    const state = saved?.type === 'custom' && record(saved.data) ? saved.data : undefined;
    const binding = entries.findLast(entry => entry.type === 'custom' && entry.customType === BINDING);
    const legacy = binding?.type === 'custom' && record(binding.data) && typeof binding.data.name === 'string' ? binding.data.name : undefined;
    const flag = pi.getFlag('optchat-profile');
    name = typeof state?.profile === 'string' ? state.profile : legacy;
    try {
      if (typeof flag === 'string' && name && flag !== name) throw new Error(`Session belongs to ${name}; cannot resume it as ${flag}.`);
      const selected = typeof flag === 'string' ? flag : name;
      const enabled = typeof flag === 'string' || (state ? state.enabled === true : ctx.mode !== 'tui' && !!legacy);
      if (enabled && selected) await open(selected, ctx);
    } catch (error) {
      fault = errorText(error); ctx.ui.notify(fault, 'error');
      if (ctx.mode === 'print' || ctx.mode === 'json') { process.exitCode = 1; process.stderr.write(`OptChat: ${fault}\n`); }
    }
    syncTools(); status(ctx);
  });
  pi.on('session_shutdown', (_event, ctx) => close(ctx));
  pi.on('input', (event, ctx) => {
    if (fault) { ctx.ui.notify(`${fault} Use /optchat off to use ordinary Pi.`, 'error'); return { action: 'handled' }; }
    if (!active) return { action: 'continue' };
    if (importing || pendingImport(active.dir)) { ctx.ui.notify('Import in progress or paused. Use /optchat import to resume/discard, or /optchat off.', 'info'); return { action: 'handled' }; }
    if (event.source !== 'extension') {
      try { active.inbox.record(event.text, event.streamingBehavior !== undefined); }
      catch (error) { ctx.ui.notify(errorText(error), 'error'); return { action: 'handled' }; }
    }
    return { action: 'continue' };
  });
  const startRun = (ctx: ExtensionContext) => {
    flush(); run = []; logged = 0; keep = 0; view = undefined; runStarted = true;
    const config = required().config;
    previous = config.previousExchange ? previousExchange(ctx.sessionManager.getBranch(), config.previousExchangeKB * 1000) : [];
    pi.appendEntry(RUN_BOUNDARY, { state: 'start' });
  };
  pi.on('agent_start', (_event, ctx) => { if (active && !runStarted) startRun(ctx); });
  pi.on('before_agent_start', (event, ctx) => {
    if (!active) return;
    startRun(ctx);
    const { config, dir } = active;
    event.systemPromptOptions.customPrompt = memoryPrompt(config);
    event.systemPromptOptions.sections.instructions = `${instructions(dir)}\n\n${IMPORT_GUIDANCE}`;
    prompt = event.systemPrompt;
  });
  pi.on('message_end', async (event, ctx) => {
    if (!active || !runStarted) return;
    try {
      const message = asUser(boundedMessage(event.message));
      if (message.role === 'user' || message.role === 'toolResult' && message.toolName !== 'zoom') {
        await saveImages(active.memory.store, message.content);
      }
      if (message.role === 'user') {
        const typed = typedText(message.content), skill = parseSkillBlock(typed.bare);
        const receipt = active.inbox.claim(typed.text) ?? active.inbox.claim(typed.bare)
          ?? (skill ? active.inbox.claimSkill(skill.name, skill.userMessage) : undefined)
          ?? active.inbox.record(textContent(message.content));
        receipts.set(message, receipt);
      }
      run.push(message);
      if (view !== undefined) flush();
    } catch (error) { fault = errorText(error); ctx.abort(); ctx.ui.notify(`Could not save OptChat message: ${fault}`, 'error'); }
  });
  pi.on('context_with_system', async (event, ctx) => {
    if (!active) return;
    try {
      if (fault) throw new Error(fault);
      if (importing || pendingImport(active.dir)) throw new Error('Profile is unavailable while importing.');
      const { memory, config } = active;
      const settle = async () => {
        ctx.ui.setWorkingMessage('Waiting for OptChat summaries…');
        try {
          await memory.settle(ctx.signal);
          if (!memory.ready) throw new Error(memory.lastError ?? 'OptChat summaries are incomplete.');
        } finally { ctx.ui.setWorkingMessage(); }
      };
      if (view === undefined) { await settle(); view = memory.render(); flush(); }
      const refresh = refreshPoint(run, keep, refreshBudget(ctx.model?.contextWindow, refreshFraction(config.refreshAt)));
      if (refresh) { flush(); await settle(); view = memory.render(); keep = refresh.cut; }
      const current = ctx.getSystemPrompt();
      if (current.startsWith(MASTER)) prompt = current;
      // Idle extension turns skip before_agent_start, including the first turn after enabling.
      prompt ??= `${memoryPrompt(config)}\n\n${current}\n\n${instructions(active.dir)}\n\n${IMPORT_GUIDANCE}`;
      return { messages: buildContext(event.messages, refreshedRun(run, keep, TURN_REFRESHED), view, prompt, previous) };
    } catch (error) {
      ctx.abort();
      try { flush(); } catch (persistenceError) { fault = errorText(persistenceError); }
      ctx.ui.notify(errorText(error), 'error');
      return { messages: [{ role: 'system', content: 'OptChat context unavailable. Stop.', timestamp: 0 }] };
    }
  });
  pi.on('before_provider_request', (event, ctx) => active && ctx.model?.api === 'anthropic-messages' ? cachePayload(event.payload) : event.payload);
  pi.on('cache_warming_decision', () => active ? { action: 'stop' } : undefined);
  pi.on('session_before_compact', (_event, ctx) => {
    if (!active) return;
    ctx.ui.notify('OptChat manages history between turns. Use /optchat off to restore Pi compaction.', 'info');
    return { cancel: true };
  });
  pi.on('agent_settled', async (_event, ctx) => {
    if (!active || !runStarted) return;
    try { flush(); active.inbox.dropReturned(); collectUsage(ctx, active); }
    catch (error) { fault = errorText(error); ctx.ui.notify(fault, 'error'); }
    pi.appendEntry(RUN_BOUNDARY, { state: 'end' }); runStarted = false; status(ctx);
    const dir = active.dir;
    checkpoints = checkpoints.then(() => checkpoint(dir)).catch(error => ctx.ui.notify(`Local checkpoint failed: ${errorText(error)}`, 'error'));
    await checkpoints;
  });
  pi.registerTool({ name: 'zoom', label: 'Zoom memory', defaultActive: false,
    description: 'Open memory line id+n into its two child summaries; n=1 retrieves the original message. offset/limit page long messages in characters.',
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Optional(Type.Integer({ minimum: 1 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: PAGE })) }),
    async execute(_id, { id, n = 1, offset, limit }) {
      const memory = required().memory, text = memory.zoom(id, n, offset, limit);
      return { content: [{ type: 'text', text }, ...n === 1 ? await loadImages(memory.store, text) : []], details: {} };
    } });
  pi.registerTool({ name: 'date', label: 'Memory date', defaultActive: false, description: 'The date and time of memory message id.',
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
    async execute(_id, { id }) { return { content: [{ type: 'text', text: required().memory.date(id) }], details: {} }; } });
  pi.registerTool({ ...searchTool(() => required().memory), defaultActive: false });
  const settingsOptions = (ctx: ExtensionContext, a: Active) => ({ profile: a.name, config: a.config,
    models: ctx.modelRegistry.getAvailable().map(model => ({ name: `${model.provider}/${model.id}`, thinking: getSupportedThinkingLevels(model) })).sort((a, b) => a.name.localeCompare(b.name)),
    save: (config: ProfileConfig) => { saveConfig(a.dir, config); Object.assign(a.config, config); syncTools(); fault = undefined; prompt = undefined; } });
  pi.registerCommand('optchat', { description: 'Optional memory, profiles, imports, settings, models, instructions, browser and usage',
    getArgumentCompletions: prefix => [...ACTIONS, 'status'].filter(action => action.startsWith(prefix)).map(value => ({ value, label: value })),
    async handler(args, ctx) {
      try {
        let [action = '', ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (!action) {
          if (ctx.mode !== 'tui') action = 'status';
          else { const a = active; action = await showMenu(ctx, 'OptChat', a && { profile: a.name, messages: a.memory.root.length, pending: a.memory.pending, compactor: a.config.compactor, error: a.memory.lastError }) ?? ''; if (!action) return; }
        }
        if (action === 'status') { ctx.ui.notify(active ? `OptChat on · ${active.name} · ${active.memory.root.length} messages\nCompactor: ${active.config.compactor.provider}/${active.config.compactor.model}` : `OptChat off${name ? ` · saved profile ${name}` : ''}`, 'info'); return; }
        if (!ctx.isIdle()) throw new Error('Finish or stop the current turn before changing OptChat.');
        if (importing) throw new Error('Close or pause the import dialog before changing OptChat.');
        if (action === 'off') { await close(ctx); fault = undefined; syncTools(); saveState(false); status(ctx); ctx.ui.notify('OptChat off. Ordinary Pi context and compaction restored.', 'info'); return; }
        if (action === 'settings' || action === 'model' && !rest.length) {
          if (ctx.mode !== 'tui') throw new Error(`The ${action} picker requires interactive Pi. Use /optchat model provider/model or edit config.json in the profile directory.`);
          const a = required(), options = settingsOptions(ctx, a);
          if (action === 'settings') await showSettings(ctx, options); else await showModelPicker(ctx, 'compactor', options);
          return;
        }
        if (action === 'instructions') {
          const a = required(), edited = await ctx.ui.editor(`${a.name} · AGENTS.md`, instructions(a.dir));
          if (edited !== undefined) { atomicWrite(join(a.dir, 'AGENTS.md'), edited); prompt = undefined; ctx.ui.notify('Saved. Applies to the next turn.', 'info'); }
          return;
        }
        if (action === 'browse') {
          const a = required(), file = exportBrowser(a.memory, a.name, a.dir);
          if (ctx.hasUI) execFile(isWindows ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open', [file], error => { if (error && (!isWindows || error.code === 'ENOENT')) ctx.ui.notify(`Open ${file}`, 'info'); });
          ctx.ui.notify(file, 'info'); return;
        }
        if (action === 'usage' || action === 'activity') {
          const a = required();
          if (ctx.mode !== 'tui') throw new Error(`Use interactive Pi to open the ${action} panel.`);
          await showInspector(ctx, { profile: a.name, session: ctx.sessionManager.getSessionId(), memory: a.memory, usage: a.usage, page: action,
            refreshUsage: () => collectUsage(ctx, a) });
          return;
        }
        if (action === 'import') {
          const a = required();
          if (!ctx.hasUI) throw new Error('/optchat import requires interactive Pi.');
          importing = true; importController = new AbortController(); const signal = importController.signal; let closed = false; status(ctx);
          const work = (async () => {
            let job = pendingImport(a.dir);
            if (job) {
              const selected = await ctx.ui.select(`Paused ${job.mode} import · ${job.added} new messages`, ['Resume import', 'Discard staged import', 'Cancel'], { signal });
              if (selected === 'Discard staged import') { if (await ctx.ui.confirm('Discard import?', 'Original memory stays unchanged. Staged summaries will be removed.', { signal })) { signal.throwIfAborted(); discardImport(a.dir); } return; }
              if (selected !== 'Resume import') return;
            } else {
              const plan = await chooseImport(ctx, a.name, a.memory, `${a.config.compactor.provider}/${a.config.compactor.model} (${a.config.compactor.thinking})`, signal);
              if (!plan) return;
              signal.throwIfAborted(); flush(); a.inbox.recover(a.memory); await checkpoints; await a.memory.close(); closed = true; signal.throwIfAborted();
              job = prepareImport(a.dir, a.memory, plan.entries, plan.mode); if (!job) return;
            }
            if (!closed) { await a.memory.close(); closed = true; }
            const compress = createCompressor(ctx.modelRegistry, () => a.config.compactor, message => a.usage.compression(message, 'import', ctx.sessionManager.getSessionId()), () => a.config.summaryAcceptBytes);
            const completed = await showProgress(ctx, job, (signal, progress) => runImport(a.dir, compress, signal, a.config.importJobs, progress), signal);
            ctx.ui.notify(completed ? `Imported ${job.added} messages into ${a.name}. Previous memory retained at ${job.previous === '.' ? a.dir : join(a.dir, job.previous)}.` : 'Import paused. Use /optchat import to resume.', 'info');
          })();
          importTask = work.finally(async () => {
            importing = false; importController = undefined; ctx.ui.setWidget('optchat-import', undefined);
            if (closed && !stopping) {
              a.memory = await Memory.open(memoryDirectory(a.dir), createCompressor(ctx.modelRegistry, () => a.config.compactor, message => a.usage.compression(message, 'compactor', ctx.sessionManager.getSessionId()), () => a.config.summaryAcceptBytes), text => ctx.ui.notify(text, 'error'));
              run = []; previous = []; logged = 0; keep = 0; view = undefined; receipts.clear(); fault = undefined;
              await checkpoint(a.dir);
            }
            status(ctx);
          });
          try { await importTask; } finally { importTask = undefined; }
          return;
        }
        if (action === 'model') {
          const a = required(), selected = rest.join(''), slash = selected.indexOf('/');
          const model = slash > 0 ? ctx.modelRegistry.find(selected.slice(0, slash), selected.slice(slash + 1)) : undefined;
          if (!model) throw new Error('Use /optchat model provider/model with an available model.');
          a.config.compactor = { provider: model.provider, model: model.id, thinking: 'minimal' }; saveConfig(a.dir, a.config); fault = undefined;
          ctx.ui.notify(`Compactor: ${selected}. Applies to new summaries.`, 'info'); return;
        }
        if (action !== 'on' && action !== 'profile') throw new Error(`Use /optchat ${[...ACTIONS, 'status'].join(', ')}.`);
        let selected = rest.join('') || (action === 'on' ? name : undefined);
        if (!selected && ctx.mode === 'tui') {
          selected = await ctx.ui.select('OptChat profile (Escape leaves memory off)', [...listProfiles(), '+ Create profile']);
          if (selected === '+ Create profile') selected = (await ctx.ui.input('New profile name', 'alfred or work'))?.trim();
          if (!selected) return;
        }
        selected ??= `session-${createHash('sha256').update(ctx.sessionManager.getSessionId()).digest('hex').slice(0, 24)}`;
        if (name && selected !== name) throw new Error(`This session belongs to ${name}. Open a new Pi session to use ${selected}.`);
        if (active) { status(ctx); return; }
        const dir = profilePath(selected);
        if (!existsSync(dir)) {
          const cheap = ctx.modelRegistry.find('openai-codex', 'gpt-6-luna') ?? ctx.model;
          if (!cheap) throw new Error('Select a Pi model before enabling memory.');
          createProfile(selected);
          const config = loadConfig(dir);
          config.compactor = { provider: cheap.provider, model: cheap.id, thinking: 'minimal' } satisfies ModelChoice;
          saveConfig(dir, config);
        }
        await open(selected, ctx); pi.appendEntry(BINDING, { name: selected }); saveState(true);
      } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
    } });
}
