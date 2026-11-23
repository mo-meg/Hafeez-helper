/** Wird Planner statistics: computed from completion records only (see core/wird/stats.ts). */
import { currentConfig } from '../../core/wird/engine.ts';
import { QUALITIES } from '../../core/wird/model.ts';
import { wirdStats } from '../../core/wird/stats.ts';
import type { App } from '../app.ts';
import { bar } from '../components/charts.ts';
import { h } from '../dom.ts';
import { fmtDateKey, fmtNum, t, tn } from '../i18n/index.ts';
import { colorClass, qualityLabel, unitLabel } from './wirdCard.ts';

const pct = (f: number | null) => (f === null ? '—' : `${fmtNum(Math.round(f * 100))}%`);

export function statsTab(app: App): HTMLElement {
  const plans = app.data.wird.plans;
  const today = app.today();
  if (!plans.length || !app.data.wird.tasks.length) return h('p', { class: 'muted' }, t('wird.st.none'));
  const ws = plans[0] ? currentConfig(plans[0], today).weekStart : 6;
  const s = wirdStats(plans, app.data.wird.tasks, today, ws);
  const metric = (value: string, label: string, cls = '') => h('div', { class: `metric ${cls}` }, h('div', { class: 'value' }, value), h('div', { class: 'label' }, label));
  const maxDay = Math.max(1, ...s.last7.map((d) => d.scheduled));
  const maxQ = Math.max(1, ...QUALITIES.map((q) => s.quality[q]));
  const rated = QUALITIES.reduce((n, q) => n + s.quality[q], 0);

  return h('div', { class: 'stack wird-stats' },
    h('div', { class: 'metrics' },
      metric(pct(s.overall.rate), t('wird.st.overall'), s.overall.rate !== null && s.overall.rate >= 0.8 ? 'good' : ''),
      metric(tn('wird.st.days', s.streak.current), t('wird.st.streak'), s.streak.current ? 'good' : ''),
      metric(tn('wird.st.days', s.streak.best), t('wird.st.best')),
      metric(pct(s.consistency), t('wird.st.consistency')),
      metric(fmtNum(s.overall.overdue), t('wird.st.overdue'), s.overall.overdue ? 'alert' : ''),
      metric(fmtNum(s.overall.missedDays), t('wird.st.missed')),
      metric(fmtNum(s.unitsDone.hizbEquivalent, { maximumFractionDigits: 1 }), t('wird.st.hizbDone')),
    ),
    h('p', { class: 'muted small' }, t('wird.st.unitsDone', { juz: s.unitsDone.juz, hizb: s.unitsDone.hizb, quarter: s.unitsDone.quarter })),
    h('div', { class: 'grid two' },
      h('section', { class: 'panel' }, h('h2', null, t('wird.st.last7')),
        h('table', { class: 'stat-bars' }, h('tbody', null, s.last7.map((d) => h('tr', null, h('th', { scope: 'row' }, fmtDateKey(d.date, { weekday: 'short', day: 'numeric' })), h('td', null, bar(d.done, maxDay)), h('td', { class: 'num' }, d.scheduled ? `${fmtNum(d.done)}/${fmtNum(d.scheduled)}` : '—')))))),
      h('section', { class: 'panel' }, h('h2', null, t('wird.st.weekly')),
        h('table', { class: 'stat-bars' }, h('tbody', null, s.weekly.map((w) => h('tr', null, h('th', { scope: 'row' }, fmtDateKey(w.weekStart, { day: 'numeric', month: 'short' })), h('td', null, bar(w.done, Math.max(1, w.scheduled))), h('td', { class: 'num' }, pct(w.rate)))))))),
    h('section', { class: 'panel' }, h('h2', null, t('wird.st.month')),
      h('div', { class: 'month-grid', role: 'list' }, s.month.map((m) => h('span', { role: 'listitem', class: `mg ${m.state}`, title: `${fmtDateKey(m.date)}: ${t(m.state === 'complete' ? 'wird.st.legendComplete' : m.state === 'partial' ? 'wird.st.legendPartial' : m.state === 'none' ? 'wird.st.legendNone' : 'wird.st.legendMissed')}` }, fmtDateKey(m.date, { day: 'numeric' })))),
      h('div', { class: 'legend' }, (['complete', 'partial', 'missed', 'none'] as const).map((k) => h('span', null, h('span', { class: `swatch mg ${k}` }), t(k === 'complete' ? 'wird.st.legendComplete' : k === 'partial' ? 'wird.st.legendPartial' : k === 'missed' ? 'wird.st.legendMissed' : 'wird.st.legendNone'))))),
    h('section', { class: 'panel' }, h('h2', null, t('wird.st.perPlan')),
      h('div', { class: 'table-wrap' }, h('table', { class: 'plan-compare' },
        h('thead', null, h('tr', null, [t('wird.st.plan'), t('wird.st.rate'), t('wird.st.units'), t('wird.st.dayResults'), t('wird.st.fullSessions'), t('wird.st.overdue'), t('wird.st.strong')].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', null, s.plans.map((p) => h('tr', { class: colorClass(p.plan) },
          h('th', { scope: 'row' }, h('span', { class: 'plan-dot', 'aria-hidden': 'true' }), ' ', p.plan.name),
          h('td', { class: 'num' }, pct(p.rate)),
          h('td', { class: 'num' }, `${fmtNum(p.done)}/${fmtNum(p.scheduled)}`),
          h('td', { class: 'num' }, `${fmtNum(p.days.complete)} / ${fmtNum(p.days.partial)} / ${fmtNum(p.days.missed)}`),
          h('td', { class: 'num' }, `${fmtNum(p.full.complete)} / ${fmtNum(p.full.partial)} / ${fmtNum(p.full.missed)}`),
          h('td', { class: 'num' }, fmtNum(p.overdue)),
          h('td', { class: 'num' }, pct(p.strongShare)))))))),
    h('div', { class: 'grid two' },
      h('section', { class: 'panel' }, h('h2', null, t('wird.st.quality')),
        rated
          ? h('table', { class: 'stat-bars' }, h('tbody', null, QUALITIES.map((q) => h('tr', null, h('th', { scope: 'row' }, qualityLabel(q)), h('td', null, bar(s.quality[q], maxQ, q === 'weak' || q === 'needs_practice')), h('td', { class: 'num' }, fmtNum(s.quality[q]))))))
          : h('p', { class: 'muted' }, t('wird.st.noQuality'))),
      h('section', { class: 'panel' }, h('h2', null, t('wird.st.difficult')),
        s.difficult.length
          ? h('ul', { class: 'activity' }, s.difficult.map((d) => h('li', null, h('a', { href: `#/quran?${d.unit}=${d.n}` }, unitLabel(d.unit, d.n)), h('span', { class: 'when' }, tn('wird.st.timesDifficult', d.count)))))
          : h('p', { class: 'muted' }, t('wird.st.noDifficult')))),
    h('p', { class: 'muted small' }, t('wird.st.note')),
  );
}
