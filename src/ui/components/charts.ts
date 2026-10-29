import type { TrendPoint } from '../../core/dashboard/aggregate.ts';
import { h, s } from '../dom.ts';
import { fmtDateKey, fmtNum, t } from '../i18n/index.ts';

/**
 * Trend chart: bars = share of correct recalls that day; line = estimated quality score at the
 * end of each day. Days without any recall show no bar. Includes a text table for screen readers.
 */
export function trendChart(points: readonly TrendPoint[]): HTMLElement {
  const W = 640;
  const H = 200;
  const pad = { l: 34, r: 10, t: 12, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const n = Math.max(1, points.length);
  const x = (i: number) => pad.l + (iw * (i + 0.5)) / n;
  const y = (v: number) => pad.t + ih * (1 - v / 100);
  const bw = Math.max(2, (iw / n) * 0.6);
  const scored = points.map((p, i) => ({ p, i })).filter((d) => d.p.score !== null);
  const path = scored.map((d, k) => `${k === 0 ? 'M' : 'L'}${x(d.i).toFixed(1)},${y(d.p.score as number).toFixed(1)}`).join(' ');
  const svg = s(
    'svg',
    { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': t('chart.aria'), direction: 'ltr' },
    [0, 25, 50, 75, 100].map((v) => [s('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }), s('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmtNum(v))]),
    points.map((p, i) => (p.accuracy === null ? null : s('rect', { class: 'acc', x: x(i) - bw / 2, y: y(p.accuracy * 100), width: bw, height: ih - (y(p.accuracy * 100) - pad.t) }))),
    path ? s('path', { class: 'series', d: path }) : null,
    scored.map((d) => s('circle', { class: 'dot', cx: x(d.i), cy: y(d.p.score as number), r: 2.5 })),
    [0, Math.floor((n - 1) / 2), n - 1].map((i) => (points[i] ? s('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' }, fmtDateKey(points[i].date, { month: 'numeric', day: 'numeric' })) : null)),
    s('line', { class: 'axis', x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0) }),
  );
  const withData = points.filter((p) => p.reviews > 0);
  const table = h(
    'table',
    { class: 'sr-only' },
    h('caption', null, t('chart.caption')),
    h('tr', null, h('th', null, t('common.date')), h('th', null, t('chart.recalls')), h('th', null, t('chart.correct')), h('th', null, t('chart.score'))),
    withData.map((p) => h('tr', null, h('td', null, fmtDateKey(p.date)), h('td', null, fmtNum(p.reviews)), h('td', null, fmtNum(p.correct)), h('td', null, p.score === null ? '—' : fmtNum(p.score)))),
  );
  return h('figure', { style: { margin: '0' } }, svg, table);
}

export function bar(value: number, max: number, red = false): HTMLElement {
  const pct = max > 0 ? Math.round((100 * value) / max) : 0;
  return h('div', { class: `bar${red ? ' red' : ''}`, role: 'presentation' }, h('span', { style: { width: `${pct}%` } }));
}
