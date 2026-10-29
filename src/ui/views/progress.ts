import type { GroupPerformance } from '../../core/dashboard/aggregate.ts';
import { OUTCOME_LABELS, STATUS_LABELS } from '../../core/model.ts';
import { formatRef } from '../../core/quran/refs.ts';
import { describeScope } from '../../core/quran/scope.ts';
import { surahInfo } from '../../core/quran/surahs.ts';
import type { DivisionKind } from '../../core/quran/types.ts';
import type { App } from '../app.ts';
import { bar, trendChart } from '../components/charts.ts';
import { formatDateTime, h } from '../dom.ts';
import { dashboardData, scoreExplanation } from './dashboard.ts';

let groupBy: 'surah' | DivisionKind = 'hizb';

function perfTable(rows: readonly GroupPerformance[], label: (k: number) => string, link: (k: number) => string): HTMLElement {
  if (!rows.length) return h('p', { class: 'muted' }, 'No mistakes recorded in any portion yet.');
  return h(
    'div',
    { class: 'table-wrap' },
    h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Portion'), h('th', null, 'Mistakes'), h('th', null, 'Unresolved'), h('th', null, 'Resolved'), h('th', null, 'Estimated quality'), h('th', { class: 'sr-only' }, 'Bar'))),
      h('tbody', null, rows.map((r) => h('tr', null,
        h('td', null, h('a', { href: link(r.key) }, label(r.key))),
        h('td', null, String(r.mistakes)),
        h('td', null, String(r.unresolved)),
        h('td', null, String(r.resolved)),
        h('td', null, r.score === null ? '—' : `${r.score}/100`),
        h('td', { style: { width: '25%' } }, r.score === null ? null : bar(r.score, 100)),
      ))),
    ),
  );
}

export function progressView(app: App): Node {
  const d = dashboardData(app);
  const index = app.quran.index;
  const kinds: Array<['surah' | DivisionKind, string]> = [['surah', 'Surah'], ['juz', 'Juz'], ['hizb', 'Hizb'], ['quarter', 'Quarter'], ['eighth', 'Eighth']];
  if (groupBy !== 'surah' && !index.has(groupBy)) groupBy = 'surah';
  const rows = groupBy === 'surah' ? d.bySurah : (d.byDivision[groupBy] ?? []);
  const label = (k: number) => {
    if (groupBy === 'surah') return `${k}. ${surahInfo(k).nameTransliterated}`;
    if (groupBy === 'quarter') return `Quarter ${k} (Hizb ${Math.ceil(k / 4)}, ${((k - 1) % 4) + 1}/4)`;
    if (groupBy === 'eighth') return `Eighth ${k} (Hizb ${Math.ceil(k / 8)}, ${((k - 1) % 8) + 1}/8)`;
    return `${groupBy === 'juz' ? 'Juz' : 'Hizb'} ${k}`;
  };
  const link = (k: number) => (groupBy === 'surah' ? `#/quran?surah=${k}` : `#/quran?${groupBy}=${k}`);
  const reviews = [...app.data.reviews].sort((a, b) => b.at.localeCompare(a.at));
  const seen = new Set<string>();
  const recalls = reviews.filter((r) => {
    const k = `${r.globalIndex}|${r.sessionId}|${r.at}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const sessions = [...app.data.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Progress'), h('p', { class: 'muted' }, 'How your recall is developing, based on the answers you recorded.'))),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'Last 30 days'),
      d.trend.some((t) => t.reviews > 0 || t.score !== null)
        ? [trendChart(d.trend), h('p', { class: 'muted' }, 'Bars: share of correct recalls each day. Line: estimated quality at the end of each day, computed with the same rules for every day.')]
        : h('p', { class: 'muted' }, 'Record how you recalled your marked ayat during revision sessions and your trend will appear here.'),
      scoreExplanation(),
    ),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'row spread' }, h('h2', null, 'By portion'), h('label', { class: 'field' }, h('span', null, 'Group by'), h('select', { 'data-key': 'groupby', onchange: (e: Event) => { groupBy = (e.target as HTMLSelectElement).value as typeof groupBy; app.render(true); } }, kinds.map(([k, l]) => h('option', { value: k, selected: k === groupBy, disabled: k !== 'surah' && !index.has(k) }, index.has(k as DivisionKind) || k === 'surah' ? l : `${l} (data not loaded)`))))),
      perfTable(rows, label, link),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'Recall history'),
      recalls.length
        ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Ayah'), h('th', null, 'Answer'), h('th', null, 'Status after'))), h('tbody', null, recalls.slice(0, 60).map((r) => h('tr', null, h('td', null, formatDateTime(r.at)), h('td', null, h('a', { href: `#/quran?surah=${r.surah}&focus=${r.globalIndex}` }, formatRef(r))), h('td', null, OUTCOME_LABELS[r.outcome], r.demo ? h('span', { class: 'chip demo', style: { 'margin-inline-start': '0.4rem' } }, 'Demo') : null), h('td', null, STATUS_LABELS[r.nextStatus]))))))
        : h('p', { class: 'muted' }, 'No recall answers recorded yet.'),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'Sessions'),
      sessions.length
        ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Started'), h('th', null, 'Portion'), h('th', null, 'Type'), h('th', null, 'Plays'), h('th', null, 'Status'))), h('tbody', null, sessions.slice(0, 30).map((s) => h('tr', null, h('td', null, formatDateTime(s.startedAt)), h('td', null, describeScope(s.scope, index)), h('td', null, { mistakes: 'Mistakes', full: 'Full', combined: 'Combined', test: 'Test' }[s.mode]), h('td', null, `${s.completedSteps} of ${s.plannedSteps}`), h('td', null, { active: 'Interrupted or running', completed: 'Completed', abandoned: 'Ended early' }[s.status]))))))
        : h('p', { class: 'muted' }, 'No sessions yet.'),
    ),
  );
}
