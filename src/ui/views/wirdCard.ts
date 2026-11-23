/** Wird Planner: shared labels and the per-plan "today" card (used on the dashboard and the Wird page). */
import { fromIndex } from '../../core/quran/refs.ts';
import { divisionRangeScope } from '../../core/quran/scope.ts';
import { weekdayOf } from '../../core/wird/dates.ts';
import { planDay, type PlanDay, type UnitItem, type UnitRef } from '../../core/wird/engine.ts';
import { isDifficult, QUALITIES, type Quality, type WirdPlan } from '../../core/wird/model.ts';
import { convertSpan, rangeQuarterSpan, runs, WIRD_UNITS, type WirdUnit } from '../../core/wird/units.ts';
import type { App } from '../app.ts';
import { openDialog } from '../components/dialog.ts';
import { h, replaceChildren, type Child } from '../dom.ts';
import { fmtDateKey, fmtList, fmtNum, t, tn } from '../i18n/index.ts';
import { divisionLabel, errorText, kindName, refLabel } from '../i18n/labels.ts';
import { progressBar } from '../components/charts.ts';
import { sessionConfigFor } from './revision.ts';

// ------------------------------------------------------------------ labels

export function wirdHref(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return `#/wird?${q.toString()}`;
}

export const unitLabel = (unit: WirdUnit, n: number) => divisionLabel(unit, n);

/** "Hizb 13–16" or "Hizb 13, Hizb 15–16". */
export function rangeLabel(unit: WirdUnit, numbers: readonly number[]): string {
  if (!numbers.length) return '—';
  return fmtList(runs(numbers).map((r) => (r.from === r.to ? unitLabel(unit, r.from) : t('division.span', { kind: kindName(unit), from: r.from, to: r.to }))));
}

/** Items may mix units (after a unit change); label each unit kind separately. */
export function itemsLabel(items: readonly UnitItem[]): string {
  const parts: string[] = [];
  for (const unit of WIRD_UNITS) {
    const ns = items.filter((i) => i.unit === unit).map((i) => i.n);
    if (ns.length) parts.push(rangeLabel(unit, ns));
  }
  return parts.length ? fmtList(parts) : '—';
}

/** The same range in the other units when it lines up ("= Juz 7–15, Rub' 49–120"). */
export function equivalents(unit: WirdUnit, from: number, to: number): string | null {
  const span = rangeQuarterSpan(unit, from, to);
  const list = WIRD_UNITS.filter((u) => u !== unit).flatMap((u) => {
    const c = convertSpan(span, u);
    return c ? [c.from === c.to ? unitLabel(u, c.from) : t('division.span', { kind: kindName(u), from: c.from, to: c.to })] : [];
  });
  return list.length ? t('wird.equivalent', { list: fmtList(list) }) : null;
}

export const weekdayName = (d: number) => t(`wird.weekday.${d}` as 'wird.weekday.0');
export const dayName = (date: string) => weekdayName(weekdayOf(date));
/** "Sunday, 22 Nov" — used where days from different weeks can appear together. */
export const shortDay = (date: string) => fmtDateKey(date, { weekday: 'long', day: 'numeric', month: 'short' });
export const longDate = (date: string) => fmtDateKey(date, { weekday: 'long', day: 'numeric', month: 'long' });
export const qualityLabel = (q: Quality) => t(`wird.quality.${q}`);
export const qualityShort = (q: Quality) => t(`wird.qualityShort.${q}`);

export function statusChip(status: string): HTMLElement {
  return h('span', { class: `chip wird-chip ${status}` }, t(`wird.status.${status}` as 'wird.status.done'));
}

export const colorClass = (plan: WirdPlan) => `wc-${plan.color % 8}`;
export const refsOf = (items: readonly UnitItem[]): UnitRef[] => items.map((u) => ({ taskId: u.taskId, n: u.n }));

