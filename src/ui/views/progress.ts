import type { GroupPerformance } from '../../core/dashboard/aggregate.ts';
import type { DivisionKind } from '../../core/quran/types.ts';
import type { App } from '../app.ts';
import { bar, trendChart } from '../components/charts.ts';
import { formatDateTime, h } from '../dom.ts';
import { dashboardData, scoreExplanation } from './dashboard.ts';
import { fmtNum, t } from '../i18n/index.ts';
import { outcomeLabel, refLabel, scopeLabel, statusLabel, surahOption } from '../i18n/labels.ts';

let groupBy: 'surah' | DivisionKind = 'hizb';

function perfTable(rows: readonly GroupPerformance[], label: (k: number) => string, link: (k: number) => string): HTMLElement {
  if (!rows.length) return h('p', { class: 'muted' }, t('prog.noPortion'));
  return h(
    'div',
    { class: 'table-wrap' },
    h('table', null,
      h('thead', null, h('tr', null, h('th', null, t('common.portion')), h('th', null, t('prog.mistakes')), h('th', null, t('common.unresolved')), h('th', null, t('common.resolved')), h('th', null, t('prog.quality')), h('th', { class: 'sr-only' }, t('prog.bar')))),
      h('tbody', null, rows.map((r) => h('tr', null,
        h('td', null, h('a', { href: link(r.key) }, label(r.key))),
        h('td', null, fmtNum(r.mistakes)),
        h('td', null, fmtNum(r.unresolved)),
        h('td', null, fmtNum(r.resolved)),
        h('td', null, r.score === null ? '—' : t('common.score100', { score: r.score })),
        h('td', { style: { width: '25%' } }, r.score === null ? null : bar(r.score, 100)),
      ))),
    ),
  );
}

export function progressView(app: App): Node {
  const d = dashboardData(app);
  const index = app.quran.index;
  const kinds: Array<['surah' | DivisionKind, string]> = [['surah', t('common.surah')], ['juz', t('kind.juz')], ['hizb', t('kind.hizb')], ['quarter', t('kind.quarter')], ['eighth', t('kind.eighth')]];
  if (groupBy !== 'surah' && !index.has(groupBy)) groupBy = 'surah';
  const rows = groupBy === 'surah' ? d.bySurah : (d.byDivision[groupBy] ?? []);
  const label = (k: number) => {
    if (groupBy === 'surah') return surahOption(k);
    return scopeLabel({ type: 'division', kind: groupBy, number: k }, index);
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
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('prog.title')), h('p', { class: 'muted' }, t('prog.intro')))),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, t('prog.last30')),
      d.trend.some((p) => p.reviews > 0 || p.score !== null)
        ? [trendChart(d.trend), h('p', { class: 'muted' }, t('prog.chartHelp'))]
        : h('p', { class: 'muted' }, t('prog.noTrend')),
      scoreExplanation(),
    ),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'row spread' }, h('h2', null, t('prog.byPortion')), h('label', { class: 'field' }, h('span', null, t('prog.groupBy')), h('select', { 'data-key': 'groupby', onchange: (e: Event) => { groupBy = (e.target as HTMLSelectElement).value as typeof groupBy; app.render(true); } }, kinds.map(([k, l]) => h('option', { value: k, selected: k === groupBy, disabled: k !== 'surah' && !index.has(k) }, index.has(k as DivisionKind) || k === 'surah' ? l : t('common.dataNotLoaded', { label: l })))))),
      perfTable(rows, label, link),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, t('prog.history')),
      recalls.length
        ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, t('prog.when')), h('th', null, t('common.ayah')), h('th', null, t('prog.answer')), h('th', null, t('prog.statusAfter')))), h('tbody', null, recalls.slice(0, 60).map((r) => h('tr', null, h('td', null, formatDateTime(r.at)), h('td', null, h('a', { href: `#/quran?surah=${r.surah}&focus=${r.globalIndex}` }, refLabel(r))), h('td', null, outcomeLabel(r.outcome), r.demo ? h('span', { class: 'chip demo', style: { 'margin-inline-start': '0.4rem' } }, t('common.demo')) : null), h('td', null, statusLabel(r.nextStatus)))))))
        : h('p', { class: 'muted' }, t('prog.noHistory')),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, t('prog.sessions')),
      sessions.length
        ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, t('prog.startedCol')), h('th', null, t('common.portion')), h('th', null, t('common.type')), h('th', null, t('prog.plays')), h('th', null, t('common.status')))), h('tbody', null, sessions.slice(0, 30).map((s) => h('tr', null, h('td', null, formatDateTime(s.startedAt)), h('td', null, scopeLabel(s.scope, index)), h('td', null, t(`modeShort.${s.mode}`)), h('td', null, t('common.ofTotal', { n: s.completedSteps, total: s.plannedSteps })), h('td', null, t(`sessionStatus.${s.status}`)))))))
        : h('p', { class: 'muted' }, t('prog.noSessions')),
    ),
  );
}
