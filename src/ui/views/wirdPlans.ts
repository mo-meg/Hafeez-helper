/** Wird Planner: list of plans and the plan editor (create / edit with live weekly preview). */
import { isDateKey, orderedWeekdays, shiftDate, weekdayOf, WEEKDAYS, type Weekday } from '../../core/wird/dates.ts';
import { autoWeeklyRanges, checkManual } from '../../core/wird/distribution.ts';
import { currentConfig, type ConfigInput } from '../../core/wird/engine.ts';
import { CARRY_MODES, FULL_DAY_OVERDUE, type CarryMode, type FullDayOverdue, type WirdPlan } from '../../core/wird/model.ts';
import { UNIT_COUNT, WIRD_UNITS, type WirdUnit } from '../../core/wird/units.ts';
import { WirdError } from '../../core/wird/wirdService.ts';
import type { App } from '../app.ts';
import { confirmDialog } from '../components/dialog.ts';
import { h, replaceChildren, type Child } from '../dom.ts';
import { fmtDateKey, fmtList, fmtNum, t, tn } from '../i18n/index.ts';
import { errorText, kindName } from '../i18n/labels.ts';
import { colorClass, equivalents, rangeLabel, statusChip, weekdayName, wirdHref } from './wirdCard.ts';

type DayKind = 'rev' | 'full' | 'rest';

interface Draft {
  name: string;
  color: number;
  startDate: string;
  unit: WirdUnit;
  from: number;
  to: number;
  days: Record<Weekday, DayKind>;
  weekStart: Weekday;
  cycle: 'weekly' | 'daily';
  distribution: 'auto' | 'manual';
  manual: Partial<Record<Weekday, { from: number; to: number }>>;
  allowGaps: boolean;
  dailyAmount: number;
  startAt: number;
  targetDate: string;
  carry: CarryMode;
  fullDayOverdue: FullDayOverdue;
}

/** The open editor survives in-place re-renders (e.g. a background sync), keyed by plan id or 'new'. */
let editing: { key: string; draft: Draft } | null = null;

function newDraft(app: App): Draft {
  const used = new Set(app.data.wird.plans.map((p) => p.color));
  return {
    name: '',
    color: [0, 1, 2, 3, 4, 5, 6, 7].find((c) => !used.has(c)) ?? 0,
    startDate: app.today(),
    unit: 'hizb',
    from: 1,
    to: 10,
    days: { 0: 'rev', 1: 'rev', 2: 'rev', 3: 'rev', 4: 'rev', 5: 'full', 6: 'rest' },
    weekStart: 6,
    cycle: 'weekly',
    distribution: 'auto',
    manual: {},
    allowGaps: false,
    dailyAmount: 2,
    startAt: 1,
    targetDate: '',
    carry: 'strict',
    fullDayOverdue: 'full_plus_overdue',
  };
}

function draftOf(app: App, plan: WirdPlan): Draft {
  const c = currentConfig(plan, app.today());
  const days = {} as Record<Weekday, DayKind>;
  for (const d of WEEKDAYS) days[d] = c.revisionDays.includes(d) ? 'rev' : c.fullDays.includes(d) ? 'full' : 'rest';
  const manual: Draft['manual'] = {};
  for (const r of c.manual) manual[r.day] = { from: r.from, to: r.to };
  return { name: plan.name, color: plan.color, startDate: plan.startDate, unit: c.unit, from: c.from, to: c.to, days, weekStart: c.weekStart, cycle: c.cycle, distribution: c.distribution, manual, allowGaps: c.allowGaps, dailyAmount: c.dailyAmount, startAt: c.from + c.startOffset, targetDate: c.targetDate ?? '', carry: c.carry, fullDayOverdue: c.fullDayOverdue };
}

const revisionDays = (d: Draft) => WEEKDAYS.filter((w) => d.days[w] === 'rev');
const fullDays = (d: Draft) => WEEKDAYS.filter((w) => d.days[w] === 'full');

