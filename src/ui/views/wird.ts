/** Wird Planner page: Today · Week · Plans · Statistics · History (tab in the route: #/wird?tab=…). */
import { datesBetween, isDateKey, shiftDate, weekStartOf, type Weekday } from '../../core/wird/dates.ts';
import { currentConfig, planDay, type PlanDay, type UnitItem } from '../../core/wird/engine.ts';
import type { WirdPlan, WirdTask } from '../../core/wird/model.ts';
import type { App } from '../app.ts';
import { openDialog } from '../components/dialog.ts';
import { h, type Child } from '../dom.ts';
import { fmtDateKey, fmtNum, t, tn } from '../i18n/index.ts';
import { colorClass, dayName, detailsDialog, itemsLabel, longDate, qualityShort, statusChip, todaySection, unitLabel, wirdHref } from './wirdCard.ts';
import { plansTab } from './wirdPlans.ts';
import { statsTab } from './wirdStats.ts';

const TABS = ['today', 'week', 'plans', 'stats', 'history'] as const;
type Tab = (typeof TABS)[number];

export function wirdView(app: App): Node {
  const raw = app.route.params.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'today';
  const tabs = h(
    'nav',
    { class: 'wird-tabs', 'aria-label': t('wird.title') },
    TABS.map((x) => h('a', { href: wirdHref({ tab: x }), 'aria-current': x === tab ? 'page' : null, 'data-key': `wird-tab-${x}` }, t(`wird.tab.${x}`))),
  );
  let body: Node;
  switch (tab) {
    case 'today':
      body = todaySection(app, { includePaused: true });
      break;
    case 'week':
      body = weekTab(app);
      break;
    case 'plans':
      body = plansTab(app);
      break;
    case 'stats':
      body = statsTab(app);
      break;
    case 'history':
      body = historyTab(app);
      break;
  }
  return h('div', { class: 'wird-page' }, h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('wird.title')), h('p', { class: 'muted' }, t('wird.intro')))), tabs, body);
}

// ------------------------------------------------------------------ week

type ShowFilter = 'all' | 'done' | 'pending' | 'overdue';

function matches(d: PlanDay, show: ShowFilter): boolean {
  if (show === 'all') return true;
  if (show === 'done') return d.status === 'done';
  if (show === 'overdue') return d.status === 'overdue' || d.overdue.some((u) => !u.done);
  return ['pending', 'partial', 'upcoming', 'overdue'].includes(d.status);
}

function weekEntry(app: App, d: PlanDay, today: string): HTMLElement | null {
  const plan = d.plan;
  if (d.type === 'inactive') return null;
  const cls = `week-entry ${colorClass(plan)} ${d.type} ${d.status}`;
  if (d.type === 'rest' || d.type === 'paused') {
    return h('div', { class: cls }, h('span', { class: 'we-plan' }, plan.name), h('span', { class: 'we-range muted' }, d.type === 'rest' ? t('wird.status.rest') : t('wird.status.paused')));
  }
  const own = d.type === 'full' ? d.full : d.scheduled;
  const overdueOpen = d.date === today ? d.overdue.filter((u) => !u.done).length : 0;
  const content: Child[] = [
    h('span', { class: 'we-plan' }, plan.name),
    h('span', { class: 'we-range' }, d.type === 'full' ? t('wird.fullOf', { range: itemsLabel(own) }) : itemsLabel(own)),
    h('span', { class: 'we-foot' }, statusChip(d.status), overdueOpen ? h('span', { class: 'chip wird-chip overdue' }, t('wird.plusOverdue', { count: overdueOpen })) : null, d.spread.length && d.preview ? h('span', { class: 'chip wird-chip overdue' }, t('wird.plusOverdue', { count: d.spread.length })) : null),
  ];
  if (d.preview) return h('div', { class: cls }, content);
  return h('button', { type: 'button', class: cls, onclick: () => (d.date === today ? detailsDialog(app, plan.id) : pastDayDialog(app, plan, d.date)) }, content);
}