/** Ayah boundaries of a unit when the divisions data is loaded. */
export function ayahSpan(app: App, unit: WirdUnit, n: number): string | null {
  const index = app.quran.index;
  if (!index.has(unit)) return null;
  try {
    const r = index.range(unit, n);
    return `${refLabel(r.start)} – ${refLabel(fromIndex(r.endIndex))}`;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ actions

/** Plays consecutive units in a listening session; when it ends the user is offered to mark them done. */
export function listen(app: App, plan: WirdPlan, items: readonly UnitItem[]): void {
  const first = items[0];
  if (!first) return;
  const run = runs(items.filter((i) => i.unit === first.unit).map((i) => i.n))[0] as { from: number; to: number };
  const chosen = items.filter((i) => i.unit === first.unit && i.n >= run.from && i.n <= run.to);
  try {
    const scope = divisionRangeScope(first.unit, run.from, run.to, app.quran.index);
    app.wirdListen = { planId: plan.id, planName: plan.name, refs: refsOf(chosen), label: rangeLabel(first.unit, chosen.map((i) => i.n)) };
    app.prepare(sessionConfigFor(app, scope, 'full', null), () => `${plan.name}: ${rangeLabel(first.unit, chosen.map((i) => i.n))}`);
  } catch (e) {
    app.wirdListen = null;
    app.toast(errorText(e), 'error');
  }
}

function practise(app: App, unit: WirdUnit, n: number): void {
  try {
    const scope = divisionRangeScope(unit, n, n, app.quran.index);
    app.prepare(sessionConfigFor(app, scope, 'mistakes', null));
  } catch (e) {
    app.toast(errorText(e), 'error');
  }
}

async function toggle(app: App, u: UnitItem): Promise<void> {
  const label = unitLabel(u.unit, u.n);
  await app.act(async () => {
    if (u.done) await app.s.wird.uncomplete([{ taskId: u.taskId, n: u.n }]);
    else await app.s.wird.complete([{ taskId: u.taskId, n: u.n }]);
    await app.refresh();
  }, u.done ? t('wird.unitUndone', { unit: label }) : t('wird.unitDone', { unit: label }));
}

/** Marks units done, then offers the optional quality rating. */
export async function completeAll(app: App, items: readonly UnitItem[]): Promise<void> {
  const open = items.filter((u) => !u.done && !u.closed);
  if (!open.length) return;
  const ok = await app.act(async () => {
    await app.s.wird.complete(refsOf(open));
    await app.refresh();
  });
  if (ok) app.toast(t('wird.allDoneToast'), 'info', { label: t('wird.rate'), key: 'wird-rate', run: () => rateDialog(app, refsOf(open), open[0]?.taskId ?? null) });
}

/** Optional quality + note for units that were just completed. */
export function rateDialog(app: App, refs: readonly UnitRef[], noteTask: string | null): void {
  let chosen: Quality | null = null;
  const options = QUALITIES.map((q) =>
    h('label', { class: `quality-opt q-${q}` }, h('input', { type: 'radio', name: 'wird-quality', value: q, onchange: () => { chosen = q; } }), h('span', null, qualityLabel(q))),
  );
  const note = h('textarea', { rows: 2, maxlength: 2000, 'aria-label': t('wird.noteLabel') });
  openDialog({
    title: t('wird.rateTitle'),
    body: h('div', { class: 'stack' }, h('p', { class: 'muted' }, t('wird.rateHelp')), h('div', { class: 'quality-opts', role: 'radiogroup' }, options), h('label', { class: 'field' }, h('span', null, t('wird.noteLabel')), note)),
    actions: (close) => [
      h('button', { type: 'button', onclick: close }, t('common.cancel')),
      h('button', {
        type: 'button',
        class: 'primary',
        onclick: () => {
          close();
          void app.act(async () => {
            if (chosen) await app.s.wird.rate(refs, chosen);
            if (noteTask && note.value.trim()) await app.s.wird.setNote(noteTask, note.value);
            await app.refresh();
          }, t('wird.rated'));
        },
      }, t('wird.saveRating')),
    ],
  });
}

async function spreadDialog(app: App, plan: WirdPlan): Promise<void> {
  const proposal = await app.s.wird.proposeSpread(plan.id).catch((e: unknown) => {
    app.toast(errorText(e), 'error');
    return null;
  });
  if (!proposal) return;
  if (!proposal.days.length) {
    app.toast(t('wird.spreadNone'));
    return;
  }
  openDialog({
    title: t('wird.spreadTitle'),
    body: h('div', null, h('p', { class: 'muted' }, t('wird.spreadHelp')), h('ul', { class: 'spread-list' }, proposal.days.map((d) => h('li', null, h('strong', null, longDate(d.date)), h('span', null, itemsLabel(d.units)))))),
    actions: (close) => [
      h('button', { type: 'button', onclick: close }, t('common.cancel')),
      h('button', {
        type: 'button',
        class: 'primary',
        'data-key': 'wird-spread-ok',
        onclick: () => {
          close();
          void app.act(async () => {
            await app.s.wird.applySpread(proposal);
            await app.refresh();
          }, t('wird.spreadDone'));
        },
      }, t('wird.spreadApprove')),
    ],
  });
}

// ------------------------------------------------------------------ unit chips

const MAX_CHIPS = 40;

function chips(app: App, items: readonly UnitItem[]): HTMLElement {
  if (items.length > MAX_CHIPS) {
    const done = items.filter((i) => i.done).length;
    return h('p', { class: 'unit-summary' }, itemsLabel(items), ' · ', t('wird.progress', { done: fmtNum(done), total: fmtNum(items.length) }));
  }
  return h(
    'div',
    { class: 'unit-chips' },
    items.map((u) => {
      const label = unitLabel(u.unit, u.n);
      return h('button', {
        type: 'button',
        class: `unit-chip${u.done ? ' done' : ''}${u.quality && isDifficult(u.quality) ? ' weak' : ''}`,
        'aria-pressed': u.done ? 'true' : 'false',
        'aria-label': t('wird.toggleUnit', { unit: label }),
        title: ayahSpan(app, u.unit, u.n) ?? label,
        'data-key': `unit-${u.taskId}-${u.n}`,
        onclick: () => void toggle(app, u),
      }, h('span', { class: 'tick', 'aria-hidden': 'true' }, u.done ? '✓' : ''), u.unit === 'quarter' ? label : String(u.n));
    }),
  );
}

function section(cls: string, title: string, app: App, items: readonly UnitItem[], extra?: Child): HTMLElement | null {
  if (!items.length) return null;
  return h('div', { class: `wird-sec ${cls}` }, h('div', { class: 'wird-sec-head' }, h('span', { class: 'wird-sec-title' }, title), h('span', { class: 'wird-sec-range' }, itemsLabel(items))), chips(app, items), extra);
}

function groupByDate(items: readonly UnitItem[]): UnitItem[][] {
  const map = new Map<string, UnitItem[]>();
  for (const i of items) (map.get(i.taskDate) ?? map.set(i.taskDate, []).get(i.taskDate))?.push(i);
  return [...map.values()];
}

// ------------------------------------------------------------------ the card

export function todayFor(app: App, plan: WirdPlan): PlanDay {
  const today = app.today();
  return planDay(plan, app.data.wird.tasks, today, today);
}

export function planCard(app: App, d: PlanDay, opts: { compact?: boolean } = {}): HTMLElement {
  const plan = d.plan;
  const required = d.required;
  const done = required.filter((u) => u.done).length;
  const open = required.filter((u) => !u.done);
  const head = h('div', { class: 'wird-card-head' }, h('span', { class: 'plan-dot', 'aria-hidden': 'true' }), h('h3', null, plan.name), statusChip(plan.status === 'archived' ? 'archived' : d.status));
  const body: Child[] = [];

  if (d.type === 'paused') {
    const since = plan.pauses.find((p) => p.to === null)?.from ?? d.date;
    body.push(h('p', { class: 'muted' }, t('wird.pausedNote', { date: longDate(since) })));
    if (plan.status === 'paused') body.push(h('button', { type: 'button', onclick: () => void app.act(async () => { await app.s.wird.resume(plan.id); await app.refresh(); }, t('wird.plan.resumed')) }, t('wird.plan.resume')));
    return h('article', { class: `wird-card ${colorClass(plan)} paused` }, head, body);
  }
  if (d.type === 'inactive') {
    body.push(h('p', { class: 'muted' }, t('wird.startsOn', { date: longDate(plan.startDate) })));
    return h('article', { class: `wird-card ${colorClass(plan)} inactive` }, head, body);
  }

  const prompt = app.wirdPrompt && app.wirdPrompt.planId === plan.id ? app.wirdPrompt : null;
  if (prompt) {
    body.push(
      h('div', { class: 'notice info listen-prompt', role: 'status' },
        h('p', null, t('wird.listenPrompt', { range: prompt.label, plan: plan.name })),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'primary', 'data-key': 'wird-listen-done', onclick: () => { app.wirdPrompt = null; void app.act(async () => { await app.s.wird.complete(prompt.refs); await app.refresh(); }, t('wird.allDoneToast')); } }, t('wird.markDone')),
          h('button', { type: 'button', class: 'quiet', onclick: () => { app.wirdPrompt = null; app.render(true); } }, t('wird.dismiss')))),
    );
  }

  const overdueFirst = d.config?.fullDayOverdue === 'overdue_first' || d.type === 'revision';
  const overdueSecs = groupByDate(d.overdue).map((g) => section('overdue', t('wird.overdueFrom', { day: shortDay(g[0]?.taskDate ?? d.date) }), app, g));
  const fullSec = section('full', t('wird.full'), app, d.full);
  const schedSec = section('scheduled', t('wird.scheduled'), app, d.scheduled);
  if (overdueFirst) body.push(...overdueSecs, fullSec, schedSec);
  else body.push(fullSec, ...overdueSecs, schedSec);

  if (d.type === 'rest' && !d.optional.length) body.push(h('p', { class: 'muted rest-note' }, t('wird.restNothing')));
  if (d.optional.length) {
    body.push(h('p', { class: 'muted' }, d.nextEligible ? (d.type === 'rest' ? t('wird.restNext', { day: longDate(d.nextEligible) }) : t('wird.fullOnlyNext', { day: longDate(d.nextEligible) })) : t('wird.optionalOverdue')));
    if (!opts.compact) body.push(section('optional', t('wird.optionalOverdue'), app, d.optional));
  }
  if (d.postponed.length) body.push(section('postponed', t('wird.postponed'), app, d.postponed));
  if (d.spread.length) body.push(h('p', { class: 'muted small' }, tn('wird.spreadLater', d.spread.length)));

  if (required.length) {
    body.push(
      h('div', { class: 'wird-total' },
        h('div', { class: 'row spread' }, h('span', null, t('wird.total', { range: tn('wird.totalUnits', required.length) })), h('strong', null, t('wird.progress', { done: fmtNum(done), total: fmtNum(required.length) }))),
        progressBar(required.length ? done / required.length : 1, plan.name)),
    );
  }

  const actions: Child[] = [];
  if (open.length) actions.push(h('button', { type: 'button', class: 'primary', 'data-key': `wird-all-${plan.id}`, onclick: () => void completeAll(app, open) }, t('wird.markAll')));
  const listenItems = open.length ? open : d.optional.filter((u) => !u.done);
  if (listenItems.length) actions.push(h('button', { type: 'button', onclick: () => listen(app, plan, listenItems) }, t('wird.listen')));
  actions.push(h('button', { type: 'button', class: 'quiet', 'data-key': `wird-details-${plan.id}`, onclick: () => detailsDialog(app, plan.id) }, t('wird.details')));
  body.push(h('div', { class: 'row wird-actions' }, actions));

  const overdueOpen = [...d.overdue, ...d.optional].filter((u) => !u.done).length;
  if (d.config?.carry === 'flexible' && overdueOpen > 1) {
    body.push(h('div', { class: 'spread-offer' }, h('span', { class: 'muted' }, t('wird.spreadOffer')), h('button', { type: 'button', 'data-key': `wird-spread-${plan.id}`, onclick: () => void spreadDialog(app, plan) }, t('wird.spread'))));
  }
  return h('article', { class: `wird-card ${colorClass(plan)} ${d.status}`, 'data-plan': plan.id }, head, body);
}

