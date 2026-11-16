import {
  expandTemplate,
  makePeriodPlan,
  parseDateKey,
  periodDates,
  periodProgress,
  shiftDateKey,
  type DayProgress,
  type DayStatus,
  type PeriodPlan,
  type PeriodProgress,
  type PlanPeriod,
} from '../../core/plan/periodPlan.ts';
import { scopeIntervals, type RevisionScope } from '../../core/quran/scope.ts';
import type { App } from '../app.ts';
import { confirmDialog, openDialog } from '../components/dialog.ts';
import { scopePicker, type ScopePicker } from '../components/scopePicker.ts';
import { h, replaceChildren } from '../dom.ts';
import { fmtDateKey, fmtNum, t, tn } from '../i18n/index.ts';
import { errorText, scopeLabel } from '../i18n/labels.ts';
import { sessionConfigFor } from './revision.ts';

/** Progress of the plan in preferences, or null when none is set. */
export function currentPeriod(app: App): PeriodProgress | null {
  const plan = app.prefs.periodPlan;
  if (!plan) return null;
  return periodProgress(plan, app.data.plans, app.data.sessions, app.data.reviews, app.quran.index, app.now());
}

const pct = (f: number) => Math.round(f * 100);
const weekday = (date: string, style: 'short' | 'long' = 'short') => fmtDateKey(date, { weekday: style });
const dayTitle = (date: string) => fmtDateKey(date, { weekday: 'long', day: 'numeric', month: 'long' });