function weekTab(app: App): HTMLElement {
  const today = app.today();
  const params = app.route.params;
  const plans = app.data.wird.plans.filter((p) => p.status !== 'archived');
  if (!plans.length) return todaySection(app);
  const ws: Weekday = plans[0] ? currentConfig(plans[0], today).weekStart : 6;
  const asked = params.get('week');
  const start = asked && isDateKey(asked) ? weekStartOf(asked, ws) : weekStartOf(today, ws);
  const planFilter = params.get('plan') ?? '';
  const show = (['all', 'done', 'pending', 'overdue'].includes(params.get('show') ?? '') ? params.get('show') : 'all') as ShowFilter;
  const shown = plans.filter((p) => !planFilter || p.id === planFilter);
  const dates = datesBetween(start, shiftDate(start, 6));
  const go = (p: Record<string, string | null>) => app.navigate(wirdHref({ tab: 'week', week: start, plan: planFilter, show, ...p }));

  const planSel = h('select', { 'aria-label': t('wird.filterPlan'), onchange: (e: Event) => go({ plan: (e.target as HTMLSelectElement).value || null }) }, h('option', { value: '' }, t('wird.allPlans')), plans.map((p) => h('option', { value: p.id, selected: p.id === planFilter }, p.name)));
  const showSel = h('select', { 'aria-label': t('wird.filterStatus'), onchange: (e: Event) => go({ show: (e.target as HTMLSelectElement).value }) }, (['all', 'done', 'pending', 'overdue'] as const).map((s) => h('option', { value: s, selected: s === show }, t(`wird.filter.${s}`))));

  let any = false;
  const days = dates.map((date) => {
    const entries = shown.map((p) => planDay(p, app.data.wird.tasks, date, today)).filter((d) => matches(d, show));
    const load = entries.reduce((s, d) => s + (d.preview ? d.scheduled.length + d.full.length + d.spread.length : d.date === today ? d.required.length : d.scheduled.length + d.full.length), 0);
    const nodes = entries.map((d) => weekEntry(app, d, today)).filter((x): x is HTMLElement => !!x);
    if (nodes.length) any = true;
    return h('section', { class: `week-day${date === today ? ' today' : ''}`, 'aria-label': longDate(date) },
      h('div', { class: 'week-day-head' }, h('strong', null, dayName(date)), h('span', { class: 'muted' }, fmtDateKey(date, { day: 'numeric', month: 'short' })), h('span', { class: 'we-load' }, tn('wird.dayLoad', load))),
      nodes);
  });

  return h('div', { class: 'stack' },
    h('div', { class: 'row spread week-nav' },
      h('div', { class: 'row' },
        h('button', { type: 'button', 'aria-label': t('wird.prevWeek'), onclick: () => go({ week: shiftDate(start, -7) }) }, '‹ ', t('wird.prevWeek')),
        h('button', { type: 'button', class: 'quiet', onclick: () => go({ week: null }) }, t('wird.thisWeek')),
        h('button', { type: 'button', 'aria-label': t('wird.nextWeek'), onclick: () => go({ week: shiftDate(start, 7) }) }, t('wird.nextWeek'), ' ›')),
      h('strong', null, t('wird.weekOf', { start: fmtDateKey(start), end: fmtDateKey(shiftDate(start, 6)) }))),
    h('div', { class: 'row filters' }, h('label', { class: 'field' }, h('span', null, t('wird.filterPlan')), planSel), h('label', { class: 'field' }, h('span', null, t('wird.filterStatus')), showSel)),
    h('div', { class: 'week-grid' }, days),
    any ? null : h('p', { class: 'muted' }, t('wird.weekEmpty')),
    h('div', { class: 'legend wird-legend', 'aria-label': t('wird.legend') }, plans.map((p) => h('span', { class: colorClass(p) }, h('span', { class: 'swatch plan-swatch' }), p.name))),
  );
}

/** A past day of one plan: its units can still be ticked (late completion) or unticked. */
function pastDayDialog(app: App, plan: WirdPlan, date: string): void {
  const list = h('ul', { class: 'detail-list' });
  const render = () => {
    const d = planDay(plan, app.data.wird.tasks, date, app.today());
    list.replaceChildren(
      ...[...d.scheduled, ...d.full].map((u) => {
        const box = h('input', { type: 'checkbox', checked: u.done, disabled: !!u.closed });
        box.addEventListener('change', () => void app.act(async () => {
          if (u.done) await app.s.wird.uncomplete([{ taskId: u.taskId, n: u.n }]);
          else await app.s.wird.complete([{ taskId: u.taskId, n: u.n }]);
          await app.refresh();
          render();
        }));
        return h('li', { class: `detail-row${u.done ? ' done' : ''}` }, h('label', { class: 'detail-main' }, box, h('span', null, h('strong', null, unitLabel(u.unit, u.n)), u.doneOn && u.doneOn !== date ? h('small', { class: 'muted' }, fmtDateKey(u.doneOn)) : null, u.quality ? h('small', { class: 'muted' }, qualityShort(u.quality)) : null, u.closed ? h('small', { class: 'muted' }, t(`wird.closed.${u.closed}`)) : null)));
      }),
    );
  };
  render();
  openDialog({ title: t('wird.detailsTitle', { plan: plan.name, date: longDate(date) }), body: list, actions: (close) => h('button', { type: 'button', class: 'primary', onclick: close }, t('common.close')) });
}