// ------------------------------------------------------------------ details dialog

function detailRow(app: App, plan: WirdPlan, u: UnitItem, rerender: () => void): HTMLElement {
  const label = unitLabel(u.unit, u.n);
  const box = h('input', { type: 'checkbox', checked: u.done, disabled: !!u.closed, 'aria-label': label });
  box.addEventListener('change', () => void (async () => {
    await toggle(app, u);
    rerender();
  })());
  const quality = h('select', { 'aria-label': t('wird.rate'), disabled: !u.done }, h('option', { value: '' }, t('wird.noQuality')), QUALITIES.map((q) => h('option', { value: q, selected: u.quality === q }, qualityShort(q))));
  quality.addEventListener('change', () => void app.act(async () => {
    await app.s.wird.rate([{ taskId: u.taskId, n: u.n }], (quality.value || null) as Quality | null);
    await app.refresh();
    rerender();
  }));
  const span = ayahSpan(app, u.unit, u.n);
  return h(
    'li',
    { class: `detail-row${u.done ? ' done' : ''}` },
    h('label', { class: 'detail-main' }, box, h('span', null, h('strong', null, label), span ? h('small', { class: 'muted ltr-ref' }, span) : null, u.closed ? h('small', { class: 'muted' }, t(`wird.closed.${u.closed}`)) : null)),
    h('div', { class: 'row detail-actions' },
      quality,
      h('button', { type: 'button', class: 'quiet', onclick: () => listen(app, plan, [u]) }, t('wird.listen')),
      h('a', { class: 'btn quiet', href: `#/quran?${u.unit}=${u.n}` }, t('wird.read')),
      u.quality && isDifficult(u.quality) ? h('button', { type: 'button', class: 'quiet', onclick: () => practise(app, u.unit, u.n) }, t('wird.practise')) : null),
  );
}

