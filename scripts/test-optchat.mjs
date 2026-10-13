import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const entry = join(root, 'packages/optchat/src/index.ts');
const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim();
const runtime = join(prefix, 'lib/node_modules/@earendil-works/pi-coding-agent');
const { RpcClient } = await import(pathToFileURL(join(runtime, 'dist/index.js')));
const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(runtime, 'dist/core/extensions/loader.js')));
const { initTheme, getThemeByName } = await import(pathToFileURL(join(runtime, 'dist/modes/interactive/theme/theme.js')));
const { fauxAssistantMessage } = await import(pathToFileURL(join(runtime, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js')));
initTheme('dark', false);
const theme = getThemeByName('dark');
const temp = await mkdtemp(join(tmpdir(), 'optchat-session-'));
const home = join(temp, 'home');
const log = join(temp, 'requests.jsonl');
const results = [];
const clients = new Set();
const config = { compactor: { provider: 'optchat-compressor', model: 'fixture', thinking: 'minimal' }, subagent: { provider: 'unused', model: 'unused', thinking: 'off' } };
const profile = async name => {
  const dir = join(home, 'profiles', name); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify(config)); await writeFile(join(dir, 'AGENTS.md'), 'PROFILE_INSTRUCTION_FIXTURE Follow the current user instructions.');
  return dir;
};
const snapshots = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const records = async dir => {
  const { readdir } = await import('node:fs/promises');
  if (!existsSync(join(dir, 'main'))) return [];
  return (await Promise.all((await readdir(join(dir, 'main'))).filter(file => file.endsWith('.jsonl')).map(async file => (await readFile(join(dir, 'main', file), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)))).flat();
};
const start = async (session, options = {}) => {
  const client = new RpcClient({ cliPath: await realpath(join(prefix, 'bin/pi')), cwd: root,
    args: [...options.installed ? [] : ['-ne'], '-ns', '-np', '--no-themes', '--no-mcp', '-nc', '-e', join(root, 'scripts/fixtures/optchat-provider.ts'), ...options.vcc ? ['-e', '/Users/tung/.pi/agent/npm/node_modules/@sting8k/pi-vcc/index.ts'] : [], ...options.installed ? [] : ['-e', entry], '--session', session, '--model', 'optchat-fixture/fixture', ...options.flags ?? [], ...options.extra ? ['-e', options.extra] : []],
    env: { PI_OFFLINE: '1', PI_CODING_AGENT_DIR: join(temp, 'agent'), OPTCHAT_HOME: home, PI_VCC_CONFIG_PATH: join(temp, 'vcc.json'), OPTCHAT_TEST_LOG: log, OPTCHAT_COMPRESS_DELAY: '400', OPTCHAT_EXPECT_INSTRUCTIONS: options.skipInstructions ? '' : 'PROFILE_INSTRUCTION_FIXTURE', ...options.env, ...options.gate ? { OPTCHAT_COMPRESS_GATE: options.gate } : {}, OPTCHAT_FAUX_MODULE: pathToFileURL(join(runtime, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js')).href } });
  const events = []; client.onEvent(event => events.push(event)); client.events = events;
  await client.start(); clients.add(client); await client.getState(); return client;
};
const stop = async client => { await client.stop(); clients.delete(client); };
const until = async predicate => {
  const deadline = Date.now() + 20_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'Timed out waiting for fixture'); await new Promise(resolve => setTimeout(resolve, 25)); }
};
const boundaries = async session => (await readFile(session, 'utf8')).trim().split('\n').map(JSON.parse).filter(entry => entry.customType === 'optchat.run').map(entry => entry.data.state);
const chat = async (client, text, expected, accepted = () => {}) => {
  let resolveEnd; const settled = new Promise(resolve => { resolveEnd = resolve; });
  const unsub = client.onEvent(event => { if (event.type === 'agent_settled') resolveEnd(); });
  let timer;
  try {
    const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${text.slice(0, 30)}\n${client.getStderr()}`)), 15_000); });
    assert.equal(await Promise.race([client.prompt(text), deadline]), 'started');
    await accepted();
    await Promise.race([settled, deadline]);
    assert.equal(await client.getLastAssistantText(), expected);
    assert.deepEqual(client.events.filter(event => event.type === 'extension_error'), []);
  } finally { clearTimeout(timer); unsub(); }
};
const report = (test, extra = {}) => { const result = { test, result: 'PASS', ...extra }; results.push(result); console.log(JSON.stringify(result)); };
try {
  await mkdir(join(temp, 'agent'));
  await writeFile(join(temp, 'agent/settings.json'), JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 128, reserveTokens: 256 } }));
  await profile('fixture');
  // Use actual SDK-loaded handlers with TUI context; no terminal/model/network is needed to reproduce the gate.
  process.env.OPTCHAT_HOME = home;
  const tui = async path => {
    const rt = createExtensionRuntime(); let tools = ['read', 'bash']; const entries = [], notices = []; let choice;
    Object.assign(rt, { getActiveTools: () => tools, setActiveTools: names => { tools = names; }, appendEntry: (customType, data) => entries.push({ type: 'custom', id: `${entries.length}`, customType, data }) });
    const loaded = await loadExtensions([path], root, undefined, rt); assert.deepEqual(loaded.errors, []);
    const ext = loaded.extensions[0];
    const model = { provider: 'optchat-compressor', id: 'fixture', api: 'faux', reasoning: false, contextWindow: 100_000, maxTokens: 1024, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const ctx = { mode: 'tui', hasUI: true, cwd: root, isIdle: () => true, abort: () => notices.push('ABORTED'), sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => 'tui-fixture' }, ui: { select: async (...args) => typeof choice === 'function' ? choice(...args) : choice, input: async () => undefined, notify: text => notices.push(text), setStatus() {}, setTitle() {}, setWidget() {} }, modelRegistry: { find: () => model, getAvailable: () => [model], streamSimple: () => ({ async *[Symbol.asyncIterator]() { yield { type: 'text_delta' }; }, result: async () => fauxAssistantMessage('fixture: historical record and its outcome') }) } };
    const emit = async type => { let result; for (const handler of ext.handlers.get(type) ?? []) result = await handler(type === 'input' ? { text: 'Hello', source: 'interactive' } : { type }, ctx); return result; };
    return { ext, ctx, emit, notices, entries, tools: () => tools, choose: value => { choice = value; } };
  };
  const upstream = process.env.OPTCHAT_UPSTREAM_ENTRY ?? '/Users/tung/.pi/agent/npm/node_modules/pi-optchat/src/index.ts';
  if (existsSync(upstream)) {
    const old = await tui(upstream); await old.emit('session_start');
    assert.equal((await old.emit('input')).action, 'handled');
    assert.ok(old.notices.some(text => text.includes('Select a profile'))); await old.emit('session_shutdown');
    report('reproduced upstream TUI profile gate');
  }
  const ui = await tui(entry); await ui.emit('session_start');
  assert.equal((await ui.emit('input')).action, 'continue'); assert.deepEqual(ui.tools(), ['read', 'bash']);
  assert.deepEqual([...ui.ext.tools.keys()], ['zoom', 'date', 'search']);
  ui.choose(undefined); await ui.ext.commands.get('optchat').handler('on', ui.ctx);
  assert.equal((await ui.emit('input')).action, 'continue');
  ui.choose('fixture'); await ui.ext.commands.get('optchat').handler('profile', ui.ctx);
  assert.ok(ui.tools().includes('zoom')); await ui.ext.commands.get('optchat').handler('off', ui.ctx);
  assert.equal((await ui.emit('input')).action, 'continue'); assert.deepEqual(ui.tools(), ['read', 'bash']);
  await ui.ext.commands.get('optchat').handler('on fixture', ui.ctx);
  await ui.emit('agent_start');
  const inboxFile = join(home, 'profiles/fixture/pending-inputs.json');
  await rm(inboxFile, { force: true }); await mkdir(inboxFile);
  for (const handler of ui.ext.handlers.get('message_end')) await handler({ message: { role: 'user', content: 'Injected user message', timestamp: Date.now() } }, ui.ctx);
  assert.ok(ui.notices.includes('ABORTED')); assert.equal((await ui.emit('input')).action, 'handled');
  await rm(inboxFile, { recursive: true }); await ui.ext.commands.get('optchat').handler('off', ui.ctx);
  await ui.emit('session_shutdown'); delete process.env.OPTCHAT_HOME;
  report('TUI off by default, optional picker/cancel, profile on/off, persistence errors stop inference, no subagent tools');

  process.env.OPTCHAT_HOME = home;
  await profile('goodies'); const goodies = await tui(entry); await goodies.emit('session_start');
  const command = args => goodies.ext.commands.get('optchat').handler(args, goodies.ctx);
  await command('on goodies');
  const views = [];
  let drive = [];
  goodies.ctx.getContextUsage = () => ({ tokens: 1234 });
  goodies.ctx.ui.custom = async factory => {
    let closed = false;
    const component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, () => { closed = true; });
    for (const key of drive) component.handleInput(key);
    const lines = component.render(90); views.push(lines);
    component.handleInput('\x1b'); component.dispose?.();
    assert.ok(closed, 'panel did not close on Escape');
  };
  await command('');
  const menu = views.at(-1).join('\n');
  for (const feature of ['settings', 'model', 'usage', 'activity', 'instructions', 'browse', 'import', 'on', 'off']) assert.ok(menu.includes(feature));
  assert.ok(!/subagents|handoff|connected|spawn/i.test(menu));
  drive = ['\x1b[B', '\x1b[B', '\x1b[B', ' ']; await command('settings'); drive = [];
  assert.ok(goodies.tools().includes('search'), 'settings toggle did not activate memory search');
  const settingsView = views.at(-1).join('\n');
  assert.ok(!/subagents?|Max active agents|Group subagent reports/i.test(settingsView));
  assert.equal(JSON.parse(await readFile(join(home, 'profiles/goodies/config.json'))).memorySearch, true);
  drive = ['\r', '\r']; await command('model'); drive = [];
  assert.equal(JSON.parse(await readFile(join(home, 'profiles/goodies/config.json'))).compactor.thinking, 'off');
  goodies.ctx.ui.editor = async () => 'PROFILE_INSTRUCTION_FIXTURE'; await command('instructions');
  assert.equal(await readFile(join(home, 'profiles/goodies/AGENTS.md'), 'utf8'), 'PROFILE_INSTRUCTION_FIXTURE');
  await goodies.emit('agent_start');
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
  const savedMessage = { role: 'user', content: [{ type: 'text', text: 'prefix '.repeat(80) + 'LATE_SEARCH_NEEDLE' }, image], timestamp: Date.now() };
  for (const handler of goodies.ext.handlers.get('message_end')) await handler({ message: savedMessage }, goodies.ctx);
  const usageMessage = { ...fauxAssistantMessage('Stored fixture image'), usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 0, totalTokens: 420, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } } };
  goodies.entries.push({ type: 'message', id: 'usage-fixture', timestamp: new Date().toISOString(), message: usageMessage });
  for (const handler of goodies.ext.handlers.get('message_end')) await handler({ message: usageMessage }, goodies.ctx);
  await goodies.emit('agent_settled');
  const imageZoom = await goodies.ext.tools.get('zoom').definition.execute('image', { id: 0, n: 1 });
  assert.ok(imageZoom.content[0].text.includes('[image ')); assert.deepEqual(imageZoom.content.find(part => part.type === 'image'), image);
  const search = goodies.ext.tools.get('search').definition;
  const match = (await search.execute('search', { text: 'LATE_SEARCH_NEEDLE' })).content[0].text;
  assert.ok(match.includes('LATE_SEARCH_NEEDLE')); assert.ok(!match.includes('Older matches:'));
  assert.ok((await search.execute('older', { text: 'LATE_SEARCH_NEEDLE', before: 0 })).content[0].text.startsWith('No older'));
  await command('usage'); assert.ok(views.at(-1).join('\n').includes('420'));
  await command('activity'); assert.ok(views.at(-1).join('\n').includes('messages'));
  const exported = join(temp, 'conversations.json');
  const history = [{ id: 'import-fixture', title: 'Import fixture', create_time: 1700000000, update_time: 1700000001, current_node: 'b', mapping: {
    a: { parent: null, message: { id: 'import-user', author: { role: 'user' }, create_time: 1700000000, content: { content_type: 'text', parts: ['HISTORICAL_FIXTURE request'] } } },
    b: { parent: 'a', message: { id: 'import-answer', author: { role: 'assistant' }, create_time: 1700000001, channel: 'final', end_turn: true, content: { content_type: 'text', parts: ['HISTORICAL_FIXTURE answer'] } } },
  } }];
  await writeFile(exported, JSON.stringify(history)); goodies.ctx.ui.input = async () => exported;
  let paused = false, discard = false, rebuilding = false, confirms = 0;
  goodies.ctx.ui.confirm = async () => { confirms++; return true; };
  goodies.choose(async (title, options, controls) => {
    if (title.endsWith('· source')) return 'ChatGPT export';
    if (title === 'Conversation dates') return 'All history';
    if (options.some(option => option.startsWith('All matching'))) return options.find(option => option.startsWith('All matching'));
    if (title.startsWith('How should')) return rebuilding ? options.find(option => option.startsWith('Rebuild')) : options[0];
    if (title.startsWith('Paused')) return discard ? 'Discard staged import' : 'Resume import';
    if (title === 'Import in progress') {
      if (paused) return 'Pause import';
      return new Promise(resolve => { if (controls.signal.aborted) resolve(undefined); else controls.signal.addEventListener('abort', () => resolve(undefined), { once: true }); });
    }
    throw new Error(`Unexpected import dialog: ${title}`);
  });
  await command('import');
  const dir = join(home, 'profiles/goodies');
  assert.ok(confirms > 0); assert.ok(existsSync(join(dir, 'active-memory.json')));
  const generation = JSON.parse(await readFile(join(dir, 'active-memory.json'), 'utf8'));
  const imported = await records(join(dir, generation)); assert.ok(imported.some(entry => entry.text.includes('HISTORICAL_FIXTURE')));
  assert.ok(existsSync(join(dir, 'main')), 'previous memory generation was removed');
  assert.ok(goodies.notices.some(notice => notice.startsWith('Imported ')));
  const zoom = goodies.ext.tools.get('zoom').definition;
  assert.ok((await zoom.execute('recall', { id: 2, n: 1 })).content[0].text.includes('HISTORICAL_FIXTURE'));
  const unchanged = imported.length; await command('import');
  assert.equal((await records(join(dir, generation))).length, unchanged); assert.ok(goodies.notices.some(notice => notice.includes('Nothing new to import')));
  history[0].id = 'pause-fixture'; await writeFile(exported, JSON.stringify(history)); paused = true; await command('import');
  assert.ok(existsSync(join(dir, 'imports/pending.json'))); assert.equal((await goodies.emit('input')).action, 'handled');
  paused = false; await command('import'); assert.ok(!existsSync(join(dir, 'imports/pending.json')));
  history[0].id = 'discard-fixture'; await writeFile(exported, JSON.stringify(history)); paused = true; await command('import');
  const beforeDiscard = JSON.parse(await readFile(join(dir, 'active-memory.json')));
  discard = true; await command('import');
  assert.equal(JSON.parse(await readFile(join(dir, 'active-memory.json'))), beforeDiscard); assert.ok(!existsSync(join(dir, 'imports/pending.json')));
  history[0].id = 'rebuild-fixture'; await writeFile(exported, JSON.stringify(history)); paused = false; discard = false; rebuilding = true;
  const oldCount = (await records(join(dir, beforeDiscard))).length; await command('import');
  const rebuilt = JSON.parse(await readFile(join(dir, 'active-memory.json')));
  assert.notEqual(rebuilt, beforeDiscard); assert.ok((await records(join(dir, rebuilt))).length > oldCount);
  assert.equal((await records(join(dir, beforeDiscard))).length, oldCount, 'rebuild changed the previous generation');
  // Export without launching the desktop's default browser during the test.
  goodies.ctx.hasUI = false; await command('browse'); assert.ok((await readFile(join(dir, 'memory.html'), 'utf8')).includes('HISTORICAL_FIXTURE'));
  assert.ok(execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).includes('Save OptChat memory'));
  if (process.env.OPTCHAT_UI_EVIDENCE) {
    // Strip ANSI colors for the static component-render exhibit.
    // eslint-disable-next-line no-control-regex
    const clean = text => text.replace(/\x1b\[[0-9;]*m/g, '');
    const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await writeFile(process.env.OPTCHAT_UI_EVIDENCE, '<!doctype html><meta charset="utf-8"><title>OptChat component renders</title><style>body{background:#161821;color:#e9e9ec;padding:24px;font:14px monospace}pre{background:#222430;padding:20px;overflow:auto}h2{font:18px sans-serif}</style>' + views.map((lines, i) => `<h2>${['Menu', 'Settings', 'Compressor picker', 'Usage', 'Memory activity'][i]}</h2><pre>${escape(clean(lines.join('\n')))}</pre>`).join(''));
    await cp(join(dir, 'memory.html'), process.env.OPTCHAT_UI_EVIDENCE.replace(/\.html$/, '-browser.html'));
  }
  await command('off'); await goodies.emit('session_shutdown'); delete process.env.OPTCHAT_HOME;
  report('restored menu/settings/model/instructions/usage/activity/browser/checkpoints and import preview/append/rebuild/dedup/pause/resume/discard; same session retained');
  report('images saved and returned by zoom; search shows late match without false pagination; usage panel displays populated ledger');

  const slow = await profile('slow'); await mkdir(join(slow, 'main'));
  await writeFile(join(slow, 'main/seed.jsonl'), JSON.stringify({ i: 0, kind: 'user', text: 'ORBIT original record '.repeat(100), date: new Date().toISOString(), size: 2200 }) + '\n');
  const gate = join(temp, 'release-compression');
  let client = await start(join(temp, 'slow.jsonl'), { flags: ['--optchat-profile', 'slow'], gate });
  const beforeSlow = snapshots().length;
  await chat(client, 'RECALL_FIXTURE: exact pending record.', 'RECALL_OK', async () => {
    assert.equal(snapshots().slice(beforeSlow).filter(s => !s.compression).length, 0, 'inference ran before required compression succeeded');
    await writeFile(gate, 'release');
  });
  await stop(client);
  report('RPC acknowledgement arrives while compression is held; first inference waits for successful summaries');

  const abortProfile = await profile('abort'); await mkdir(join(abortProfile, 'main'));
  await writeFile(join(abortProfile, 'main/seed.jsonl'), JSON.stringify({ i: 0, kind: 'user', text: 'ORBIT original record '.repeat(100), date: new Date().toISOString(), size: 2200 }) + '\n');
  const abortGate = join(temp, 'abort-release');
  let requestCount = snapshots().length;
  client = await start(join(temp, 'abort.jsonl'), { flags: ['--optchat-profile', 'abort'], gate: abortGate });
  let from = client.events.length;
  assert.equal(await client.prompt('Abort while summaries are held'), 'started');
  await until(() => snapshots().slice(requestCount).some(s => s.compression === 'start'));
  await client.abort(); await until(() => client.events.slice(from).some(event => event.type === 'agent_settled'));
  assert.equal(snapshots().slice(requestCount).filter(s => !s.compression).length, 0);
  await writeFile(abortGate, 'release'); await chat(client, 'Retry after cancellation', 'MEMORY_OK'); await stop(client);
  const transientProfile = await profile('retry'); await mkdir(join(transientProfile, 'main'));
  await writeFile(join(transientProfile, 'main/seed.jsonl'), JSON.stringify({ i: 0, kind: 'user', text: 'ORBIT original record '.repeat(100), date: new Date().toISOString(), size: 2200 }) + '\n');
  const failFile = join(temp, 'fail-once'); await writeFile(failFile, '1');
  client = await start(join(temp, 'transient.jsonl'), { flags: ['--optchat-profile', 'retry'], env: { OPTCHAT_COMPRESS_FAIL: failFile } });
  from = client.events.length; requestCount = snapshots().length;
  assert.equal(await client.prompt('One failed compression'), 'started');
  await until(() => client.events.slice(from).some(event => event.type === 'agent_settled'));
  assert.equal(snapshots().slice(requestCount).filter(s => !s.compression).length, 0);
  await until(() => snapshots().slice(requestCount).some(s => s.compression === 'end'));
  await chat(client, 'Retry after compressor recovery', 'MEMORY_OK'); await stop(client);
  report('summary cancellation and transient failure stop the current inference; next prompt recovers without toggling');

  const kickedSession = join(temp, 'kicked.jsonl');
  client = await start(kickedSession, { flags: ['--optchat-profile', 'fixture'] });
  for (const afterOrdinary of [false, true]) {
    if (afterOrdinary) await chat(client, 'Ordinary memory turn', 'MEMORY_OK');
    from = client.events.length; requestCount = snapshots().length;
    assert.equal(await client.prompt('/fixture-kick'), 'handled');
    await until(() => client.events.slice(from).some(event => event.type === 'agent_settled'));
    assert.equal(await client.getLastAssistantText(), 'MEMORY_OK');
    assert.equal(snapshots().slice(requestCount).filter(s => !s.compression).length, 1);
  }
  assert.deepEqual(await boundaries(kickedSession), ['start', 'end', 'start', 'end', 'start', 'end']);
  await stop(client);
  report('idle extension-triggered turns have memory/profile instructions and paired run markers, before and after ordinary turns');

  client = await start(join(temp, 'refresh.jsonl'), { flags: ['--optchat-profile', 'fixture'], env: { OPTCHAT_REFRESH_AT: '0.02' } });
  requestCount = snapshots().length;
  await chat(client, 'REFRESH_FIXTURE: continue a long tool loop', 'REFRESH_OK');
  const refreshed = snapshots().slice(requestCount).filter(s => !s.compression);
  assert.equal(refreshed.length, 3); assert.equal(refreshed[0].hash, refreshed[1].hash); assert.notEqual(refreshed[1].hash, refreshed[2].hash);
  assert.ok(!refreshed[2].text.includes('REFRESH_HISTORY '.repeat(1000)), 'oversized old step stayed verbatim');
  await stop(client); report('long-turn refresh updates the memory view and keeps the task and final tool step whole');

  const session = join(temp, 'session.jsonl');
  client = await start(session, { vcc: true });
  await chat(client, 'BEFORE_ENABLE original ordinary context '.repeat(150), 'PLAIN_OK');
  await chat(client, 'Second plain request', 'PLAIN_OK');
  const nativeEntries = (await readFile(session, 'utf8')).trim().split('\n').map(JSON.parse).filter(entry => entry.type === 'message' && entry.message.role === 'assistant');
  assert.equal(await client.prompt('/optchat on fixture'), 'handled');
  await chat(client, 'Remember ORBIT marker. '.repeat(70), 'MEMORY_OK');
  const firstRecords = await records(join(home, 'profiles/fixture'));
  assert.ok(firstRecords.length >= 2); assert.ok(firstRecords.every(entry => !entry.text.includes('BEFORE_ENABLE')), 'enabling silently backfilled older history');
  const before = snapshots().length;
  await chat(client, 'RECALL_FIXTURE: find the original marker and date.', 'RECALL_OK');
  const inference = snapshots().slice(before).filter(s => !s.compression);
  assert.equal(inference.length, 3); assert.equal(new Set(inference.map(s => s.hash)).size, 1);
  assert.ok(snapshots().slice(before).some(s => s.compression === 'end'));
  const ledger = () => readFileSync(join(home, 'profiles/fixture/usage.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const sessionId = JSON.parse(readFileSync(session, 'utf8').split('\n')[0]).id;
  assert.equal(ledger().filter(entry => entry.role === 'main' && entry.session === sessionId).length, 4);
  for (const entry of nativeEntries) assert.ok(!ledger().some(row => row.id === `entry:${entry.id}:${entry.timestamp}`), 'ledger counted a turn before enabling');
  await client.compact().catch(() => {});
  assert.equal((await readFile(session, 'utf8')).trim().split('\n').map(JSON.parse).filter(e => e.type === 'compaction').length, 0, 'active OptChat allowed a competing compaction');
  const count = (await records(join(home, 'profiles/fixture'))).length;
  await stop(client);
  client = await start(session);
  assert.ok(client.events.some(event => event.method === 'notify' && event.message.includes(`fixture · ${count} messages`)));
  await chat(client, 'RECALL_FIXTURE: resumed profile exact recall.', 'RECALL_OK');
  // Busy profile: never silently open a subagent or proceed without the requested memory.
  const busy = await start(join(temp, 'busy.jsonl'), { flags: ['--optchat-profile', 'fixture'] });
  assert.equal(await busy.prompt('Must use requested memory'), 'handled');
  assert.ok(busy.events.some(event => event.method === 'notify' && event.message.includes('already running')));
  const print = spawnSync(join(prefix, 'bin/pi'), ['-ne', '-ns', '-np', '--no-themes', '--no-mcp', '-nc', '-e', join(root, 'scripts/fixtures/optchat-provider.ts'), '-e', entry, '--model', 'optchat-fixture/fixture', '--no-session', '--optchat-profile', 'fixture', '-p', 'Busy print must fail visibly'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PI_OFFLINE: '1', PI_CODING_AGENT_DIR: join(temp, 'agent'), OPTCHAT_HOME: home, OPTCHAT_TEST_LOG: log, OPTCHAT_FAUX_MODULE: pathToFileURL(join(runtime, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js')).href }, timeout: 15_000 });
  assert.equal(print.status, 1); assert.ok(print.stderr.includes('Profile already running')); assert.equal(print.stdout.trim(), '');
  await busy.prompt('/optchat off'); await chat(busy, 'Plain after failed profile open', 'PLAIN_OK'); await stop(busy);
  report('RPC enable/resume, compression before inference, frozen tool-loop view, busy-profile refusal', { frozenRequests: inference.length });
  const rawBefore = (await readFile(session, 'utf8')).trim().split('\n').map(JSON.parse).filter(e => e.type === 'message');
  const indexLock = join(home, 'profiles/fixture/.git/index.lock'); await writeFile(indexLock, '');
  from = client.events.length;
  assert.equal(await client.prompt('/optchat off'), 'handled');
  assert.ok(client.events.slice(from).some(event => event.method === 'notify' && event.message.includes('Local checkpoint failed')));
  await rm(indexLock);
  assert.equal((await readFile(session, 'utf8')).trim().split('\n').map(JSON.parse).findLast(entry => entry.customType === 'optchat.session').data.enabled, false);
  const countOff = (await records(join(home, 'profiles/fixture'))).length;
  await chat(client, 'OFF_ONLY native request', 'PLAIN_OK');
  assert.equal((await records(join(home, 'profiles/fixture'))).length, countOff);
  assert.equal(ledger().filter(entry => entry.role === 'main' && entry.session === sessionId).length, 7);
  await stop(client); client = await start(session, { vcc: true });
  await chat(client, 'OFF_ONLY resume remains ordinary', 'PLAIN_OK');
  await client.compact();
  const rawAfter = (await readFile(session, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(rawAfter.some(e => e.type === 'compaction' && e.details?.compactor === 'pi-vcc'));
  for (const original of rawBefore) assert.deepEqual(rawAfter.find(e => e.id === original.id), original, 'original session message changed');
  await stop(client);
  // Continue in a different session once the first has released its profile.
  client = await start(join(temp, 'continuation.jsonl'));
  await client.prompt('/optchat on fixture'); await chat(client, 'RECALL_FIXTURE: another session continues memory.', 'RECALL_OK');
  const snapshot = snapshots().filter(s => !s.compression).at(-1);
  assert.ok(!snapshot.text.includes('OFF_ONLY'), 'off-state messages were added to memory');
  assert.equal(ledger().filter(entry => entry.role === 'main' && entry.session === sessionId).length, 7, 'profile counted off-state turns on reopen');
  await stop(client);
  report('off survives RPC reload, native context restored, pi-vcc compaction works, cross-session profile continuation');
  report('checkpoint failure still saves off and hides memory tools; busy print exits nonzero; usage excludes pre-enable and off-state turns');

  // Negative controls prove the provider checks detect real Pi 1.1 tool/prompt leaks.
  for (const [label, source, error] of [
    ['tools', "import { Type } from 'typebox'; export default pi => pi.registerTool({ name: 'spawn', label: 'Injected leak', description: 'Fixture only', defaultActive: true, parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) });", 'subagent tools leaked'],
    ['prompt', "export default pi => pi.on('before_agent_start', event => { event.systemPromptOptions.sections.instructions = 'OptChat memory view'; });", 'off state retained memory instructions'],
  ]) {
    const extra = join(temp, `leak-${label}.ts`); await writeFile(extra, source);
    client = await start(join(temp, `leak-${label}.jsonl`), { extra });
    await assert.rejects(chat(client, 'Negative control ordinary prompt', 'PLAIN_OK'), undefined, `negative control: ${label}`);
    const failure = (await client.getMessages()).findLast(message => message.role === 'assistant');
    assert.equal(failure.stopReason, 'error'); assert.ok(failure.errorMessage.includes(error)); await stop(client);
  }
  report('corrected provider assertions reject deliberately injected tool and instruction leaks');

  // An old upstream binding has no optchat.session record: RPC must restore it unchanged.
  const legacy = join(temp, 'legacy.jsonl');
  const now = new Date().toISOString();
  await writeFile(legacy, [ { type: 'session', version: 3, id: 'legacy-fixture', timestamp: now, cwd: root }, { type: 'custom', id: 'abc01234', parentId: null, timestamp: now, customType: 'optchat.profile', data: { name: 'fixture' } } ].map(JSON.stringify).join('\n') + '\n');
  client = await start(legacy); await chat(client, 'RECALL_FIXTURE: old RPC binding.', 'RECALL_OK'); await stop(client);
  report('legacy upstream profile binding restores in RPC');
  const settingsFile = join(temp, 'agent/settings.json');
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  settings.packages = [join(root, 'packages/optchat')]; await writeFile(settingsFile, JSON.stringify(settings));
  client = await start(join(temp, 'installed.jsonl'), { installed: true });
  assert.equal((await client.getCommands()).filter(command => command.name === 'optchat').length, 1);
  await chat(client, 'Local package off by default', 'PLAIN_OK');
  await client.prompt('/optchat on fixture'); await chat(client, 'RECALL_FIXTURE: package-discovered memory.', 'RECALL_OK'); await stop(client);
  report('local package resolves via Pi settings and exposes one optchat command');
  if (process.env.OPTCHAT_ALFRED_SESSION && process.env.OPTCHAT_ALFRED_PROFILE) {
    await cp(process.env.OPTCHAT_ALFRED_PROFILE, join(home, 'profiles/alfred'), { recursive: true, filter: path => !path.endsWith('.sock') });
    const configFile = join(home, 'profiles/alfred/config.json'), saved = JSON.parse(await readFile(configFile, 'utf8'));
    saved.compactor = config.compactor; await writeFile(configFile, JSON.stringify(saved));
    const copy = join(temp, 'alfred.jsonl'); await cp(process.env.OPTCHAT_ALFRED_SESSION, copy);
    client = await start(copy, { skipInstructions: true }); await chat(client, 'RECALL_FIXTURE: imported Alfred record.', 'RECALL_OK'); await stop(client);
    report('Alfred imported history preserved and retrieved through native zoom/date', { data: 'disposable copies only' });
  }
  const evidence = { result: 'PASS', runtime: 'installed Pi 1.1; real RPC and SDK-loaded TUI handlers', results, liveModelCalls: false };
  if (process.env.OPTCHAT_TEST_REPORT) await writeFile(process.env.OPTCHAT_TEST_REPORT, JSON.stringify(evidence, null, 2) + '\n');
} finally {
  await writeFile(join(temp, 'release-compression'), 'release');
  delete process.env.OPTCHAT_HOME;
  for (const client of clients) await client.stop();
  await rm(temp, { recursive: true, force: true });
}