function configOf(d: Draft, isNew: boolean): ConfigInput {
  const rev = revisionDays(d);
  const manual = orderedWeekdays(rev, d.weekStart).flatMap((day) => {
    const r = d.manual[day];
    return r ? [{ day, from: r.from, to: r.to }] : [];
  });
  return {
    unit: d.unit,
    from: d.from,
    to: d.to,
    revisionDays: rev,
    fullDays: fullDays(d),
    weekStart: d.weekStart,
    cycle: d.cycle,
    distribution: d.distribution,
    manual,
    allowGaps: d.allowGaps,
    dailyAmount: d.dailyAmount,
    ...(isNew && d.cycle === 'daily' ? { startOffset: Math.max(0, Math.min(d.to - d.from, d.startAt - d.from)) } : {}),
    targetDate: d.cycle === 'daily' && d.targetDate ? d.targetDate : null,
    carry: d.carry,
    fullDayOverdue: d.fullDayOverdue,
  };
}

/** Fills missing manual ranges from the balanced split. */
function fillManual(d: Draft): void {
  for (const r of autoWeeklyRanges({ from: d.from, to: d.to, revisionDays: revisionDays(d), weekStart: d.weekStart })) if (!d.manual[r.day]) d.manual[r.day] = { from: r.from, to: r.to };
}

function errorMessage(e: unknown, d: Draft): string {
  if (e instanceof WirdError) {
    if (e.code.startsWith('range')) return t('wird.err.range', { max: UNIT_COUNT[d.unit] });
    if (e.code.startsWith('days')) return t('wird.err.days');
    if (e.code.startsWith('manual')) return t('wird.err.manual');
    if (e.code === 'name') return t('wird.err.name');
    if (e.code === 'date') return t('wird.err.date');
    if (e.code === 'amount') return t('wird.err.amount');
  }
  return errorText(e);
}

// ------------------------------------------------------------------ editor

const num = (value: number, min: number, max: number, onInput: (v: number) => void, label: string) =>
  h('input', { type: 'number', min, max, value: String(value), inputmode: 'numeric', 'aria-label': label, oninput: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); if (Number.isInteger(v)) onInput(v); } });

function radios<T extends string>(name: string, value: T, options: ReadonlyArray<{ value: T; label: string; help?: string }>, onChange: (v: T) => void): HTMLElement {
  return h('div', { class: 'radio-list', role: 'radiogroup' }, options.map((o) => h('label', { class: 'radio-opt' }, h('input', { type: 'radio', name, value: o.value, checked: o.value === value, onchange: () => onChange(o.value) }), h('span', null, h('strong', null, o.label), o.help ? h('small', { class: 'muted' }, o.help) : null))));
}