export function detailsDialog(app: App, planId: string): void {
  const body = h('div', { class: 'wird-details' });
  let noteTask: string | null = null;
  const note = h('textarea', { rows: 2, maxlength: 2000, 'aria-label': t('wird.taskNote') });
  const render = () => {
    const plan = app.data.wird.plans.find((p) => p.id === planId);
    if (!plan) return;
    const d = todayFor(app, plan);
    const own = app.data.wird.tasks.find((x) => x.planId === planId && x.date === d.date);
    noteTask = own?.id ?? null;
    if (own && document.activeElement !== note) note.value = own.note ?? '';
    const group = (title: string, items: readonly UnitItem[]) => (items.length ? h('section', null, h('h3', null, title), h('ul', { class: 'detail-list' }, items.map((u) => detailRow(app, plan, u, render)))) : null);
    replaceChildren(
      body,
      groupByDate(d.overdue).map((g) => group(t('wird.overdueFrom', { day: shortDay(g[0]?.taskDate ?? d.date) }), g)),
      group(t('wird.full'), d.full),
      group(t('wird.scheduled'), d.scheduled),
      groupByDate(d.optional).map((g) => group(`${t('wird.optionalOverdue')} · ${t('wird.from', { day: shortDay(g[0]?.taskDate ?? d.date) })}`, g)),
      group(t('wird.postponed'), d.postponed),
      noteTask ? h('label', { class: 'field', style: { 'margin-top': '0.75rem' } }, h('span', null, t('wird.taskNote')), note) : null,
    );
  };
  render();
  const plan = app.data.wird.plans.find((p) => p.id === planId);
  openDialog({
    title: t('wird.detailsTitle', { plan: plan?.name ?? '', date: longDate(app.today()) }),
    body,
    actions: (close) => [
      h('button', {
        type: 'button',
        class: 'primary',
        onclick: () => {
          const id = noteTask;
          const own = app.data.wird.tasks.find((x) => x.id === id);
          close();
          if (id && (own?.note ?? '') !== note.value.trim()) void app.act(async () => { await app.s.wird.setNote(id, note.value); await app.refresh(); }, t('wird.noteSaved'));
        },
      }, t('common.close')),
    ],
  });
}