export function progressBar(fraction: number, label: string): HTMLElement {
  const p = pct(fraction);
  return h('div', { class: 'progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(p), 'aria-label': label }, h('span', { style: { width: `${p}%` } }));
}

const statusText = (s: DayStatus) => t(`pp.status.${s}`);

/** Starts revising a planned day: today goes to the Revision page; other days open a full listening session. */
function reviseDay(app: App, d: DayProgress): void {
  if (!d.scope) return;
  if (d.date === app.today()) app.navigate('#/revision');
  else app.prepare(sessionConfigFor(app, d.scope, 'full', d.planId));
}

/** Choosing a portion or a rest day (one row of the editor, or the single-day dialog). */
function dayChooser(app: App, scope: RevisionScope | null, idPrefix: string, isRest = !scope): { el: HTMLElement; picker: ScopePicker; rest: HTMLInputElement; read(): { scope: RevisionScope | null } | { error: string } } {
  const picker = scopePicker(app.quran.index, scope, { idPrefix });
  const rest = h('input', { type: 'checkbox', id: `${idPrefix}-rest`, checked: isRest, onchange: () => { picker.el.hidden = rest.checked; } });
  picker.el.hidden = rest.checked;
  return {
    el: h('div', null, h('label', { class: 'choice', style: { margin: '0 0 0.35rem' } }, rest, h('span', null, t('pp.rest'))), picker.el),
    picker,
    rest,
    read() {
      if (rest.checked) return { scope: null };
      const r = picker.read();
      if ('error' in r) return r;
      try {
        scopeIntervals(r.scope, app.quran.index);
      } catch (e) {
        return { error: errorText(e) };
      }
      return r;
    },
  };
}

/** Dialog for one day: progress, catch-up, and changing the portion of today or an upcoming day. */
function openDay(app: App, d: DayProgress): void {
  const editable = d.date >= app.today();
  const chooser = editable ? dayChooser(app, d.scope, `pd-${d.date}`) : null;
  const error = h('p', { role: 'alert', style: { color: 'var(--mistake)' } });
  openDialog({
    title: dayTitle(d.date),
    body: h(
      'div',
      null,
      h('p', null, h('span', { class: `chip day-chip ${d.status}` }, statusText(d.status)), ' ', h('strong', null, d.scope ? scopeLabel(d.scope, app.quran.index) : t('pp.rest'))),
      d.scope ? [progressBar(d.fraction, dayTitle(d.date)), h('p', { class: 'muted' }, t('pp.dayProgress', { covered: fmtNum(d.coveredAyat), total: fmtNum(d.totalAyat), percent: pct(d.fraction) }))] : null,
      d.status === 'missed' ? h('p', { class: 'muted' }, t('pp.catchUpHelp')) : null,
      chooser ? h('div', { style: { 'margin-top': '0.75rem' } }, h('h3', null, t('pp.editDay')), chooser.el, error) : h('p', { class: 'muted' }, t('pp.pastDay')),
    ),
    actions: (close) => [
      h('button', { type: 'button', onclick: close }, t('common.close')),
      d.scope && d.status !== 'upcoming' && d.status !== 'done' ? h('button', { type: 'button', class: chooser ? '' : 'primary', onclick: () => { close(); reviseDay(app, d); } }, t('pp.reviseNow')) : null,
      chooser
        ? h('button', {
            type: 'button',
            class: 'primary',
            onclick: () => {
              const r = chooser.read();
              if ('error' in r) {
                error.textContent = r.error;
                return;
              }
              close();
              void app.act(async () => {
                await app.s.plans.applySchedule([{ date: d.date, scope: r.scope }]);
                await app.refresh();
              }, t('pp.daySaved'));
            },
          }, t('pp.saveDay'))
        : null,
    ],
  });
}

function dayCell(app: App, d: DayProgress, compact: boolean): HTMLElement {
  const date = Number(d.date.slice(8));
  const portion = d.scope ? scopeLabel(d.scope, app.quran.index) : t('pp.rest');
  return h(
    'button',
    {
      type: 'button',
      class: `day ${d.status}`,
      'aria-label': `${dayTitle(d.date)}: ${portion}, ${statusText(d.status)}${d.scope ? `, ${pct(d.fraction)}%` : ''}`,
      title: portion,
      onclick: () => openDay(app, d),
    },
    h('span', { class: 'day-head' }, compact ? fmtNum(date) : `${weekday(d.date)} ${fmtNum(date)}`),
    h('span', { class: 'day-portion' }, portion),
    d.scope ? h('span', { class: 'day-foot' }, d.status !== 'upcoming' ? `${fmtNum(pct(d.fraction))}%` : statusText(d.status)) : null,
    d.scope ? h('span', { class: 'day-bar' }, h('span', { style: { width: `${pct(d.fraction)}%` } })) : null,
  );
}

function legend(): HTMLElement {
  return h('div', { class: 'chips day-legend', 'aria-hidden': 'true' }, (['done', 'today', 'missed', 'upcoming', 'rest'] as const).map((s) => h('span', { class: `chip day-chip ${s}` }, statusText(s))));
}

/** The calendar of the plan: one cell per day, weeks as rows. */
function dayGrid(app: App, p: PeriodProgress): HTMLElement {
  const compact = p.plan.period === 'month';
  const head = compact ? p.days.slice(0, 7).map((d) => h('span', { class: 'day-name' }, weekday(d.date))) : [];
  return h('div', { class: `plan-days ${p.plan.period}` }, head, p.days.map((d) => dayCell(app, d, compact)));
}

/** The week/month plan editor: a weekly pattern of portions and rest days. */
function editor(app: App, mode: { kind: 'new'; period: PlanPeriod } | { kind: 'edit'; plan: PeriodPlan }, onCancel: () => void): HTMLElement {
  const today = app.today();
  const editing = mode.kind === 'edit';
  let period: PlanPeriod = editing ? mode.plan.period : mode.period;
  const start = h('input', { type: 'date', id: 'pp-start', value: editing ? mode.plan.start : today, min: today, disabled: editing, onchange: () => relabel() });
  const periodSel = h('select', { id: 'pp-period', disabled: editing, onchange: () => { period = periodSel.value as PlanPeriod; help.textContent = t(`pp.editorHelp.${period}`); relabel(); } }, (['week', 'month'] as const).map((k) => h('option', { value: k, selected: k === period }, t(`pp.${k}`))));
  const help = h('p', { class: 'muted' }, t(`pp.editorHelp.${period}`));
  const error = h('p', { role: 'alert', style: { color: 'var(--mistake)' } });

  // When editing, each row starts from the next upcoming date with that weekday.
  const existing = (offset: number): RevisionScope | null => {
    if (!editing) return null;
    const dates = periodDates(mode.plan).filter((_, i) => i % 7 === offset);
    const date = dates.find((x) => x >= today) ?? dates[dates.length - 1];
    return app.data.plans.find((p) => p.kind === 'revision' && p.date === date)?.scope ?? null;
  };
  const rowLabels: HTMLElement[] = [];
  const rows = Array.from({ length: 7 }, (_, i) => {
    const initial = existing(i);
    const chooser = dayChooser(app, initial, `pp-row${i}`, editing && !initial);
    const label = h('strong', null);
    rowLabels.push(label);
    const copy = h('button', {
      type: 'button',
      class: 'quiet',
      onclick: () => {
        const r = chooser.read();
        for (const other of rows.slice(i + 1)) {
          other.rest.checked = 'scope' in r ? r.scope === null : chooser.rest.checked;
          other.picker.el.hidden = other.rest.checked;
          if ('scope' in r && r.scope) other.picker.set(r.scope);
        }
      },
    }, t('pp.copyDown'));
    return { ...chooser, row: h('div', { class: 'plan-row' }, h('div', { class: 'row spread' }, label, i < 6 ? copy : null), chooser.el) };
  });
  // A week that is already under way: its passed days can no longer be changed.
  const passed = (i: number) => editing && mode.plan.period === 'week' && shiftDateKey(mode.plan.start, i) < today;
  rows.forEach((r, i) => { r.row.hidden = passed(i); });
  function relabel() {
    const s = /^\d{4}-\d{2}-\d{2}$/.test(start.value) && !Number.isNaN(parseDateKey(start.value).getTime()) ? start.value : today;
    rows.forEach((_, i) => {
      const key = shiftDateKey(s, i);
      (rowLabels[i] as HTMLElement).textContent = period === 'week' ? dayTitle(key) : weekday(key, 'long');
    });
  }
  relabel();

  const save = async () => {
    error.textContent = '';
    const template: Array<RevisionScope | null> = [];
    for (const [i, r] of rows.entries()) {
      if (passed(i)) {
        template.push(null);
        continue;
      }
      const res = r.read();
      if ('error' in res) {
        error.textContent = t('pp.rowError', { day: rowLabels[i]?.textContent ?? '', error: res.error });
        return;
      }
      template.push(res.scope);
    }
    if (template.every((s) => s === null)) {
      error.textContent = t('pp.allRest');
      return;
    }
    const s = start.value;
    if (!editing && (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s < today)) {
      error.textContent = t('pp.startError');
      return;
    }
    const plan = editing ? mode.plan : makePeriodPlan(period, s);
    const days = expandTemplate(plan, template).filter((d) => d.date >= today);
    await app.act(async () => {
      await app.s.plans.applySchedule(days);
      await app.savePrefs({ ...app.prefs, periodPlan: plan });
      openEditor = null;
      await app.refresh();
    }, t('pp.saved'));
  };

  return h(
    'div',
    { class: 'plan-editor' },
    editing ? null : h('div', { class: 'row', style: { 'align-items': 'flex-end' } }, h('label', { class: 'field' }, h('span', null, t('pp.length')), periodSel), h('label', { class: 'field' }, h('span', null, t('pp.startDate')), start)),
    help,
    h('div', { class: 'plan-rows' }, rows.map((r) => r.row)),
    error,
    h('div', { class: 'row', style: { 'margin-top': '0.75rem' } }, h('button', { type: 'button', class: 'primary', 'data-key': 'pp-save', onclick: () => void save() }, t('pp.save')), h('button', { type: 'button', onclick: onCancel }, t('common.cancel'))),
  );
}

/**
 * The open editor survives in-place re-renders (e.g. a background sync refreshing the dashboard),
 * so what the user typed is not lost. Entering the dashboard afresh starts without it.
 */
let openEditor: HTMLElement | null = null;

export interface PeriodPanel {
  readonly el: HTMLElement;
  /** Opens the editor for a new plan (from the Today's goal card). */
  openNew(period: PlanPeriod): void;
}

/** Dashboard panel: the plan's calendar and overall progress, or the invitation to set one. */
export function periodPanel(app: App, p: PeriodProgress | null): PeriodPanel {
  const active = p && !p.finished ? p : null;
  const body = h('div');
  const el = h('section', { class: 'panel', id: 'period-plan', 'aria-labelledby': 'pp-title' });
  const title = h('h2', { id: 'pp-title', style: { margin: '0' } }, active ? t(`pp.title.${active.plan.period}`) : t('pp.title'));

  const showEditor = (mode: Parameters<typeof editor>[1]) => {
    openEditor = editor(app, mode, () => {
      openEditor = null;
      showSummary();
    });
    replaceChildren(body, openEditor);
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const newButtons = () => h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', 'data-key': 'pp-new-week', onclick: () => showEditor({ kind: 'new', period: 'week' }) }, t('pp.newWeek')), h('button', { type: 'button', onclick: () => showEditor({ kind: 'new', period: 'month' }) }, t('pp.newMonth')));

  function showSummary() {
    if (!p) {
      replaceChildren(body, h('p', { class: 'muted' }, t('pp.none')), newButtons());
      return;
    }
    const ended = p.finished;
    const endPlan = async () => {
      if (!(await confirmDialog(t('pp.endTitle'), t('pp.endBody'), t('pp.end'), true))) return;
      const today = app.today();
      await app.act(async () => {
        await app.s.plans.applySchedule(periodDates(p.plan).filter((d) => d > today).map((date) => ({ date, scope: null })));
        await app.savePrefs({ ...app.prefs, periodPlan: null });
        openEditor = null;
        await app.refresh();
      }, t('pp.ended'));
    };
    replaceChildren(body,
      h('p', { class: 'muted', style: { margin: '0.15rem 0 0.75rem' } }, t('pp.range', { start: fmtDateKey(p.plan.start), end: fmtDateKey(p.plan.end) })),
      h('div', { class: 'row spread', style: { 'margin-bottom': '0.35rem' } }, h('strong', null, t('pp.summary', { done: fmtNum(p.doneDays), days: fmtNum(p.revisionDays), percent: fmtNum(pct(p.fraction)) })), ended ? null : h('span', { class: 'muted' }, tn('pp.daysLeft', p.daysLeft))),
      progressBar(p.fraction, t('pp.title')),
      p.missedDays && !ended ? h('p', { class: 'notice warn', style: { margin: '0.75rem 0 0' } }, tn('pp.missed', p.missedDays)) : null,
      ended ? h('p', { class: 'notice info', style: { margin: '0.75rem 0 0' } }, p.doneDays === p.revisionDays ? t('pp.overDone') : t('pp.over')) : null,
      dayGrid(app, p),
      legend(),
      ended
        ? h('div', { style: { 'margin-top': '0.75rem' } }, h('p', null, t('pp.planNext')), newButtons())
        : h('div', { class: 'row', style: { 'margin-top': '0.75rem' } }, h('button', { type: 'button', onclick: () => showEditor({ kind: 'edit', plan: p.plan }) }, t('pp.edit')), h('button', { type: 'button', class: 'quiet', onclick: () => void endPlan() }, t('pp.end'))),
    );
  }
  if (app.freshRoute) openEditor = null;
  if (openEditor) replaceChildren(body, openEditor);
  else showSummary();
  el.append(h('div', { class: 'row spread' }, title), body);
  return { el, openNew: (period) => showEditor({ kind: 'new', period }) };
}

/** Hero card: what to revise today according to the plan (or today's own revision when there is no plan). */
export function todayGoal(app: App, p: PeriodProgress | null, panel: PeriodPanel, metrics: Node): HTMLElement {
  const index = app.quran.index;
  const active = p && !p.finished ? p : null;
  const todayPlan = app.data.plans.find((x) => x.kind === 'revision' && x.date === app.today()) ?? null;
  const head = (chip: Node | null) => h('div', { class: 'row spread' }, h('h2', { id: 'dash-today', style: { margin: '0' } }, t('goal.title')), chip);
  const next = active?.next ? h('p', { class: 'muted', style: { margin: '0.5rem 0 0' } }, t('goal.next', { day: weekday(active.next.date, 'long'), portion: active.next.scope ? scopeLabel(active.next.scope, index) : '' })) : null;
  const missed = active && active.missedDays ? h('p', { style: { margin: '0.5rem 0 0' } }, h('a', { href: '#/', onclick: (e: Event) => { e.preventDefault(); panel.el.scrollIntoView({ behavior: 'smooth' }); } }, tn('goal.missed', active.missedDays))) : null;
  let content: Node[];

  if (active && active.plan.start > app.today()) {
    content = [head(null), h('p', { class: 'hero-portion' }, t('goal.startsOn', { date: dayTitle(active.plan.start) })), next ?? h('span')];
  } else if (active && active.today?.scope) {
    const d = active.today;
    const done = d.status === 'done';
    content = [
      head(h('span', { class: `chip day-chip ${d.status}` }, statusText(d.status))),
      h('p', { class: 'goal-message' }, done ? t('goal.done') : t('goal.message')),
      h('p', { class: 'hero-portion' }, scopeLabel(d.scope as RevisionScope, index)),
      progressBar(d.fraction, t('goal.title')),
      h('p', { class: 'muted', style: { margin: '0.35rem 0 0.75rem' } }, t('pp.dayProgress', { covered: fmtNum(d.coveredAyat), total: fmtNum(d.totalAyat), percent: fmtNum(pct(d.fraction)) })),
      h('a', { class: 'btn primary big', href: '#/revision', 'data-key': 'dash-start' }, done ? t('dash.reviewAgain') : d.coveredAyat ? t('goal.continue') : t('dash.startRevision')),
      next ?? h('span'),
    ];
  } else if (active) {
    content = [head(h('span', { class: 'chip day-chip rest' }, statusText('rest'))), h('p', { class: 'hero-portion' }, t('goal.rest')), next ?? h('span')];
  } else if (todayPlan) {
    const status = { pending: t('common.notStarted'), in_progress: t('common.inProgress'), completed: t('common.completed') }[todayPlan.status];
    content = [
      head(h('span', { class: `chip ${todayPlan.status === 'completed' ? 'status-resolved' : todayPlan.status === 'in_progress' ? 'status-under_review' : ''}` }, status)),
      h('p', { class: 'hero-portion' }, scopeLabel(todayPlan.scope, index)),
      h('a', { class: 'btn primary big', href: '#/revision', 'data-key': 'dash-start' }, todayPlan.status === 'completed' ? t('dash.reviewAgain') : t('dash.startRevision')),
      h('p', { class: 'muted', style: { margin: '0.75rem 0 0' } }, t('goal.noPlanShort'), ' ', h('button', { type: 'button', class: 'quiet', onclick: () => panel.openNew('week') }, t('pp.newWeek'))),
    ];
  } else {
    content = [
      head(null),
      h('p', { class: 'muted', style: { margin: '0.5rem 0 0.75rem' } }, t('goal.noPlan')),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary big', 'data-key': 'dash-plan-week', onclick: () => panel.openNew('week') }, t('pp.newWeek')), h('a', { class: 'btn', href: '#/revision', 'data-key': 'dash-start' }, t('dash.setToday'))),
    ];
  }
  return h('section', { class: 'panel hero', 'aria-labelledby': 'dash-today' }, content, missed, metrics);
}