function editor(app: App, plan: WirdPlan | null): HTMLElement {
  const key = plan?.id ?? 'new';
  if (!editing || editing.key !== key) editing = { key, draft: plan ? draftOf(app, plan) : newDraft(app) };
  const d = editing.draft;
  const isNew = !plan;
  const notStarted = !plan || plan.startDate > app.today();
  const error = h('p', { class: 'form-error', role: 'alert' });
  const dynamic = h('div', { class: 'stack' });
  const equiv = h('p', { class: 'muted small' });

  const refresh = () => {
    const eq = d.from <= d.to && d.to <= UNIT_COUNT[d.unit] && d.from >= 1 ? equivalents(d.unit, d.from, d.to) : null;
    equiv.textContent = eq ?? '';
    replaceChildren(dynamic, cyclePart(app, d, isNew, refresh));
  };

  const unitSel = h('select', { 'aria-label': t('wird.ed.unit'), onchange: (e: Event) => { d.unit = (e.target as HTMLSelectElement).value as WirdUnit; const max = UNIT_COUNT[d.unit]; d.from = Math.min(d.from, max); d.to = Math.min(d.to, max); d.manual = {}; rebuild(); } }, WIRD_UNITS.map((u) => h('option', { value: u, selected: u === d.unit }, kindName(u))));
  const dayRows = h('div', { class: 'day-kinds' }, orderedWeekdays(WEEKDAYS, d.weekStart).map((w) =>
    h('label', { class: `day-kind ${d.days[w]}` }, h('span', null, weekdayName(w)), h('select', { 'aria-label': weekdayName(w), onchange: (e: Event) => { d.days[w] = (e.target as HTMLSelectElement).value as DayKind; (e.target as HTMLElement).parentElement?.setAttribute('class', `day-kind ${d.days[w]}`); fillManual(d); refresh(); } },
      (['rev', 'full', 'rest'] as const).map((k) => h('option', { value: k, selected: d.days[w] === k }, t(k === 'rev' ? 'wird.ed.dayRevision' : k === 'full' ? 'wird.ed.dayFull' : 'wird.ed.dayRest')))))));

  const save = async () => {
    error.textContent = '';
    const input = { name: d.name, color: d.color, startDate: d.startDate, config: configOf(d, isNew) };
    try {
      if (!isDateKey(d.startDate)) throw new WirdError('date', 'bad date');
      if (plan) {
        const r = await app.s.wird.updatePlan(plan.id, input);
        editing = null;
        await app.refresh();
        app.toast(r.effectiveFrom > app.today() || plan.startDate <= app.today() ? t('wird.plan.savedFrom', { date: fmtDateKey(r.effectiveFrom) }) : t('wird.plan.saved'));
      } else {
        await app.s.wird.createPlan(input);
        editing = null;
        await app.refresh();
        app.toast(t('wird.plan.saved'));
      }
      app.navigate(wirdHref({ tab: plan ? 'plans' : 'today' }));
    } catch (e) {
      error.textContent = errorMessage(e, d);
    }
  };

  const root = h('section', { class: 'panel wird-editor', 'aria-labelledby': 'wird-ed-title' });
  function rebuild() {
    replaceChildren(root,
      h('h2', { id: 'wird-ed-title' }, plan ? t('wird.ed.titleEdit', { name: plan.name }) : t('wird.ed.titleNew')),
      h('div', { class: 'fields' },
        h('label', { class: 'field' }, h('span', null, t('wird.ed.name')), h('input', { type: 'text', value: d.name, maxlength: 80, placeholder: t('wird.ed.namePlaceholder'), 'data-key': 'wird-name', oninput: (e: Event) => { d.name = (e.target as HTMLInputElement).value; } })),
        notStarted ? h('label', { class: 'field' }, h('span', null, t('wird.ed.startDate')), h('input', { type: 'date', value: d.startDate, oninput: (e: Event) => { d.startDate = (e.target as HTMLInputElement).value; refresh(); } })) : null),
      h('fieldset', { class: 'color-pick' }, h('legend', null, t('wird.ed.color')), [0, 1, 2, 3, 4, 5, 6, 7].map((c) => h('label', { class: `wc-${c}` }, h('input', { type: 'radio', name: 'wird-color', value: String(c), checked: d.color === c, 'aria-label': t('wird.ed.colorN', { n: c + 1 }), onchange: () => { d.color = c; } }), h('span', { class: 'swatch plan-swatch' })))),
      h('fieldset', null, h('legend', null, t('wird.plan.range')),
        h('div', { class: 'row', style: { 'align-items': 'flex-end' } },
          h('label', { class: 'field' }, h('span', null, t('wird.ed.unit')), unitSel),
          h('label', { class: 'field' }, h('span', null, t('wird.ed.from')), num(d.from, 1, UNIT_COUNT[d.unit], (v) => { d.from = v; d.manual = {}; fillManual(d); refresh(); }, t('wird.ed.from'))),
          h('label', { class: 'field' }, h('span', null, t('wird.ed.to')), num(d.to, 1, UNIT_COUNT[d.unit], (v) => { d.to = v; d.manual = {}; fillManual(d); refresh(); }, t('wird.ed.to')))),
        equiv),
      h('fieldset', null, h('legend', null, t('wird.ed.days')),
        h('label', { class: 'field inline' }, h('span', null, t('wird.ed.weekStart')), h('select', { onchange: (e: Event) => { d.weekStart = Number((e.target as HTMLSelectElement).value) as Weekday; d.manual = {}; fillManual(d); rebuild(); } }, WEEKDAYS.map((w) => h('option', { value: String(w), selected: w === d.weekStart }, weekdayName(w))))),
        dayRows),
      dynamic,
      h('fieldset', null, h('legend', null, t('wird.ed.carry')),
        radios('wird-carry', d.carry, CARRY_MODES.map((m) => ({ value: m, label: t(`wird.ed.carry.${m}`), help: t(`wird.ed.carry.${m}Help` as 'wird.ed.carry.strictHelp') })), (v) => { d.carry = v; })),
      plan && !notStarted ? h('p', { class: 'notice info' }, t('wird.ed.appliesFrom', { date: fmtDateKey(app.data.wird.tasks.some((x) => x.planId === plan.id && x.units.some((u) => u.doneOn === app.today())) ? shiftDate(app.today(), 1) : app.today()) })) : null,
      error,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', 'data-key': 'wird-save', onclick: () => void save() }, t('wird.ed.save')),
        h('a', { class: 'btn', href: wirdHref({ tab: 'plans' }), onclick: () => { editing = null; } }, t('common.cancel'))),
    );
    refresh();
  }
  rebuild();
  return root;
}