/** Cards of every active plan for today (dashboard and the Wird "Today" tab). */
export function todaySection(app: App, opts: { compact?: boolean; includePaused?: boolean } = {}): HTMLElement {
  const plans = app.data.wird.plans.filter((p) => p.status === 'active' || (opts.includePaused && p.status === 'paused'));
  const title = h('h2', { id: 'wird-today-title', style: { margin: '0' } }, t('wird.todayTitle', { day: longDate(app.today()) }));
  if (!app.data.wird.plans.length) {
    return h('section', { class: 'panel hero wird-today', 'aria-labelledby': 'wird-today-title' }, title, h('p', { class: 'muted' }, t('wird.noPlans')), h('a', { class: 'btn primary big', href: '#/wird?tab=plans&edit=new', 'data-key': 'wird-create' }, t('wird.create')));
  }
  if (!plans.length) {
    return h('section', { class: 'panel hero wird-today', 'aria-labelledby': 'wird-today-title' }, title, h('p', { class: 'muted' }, t('wird.noActive')), h('a', { class: 'btn', href: '#/wird?tab=plans' }, t('wird.tab.plans')));
  }
  return h('section', { class: 'wird-today', 'aria-labelledby': 'wird-today-title' }, h('div', { class: 'row spread wird-today-head' }, title, opts.compact ? h('a', { href: '#/wird' }, t('wird.title')) : null), h('div', { class: 'wird-cards' }, plans.map((p) => planCard(app, todayFor(app, p), opts))));
}