// ------------------------------------------------------------------ history

interface HistoryGroup {
  readonly plan: WirdPlan;
  readonly task: WirdTask;
  readonly items: UnitItem[];
}

function historyTab(app: App): HTMLElement {
  const plans = new Map(app.data.wird.plans.map((p) => [p.id, p]));
  const limit = Math.max(14, Number(app.route.params.get('limit')) || 14);
  const done = new Map<string, HistoryGroup[]>();
  const closed = new Map<string, HistoryGroup[]>();
  const add = (map: Map<string, HistoryGroup[]>, date: string, plan: WirdPlan, task: WirdTask, u: UnitItem) => {
    const list = map.get(date) ?? map.set(date, []).get(date) ?? [];
    let g = list.find((x) => x.task.id === task.id);
    if (!g) list.push((g = { plan, task, items: [] }));
    g.items.push(u);
  };
  for (const task of app.data.wird.tasks) {
    const plan = plans.get(task.planId);
    if (!plan) continue;
    for (const u of task.units) {
      const item: UnitItem = { taskId: task.id, taskDate: task.date, kind: task.kind, unit: task.unit, n: u.n, done: !!u.doneAt, doneOn: u.doneOn, quality: u.quality, dueOn: u.dueOn, closed: u.closed };
      if (u.doneOn) add(done, u.doneOn, plan, task, item);
      else if (u.closed && u.closedOn) add(closed, u.closedOn, plan, task, item);
    }
  }
  const dates = [...new Set([...done.keys(), ...closed.keys()])].sort().reverse();
  if (!dates.length) return h('p', { class: 'muted' }, t('wird.hi.empty'));
  const row = (g: HistoryGroup, isDone: boolean) =>
    h('li', { class: `history-row ${colorClass(g.plan)}` },
      h('span', { class: 'plan-dot', 'aria-hidden': 'true' }),
      h('div', { class: 'history-main' },
        h('div', null, h('strong', null, g.plan.name), ' · ', g.task.kind === 'full' ? t('wird.fullOf', { range: itemsLabel(g.items) }) : itemsLabel(g.items), h('small', { class: 'muted' }, ' (', t('wird.hi.fromDay', { day: fmtDateKey(g.task.date, { weekday: 'short', day: 'numeric', month: 'short' }) }), ')')),
        isDone
          ? h('div', { class: 'row history-q' }, [...new Set(g.items.map((i) => i.quality).filter((q) => q !== null))].map((q) => h('span', { class: `chip quality-chip q-${q}` }, qualityShort(q))), g.task.note ? h('span', { class: 'history-note' }, g.task.note) : null)
          : h('small', { class: 'muted' }, t('wird.hi.closed'), ': ', t(`wird.closed.${g.items[0]?.closed ?? 'merged'}`))),
      isDone ? h('button', { type: 'button', class: 'quiet', onclick: () => void app.act(async () => { await app.s.wird.uncomplete(g.items.map((i) => ({ taskId: i.taskId, n: i.n }))); await app.refresh(); }) }, t('wird.undo')) : null);
  return h('div', { class: 'stack' },
    dates.slice(0, limit).map((date) =>
      h('section', { class: 'panel history-day' },
        h('h3', null, longDate(date), ' ', h('small', { class: 'muted' }, fmtNum((done.get(date) ?? []).reduce((s, g) => s + g.items.length, 0)))),
        h('ul', { class: 'history-list' }, (done.get(date) ?? []).map((g) => row(g, true)), (closed.get(date) ?? []).map((g) => row(g, false))))),
    dates.length > limit ? h('a', { class: 'btn', href: wirdHref({ tab: 'history', limit: String(limit + 30) }) }, t('wird.hi.more')) : null,
  );
}