/** Cycle, workload preview / manual ranges, fixed-daily projection and full-day behaviour. */
function cyclePart(app: App, d: Draft, isNew: boolean, refresh: () => void): Child {
  const rev = orderedWeekdays(revisionDays(d), d.weekStart);
  const parts: Child[] = [
    h('fieldset', null, h('legend', null, t('wird.ed.cycle')),
      radios('wird-cycle', d.cycle, [{ value: 'weekly', label: t('wird.ed.cycleWeekly'), help: t('wird.ed.cycleWeeklyHelp') }, { value: 'daily', label: t('wird.ed.cycleDaily'), help: t('wird.ed.cycleDailyHelp') }], (v) => { d.cycle = v; refresh(); })),
  ];
  const valid = d.from >= 1 && d.to <= UNIT_COUNT[d.unit] && d.from <= d.to;
  if (d.cycle === 'weekly') {
    const body: Child[] = [radios('wird-dist', d.distribution, [{ value: 'auto', label: t('wird.ed.auto') }, { value: 'manual', label: t('wird.ed.manual') }], (v) => { d.distribution = v; if (v === 'manual') fillManual(d); refresh(); })];
    if (valid && d.distribution === 'auto') {
      const ranges = autoWeeklyRanges({ from: d.from, to: d.to, revisionDays: rev, weekStart: d.weekStart });
      body.push(h('table', { class: 'week-preview' }, h('caption', null, t('wird.ed.preview')), h('tbody', null, orderedWeekdays(WEEKDAYS, d.weekStart).map((w) => {
        const r = ranges.find((x) => x.day === w);
        const kind = d.days[w];
        return h('tr', { class: kind }, h('th', { scope: 'row' }, weekdayName(w)), h('td', null, kind === 'rest' ? t('wird.plan.rest') : kind === 'full' ? t('wird.fullOf', { range: rangeLabel(d.unit, [d.from, d.to]) }) : r ? rangeLabel(d.unit, [r.from, r.to]) : '—'), h('td', { class: 'num' }, r ? fmtNum(r.to - r.from + 1) : ''));
      }))));
    } else if (valid) {
      const check = checkManual({ from: d.from, to: d.to, revisionDays: rev, manual: rev.flatMap((day) => (d.manual[day] ? [{ day, ...(d.manual[day] as { from: number; to: number }) }] : [])) });
      body.push(h('div', { class: 'manual-rows' }, rev.map((w) => {
        const r = d.manual[w] ?? { from: d.from, to: d.from };
        return h('div', { class: 'row manual-row' }, h('strong', null, weekdayName(w)),
          num(r.from, d.from, d.to, (v) => { d.manual[w] = { ...r, from: v }; refresh(); }, `${weekdayName(w)} ${t('wird.ed.from')}`), '–',
          num(r.to, d.from, d.to, (v) => { d.manual[w] = { ...r, to: v }; refresh(); }, `${weekdayName(w)} ${t('wird.ed.to')}`),
          h('span', { class: 'muted' }, fmtNum(Math.max(0, r.to - r.from + 1))));
      })));
      const msgs: string[] = [];
      if (check.missing.length) msgs.push(t('wird.ed.missing', { list: rangeLabel(d.unit, check.missing) }));
      if (check.duplicated.length) msgs.push(t('wird.ed.duplicated', { list: rangeLabel(d.unit, check.duplicated) }));
      if (check.invalid.length) msgs.push(t('wird.ed.invalidRanges'));
      if (check.emptyDays.length) msgs.push(t('wird.ed.emptyDays'));
      if (msgs.length) body.push(h('div', { class: 'notice warn' }, msgs.map((m) => h('p', null, m))));
      if (check.missing.length || check.duplicated.length) body.push(h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.allowGaps, onchange: (e: Event) => { d.allowGaps = (e.target as HTMLInputElement).checked; } }), h('span', null, t('wird.ed.allowGaps'))));
    }
    parts.push(h('fieldset', null, h('legend', null, t('wird.ed.distribution')), body));
  } else {
    const length = d.to - d.from + 1;
    const fields: Child[] = [h('label', { class: 'field' }, h('span', null, t('wird.ed.amount')), num(d.dailyAmount, 1, Math.max(1, length), (v) => { d.dailyAmount = v; refresh(); }, t('wird.ed.amount')))];
    if (isNew) fields.push(h('label', { class: 'field' }, h('span', null, t('wird.ed.startAt')), num(d.startAt, d.from, d.to, (v) => { d.startAt = v; }, t('wird.ed.startAt'))));
    fields.push(h('label', { class: 'field' }, h('span', null, t('wird.ed.target')), h('input', { type: 'date', value: d.targetDate, oninput: (e: Event) => { d.targetDate = (e.target as HTMLInputElement).value; refresh(); } })));
    const proj: Child[] = [];
    if (valid && rev.length && d.dailyAmount >= 1) {
      const needed = Math.ceil(length / Math.min(d.dailyAmount, length));
      const from = d.startDate > app.today() ? d.startDate : app.today();
      const isRev = (k: string) => rev.includes(weekdayOf(k));
      let date = from;
      for (let n = 0, i = 0; i < 3660; i++, date = shiftDate(date, 1)) if (isRev(date) && ++n === needed) break;
      proj.push(t('wird.ed.projection', { days: fmtNum(needed), date: fmtDateKey(date) }));
      if (d.targetDate && isDateKey(d.targetDate)) {
        let avail = 0;
        for (let k = from; k <= d.targetDate; k = shiftDate(k, 1)) if (isRev(k)) avail++;
        proj.push(' ', date <= d.targetDate ? t('wird.ed.targetOk') : t('wird.ed.targetLate', { amount: fmtNum(Math.ceil(length / Math.max(1, avail))) }));
      }
    }
    parts.push(h('fieldset', null, h('legend', null, t('wird.ed.distribution')), h('div', { class: 'fields' }, fields), proj.length ? h('p', { class: 'muted' }, proj) : null));
  }
  if (fullDays(d).length) {
    parts.push(h('fieldset', null, h('legend', null, t('wird.ed.fullOverdue')), radios('wird-fullod', d.fullDayOverdue, FULL_DAY_OVERDUE.map((v) => ({ value: v, label: t(`wird.ed.fullOverdue.${v}`) })), (v) => { d.fullDayOverdue = v; })));
  }
  return parts;
}

