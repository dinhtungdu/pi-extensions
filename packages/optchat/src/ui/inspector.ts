import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Memory } from '../vendor/memory.ts';
import type { Usage } from '@earendil-works/pi-ai';
import { ranges, summarizeUsage, type UsageLedger, type UsageRange, type UsageRole } from '../vendor/usage.ts';

// Strip terminal controls from stored model/error strings before rendering them.
// eslint-disable-next-line no-control-regex
export const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '  ');
export const oneLine = (text: string) => clean(text).replace(/\n/g, ' ');
export const count = (n: number) => n.toLocaleString('en-US');
const units = ['', 'k', 'M', 'B'];
/** 950, 12.3k, 164k, 2.4M: enough precision to compare rows at a glance. A value that rounds to 1000 moves up a unit. */
export const short = (n: number) => {
  let unit = 0, value = n;
  const round = (v: number) => v >= 100 || !unit ? Math.round(v) : Number(v.toFixed(1));
  while (unit < units.length - 1 && round(value) >= 1000) { value /= 1000; unit++; }
  return `${round(value)}${units[unit]}`;
};
const dollars = (n: number) => `$${n.toFixed(2)}`;
const cached = (u: Usage) => { const input = u.input + u.cacheRead + u.cacheWrite; return `${input ? Math.round(100 * u.cacheRead / input) : 0}%`; };
const roleNames: Record<UsageRole, string> = { main: 'main', subagent: 'subagents', compactor: 'compactor', import: 'import' };
export const elapsed = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.floor(ms / 1000) % 60}s`;
/** Shortens plain text with an ellipsis, preferring a word boundary. */
export function fit(text: string, width: number) {
  if (visibleWidth(text) <= width) return text;
  if (width < 2) return sliceByColumn(text, 0, width, true);
  const cut = sliceByColumn(text, 0, width - 1, true), space = cut.lastIndexOf(' '); // Unlike truncateToWidth, adds no style reset.
  return `${(space > cut.length * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
const pages = ['usage', 'activity'] as const;
export type InspectorPage = typeof pages[number];
const pageNames: Record<InspectorPage, string> = { usage: 'Usage', activity: 'Activity' };
/** Tab order: Usage, Activity. */
export const nextPage = (page: InspectorPage, delta = 1) => pages[(pages.indexOf(page) + delta + pages.length) % pages.length];
/** Read-only panels never open or operate agents. */
export type InspectorAction = undefined;
type Tone = 'accent' | 'muted' | 'dim' | 'error' | 'warning' | 'border';
interface Options {
  profile: string; session: string; usage: UsageLedger; memory: Pick<Memory, 'root' | 'size' | 'budget' | 'lastError' | 'progress' | 'onChange'>; page: InspectorPage;
  rows: () => number; redraw: () => void; done: (action?: InspectorAction) => void;
  color: (tone: Tone, text: string) => string;
  context: () => number | null | undefined;
  refreshUsage?: () => void;
  signal?: AbortSignal;
}

/** Read-only memory and usage projection. */
export class Inspector implements Component, Focusable {
  focused = true;
  private page: InspectorPage;
  private scroll = 0;
  private lineCount = 0;
  private hintLines = 1;
  private range: UsageRange = 'This session';
  private ended = false;
  private readonly unsubscribe: (() => void)[];
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: Options) {
    this.page = options.page;
    this.unsubscribe = [options.memory.onChange(() => options.redraw())];
    this.timer = setInterval(() => { options.refreshUsage?.(); options.redraw(); }, 1000); this.timer.unref();
    options.signal?.addEventListener('abort', this.abort, { once: true });
    if (options.signal?.aborted) queueMicrotask(this.abort);
  }
  private readonly abort = () => this.finish();
  private finish(action?: InspectorAction) { if (!this.ended) { this.dispose(); this.options.done(action); } }
  dispose() {
    this.ended = true; clearInterval(this.timer); this.unsubscribe.forEach(stop => stop()); this.options.signal?.removeEventListener('abort', this.abort);
  }
  invalidate() {}
  /** Body rows left after the rules, title, hint and spacing; the rest of the screen keeps the footer visible. */
  private get height() { return Math.max(1, Math.floor(this.options.rows() * 0.8) - 6 - (this.hintLines - 1)); }
  handleInput(data: string) {
    if (this.ended) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) return this.finish();
    if (matchesKey(data, 'tab')) { this.page = nextPage(this.page); this.scroll = 0; }
    else if (this.page === 'usage' && (matchesKey(data, 'left') || matchesKey(data, 'right'))) {
      const delta = matchesKey(data, 'left') ? -1 : 1;
      this.range = ranges[(ranges.indexOf(this.range) + delta + ranges.length) % ranges.length]; this.scroll = 0;
    } else {
      const delta = matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : matchesKey(data, 'pageUp') ? -this.height : matchesKey(data, 'pageDown') ? this.height : 0;
      this.scroll = matchesKey(data, 'home') ? 0 : matchesKey(data, 'end') ? this.lineCount : this.scroll + delta;
    }
    this.options.redraw();
  }
  /** Period tabs, one headline, then an aligned table with a row per role and model. */
  private usageLines(width: number) {
    const { usage, session, context, color } = this.options;
    const entries = usage.select(this.range, session);
    const { total, groups } = summarizeUsage(entries);
    // No-break spaces keep a label like "Last 7 days" on one line when the tabs wrap.
    const tabs = ranges.map(r => r.replaceAll(' ', '\u00a0')).map((r, i) => ranges[i] === this.range ? color('accent', `[${r}]`) : color('dim', r)).join('  ');
    const lines = [...wrapTextWithAnsi(tabs, width), ''];
    if (!entries.length) lines.push(color('muted', 'No usage in this period.'));
    else {
      lines.push(`${color('accent', dollars(total.cost.total))} estimated · ${short(total.totalTokens)} tokens · ${cached(total)} cached`, '');
      const order = ['main', 'subagent', 'compactor', 'import'] as const;
      const sorted = groups.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || b.usage.cost.total - a.usage.cost.total);
      const rows = sorted.map((g, i) => [i && sorted[i - 1].role === g.role ? '' : roleNames[g.role], oneLine(g.model), dollars(g.usage.cost.total),
        `${total.cost.total ? Math.round(100 * g.usage.cost.total / total.cost.total) : 0}%`, short(g.usage.output), cached(g.usage)]);
      const header = ['', 'model', 'cost', 'share', 'out', 'cached'];
      const widths = header.map((h, c) => Math.max(h.length, ...rows.map(r => r[c].length)));
      // The model column goes first when the screen is too narrow for every column.
      const columns = widths.reduce((sum, w) => sum + w + 2, 0) - 2 <= width ? [0, 1, 2, 3, 4, 5] : [0, 2, 3, 4, 5];
      const line = (cells: string[]) => columns.map(c => c < 2 ? cells[c].padEnd(widths[c]) : cells[c].padStart(widths[c])).join('  ').trimEnd();
      lines.push(color('dim', line(header)), ...rows.map(r => {
        const text = line(r); return color('muted', text.slice(0, widths[0])) + text.slice(widths[0]);
      }));
    }
    const current = context();
    if (current != null) lines.push('', `${color('muted', 'Context now')} ${short(current)} tokens`);
    lines.push('', color('dim', 'Estimated at API prices, not your subscription bill.'), ...usage.warnings.map(w => color('warning', w)));
    return lines.flatMap(l => l ? wrapTextWithAnsi(l, width) : ['']);
  }
  /** Memory view size, summary progress and errors. */
  private activityLines(width: number) {
    const { memory, color } = this.options;
    const { done, total, retryIn } = memory.progress();
    const filled = total ? Math.floor(10 * done / total) : 0;
    const lines = [`${color('muted', 'Memory')} · ${count(memory.root.length)} messages · view ${Math.round(memory.size / 1000)} KB / ${Math.round(memory.budget / 1000)} KB`,
      total ? `Catching up · ${count(done)} of ${count(total)} summaries  ${color('accent', '█'.repeat(filled))}${color('dim', '░'.repeat(10 - filled))}` : color('dim', 'Settled')];
    if (memory.lastError) lines.push(color('dim', `${oneLine(memory.lastError)}${retryIn === undefined ? '' : ` · retry in ${elapsed(retryIn)}`}`));
    return lines.flatMap(l => l ? wrapTextWithAnsi(l, width) : ['']);
  }
  render(width: number): string[] {
    const { color, profile } = this.options;
    const inner = Math.max(1, width - 2);
    const lines = this.page === 'usage' ? this.usageLines(inner) : this.activityLines(inner);
    this.lineCount = lines.length;
    this.scroll = Math.max(0, Math.min(this.scroll, lines.length - this.height));
    const body = lines.slice(this.scroll, this.scroll + this.height);
    const hint = this.page === 'usage' ? '←→ period · ↑↓ scroll · Tab activity · Esc close' : '↑↓ scroll · Tab usage · Esc close';
    const footer = wrapTextWithAnsi(hint, inner).map(line => color('dim', line)); this.hintLines = footer.length;
    const title = fit(`OptChat · ${oneLine(profile)} · ${pageNames[this.page]}`, inner);
    const rule = color('border', '─'.repeat(Math.max(1, width)));
    return [rule, ...[color('accent', title), '', ...body, '', ...footer].map(line => ` ${truncateToWidth(line, inner, '…')}`), rule].map(line => truncateToWidth(line, width));
  }
}

let showing = false;
/** True while the panel is on screen; cleared before Pi restores the editor so the agent bar returns in the same frame. */
export const inspectorShowing = () => showing;
/** Takes the editor's place, like Pi's own selectors; Pi restores the editor and its draft on close. */
export function showInspector(ctx: ExtensionContext, options: Omit<Options, 'rows' | 'redraw' | 'done' | 'color' | 'context'>) {
  return ctx.ui.custom<InspectorAction | undefined>((tui, theme, _keys, done) => {
    showing = true;
    return new Inspector({ ...options,
      rows: () => tui.terminal.rows, redraw: () => tui.requestRender(), done: action => { showing = false; done(action); },
      color: (tone, text) => theme.fg(tone, text), context: () => ctx.getContextUsage()?.tokens,
    });
  });
}