// ------------------------------------------------------------------ list

function planSummary(app: App, plan: WirdPlan): HTMLElement {
  const c = currentConfig(plan, app.today());
  const eq = equivalents(c.unit, c.from, c.to);
  const days = (list: readonly Weekday[]) => fmtList(orderedWeekdays(list, c.weekStart).map(weekdayName));
  const rest = WEEKDAYS.filter((w) => !c.revisionDays.includes(w) && !c.fullDays.includes(w));
  const act = (fn: () => Promise<unknown>, msg: string) => () => void app.act(async () => { await fn(); await app.refresh(); }, msg);
  const buttons: Child[] = [h('a', { class: 'btn', href: wirdHref({ tab: 'plans', edit: plan.id }), 'data-key': `wird-edit-${plan.id}` }, t('wird.plan.edit'))];
  if (plan.status === 'active') buttons.push(h('button', { type: 'button', onclick: act(() => app.s.wird.pause(plan.id), t('wird.plan.paused')) }, t('wird.plan.pause')));
  if (plan.status === 'paused') buttons.push(h('button', { type: 'button', onclick: act(() => app.s.wird.resume(plan.id), t('wird.plan.resumed')) }, t('wird.plan.resume')));
  if (plan.status !== 'archived') buttons.push(h('button', { type: 'button', class: 'quiet', onclick: act(() => app.s.wird.archive(plan.id), t('wird.plan.archived')) }, t('wird.plan.archive')));
  else buttons.push(h('button', { type: 'button', onclick: act(() => app.s.wird.resume(plan.id), t('wird.plan.resumed')) }, t('wird.plan.restore')));
  buttons.push(h('button', {
    type: 'button',
    class: 'quiet danger',
    onclick: async () => {
      if (!(await confirmDialog(t('wird.plan.deleteTitle', { name: plan.name }), t('wird.plan.deleteBody'), t('wird.plan.delete'), true))) return;
      await act(() => app.s.wird.deletePlan(plan.id), t('wird.plan.deleted'))();
    },
  }, t('wird.plan.delete')));
  return h('article', { class: `panel plan-summary ${colorClass(plan)}` },
    h('div', { class: 'wird-card-head' }, h('span', { class: 'plan-dot', 'aria-hidden': 'true' }), h('h3', null, plan.name), statusChip(plan.status)),
    h('dl', { class: 'plan-facts' },
      h('dt', null, t('wird.plan.range')), h('dd', null, rangeLabel(c.unit, [c.from, c.to]), eq ? h('small', { class: 'muted' }, ' · ', eq) : null),
      h('dt', null, t('wird.plan.days')), h('dd', null, days(c.revisionDays), ' · ', c.cycle === 'weekly' ? t('wird.plan.cycleWeekly') : t('wird.plan.cycleDaily', { count: tn('wird.totalUnits', c.dailyAmount) })),
      c.fullDays.length ? [h('dt', null, t('wird.plan.fullDay')), h('dd', null, days(c.fullDays))] : null,
      rest.length ? [h('dt', null, t('wird.plan.rest')), h('dd', null, days(rest))] : null,
      h('dt', null, t('wird.plan.mode')), h('dd', null, t(`wird.ed.carry.${c.carry}`))),
    h('div', { class: 'row' }, buttons));
}

export function plansTab(app: App): HTMLElement {
  const edit = app.route.params.get('edit');
  if (edit) {
    const plan = edit === 'new' ? null : app.data.wird.plans.find((p) => p.id === edit) ?? null;
    if (edit === 'new' || plan) return editor(app, plan);
  }
  editing = null;
  const live = app.data.wird.plans.filter((p) => p.status !== 'archived');
  const archived = app.data.wird.plans.filter((p) => p.status === 'archived');
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('a', { class: 'btn primary', href: wirdHref({ tab: 'plans', edit: 'new' }), 'data-key': 'wird-new' }, t('wird.newPlan'))),
    live.length ? live.map((p) => planSummary(app, p)) : h('p', { class: 'muted' }, t('wird.noPlans')),
    archived.length ? h('details', { class: 'panel fold' }, h('summary', null, h('h2', null, t('wird.plan.archivedList'))), h('div', { class: 'fold-body stack' }, archived.map((p) => planSummary(app, p)))) : null,
  );
}
