import type { TrendPoint } from '../../core/dashboard/aggregate.ts';
import { h, s } from '../dom.ts';

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
    { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Daily recall accuracy (bars) and estimated quality score (line), last 30 days' },
    [0, 25, 50, 75, 100].map((v) => [s('line', { class: 'grid-line', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }), s('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, String(v))]),
    points.map((p, i) => (p.accuracy === null ? null : s('rect', { class: 'acc', x: x(i) - bw / 2, y: y(p.accuracy * 100), width: bw, height: ih - (y(p.accuracy * 100) - pad.t) }))),
    path ? s('path', { class: 'series', d: path }) : null,
    scored.map((d) => s('circle', { class: 'dot', cx: x(d.i), cy: y(d.p.score as number), r: 2.5 })),
    [0, Math.floor((n - 1) / 2), n - 1].map((i) => (points[i] ? s('text', { x: x(i), y: H - 6, 'text-anchor': 'middle' }, points[i].date.slice(5)) : null)),
    s('line', { class: 'axis', x1: pad.l, x2: W - pad.r, y1: y(0), y2: y(0) }),
  );
  const withData = points.filter((p) => p.reviews > 0);
  const table = h(
    'table',
    { class: 'sr-only' },
    h('caption', null, 'Daily recall results'),
    h('tr', null, h('th', null, 'Date'), h('th', null, 'Recalls'), h('th', null, 'Correct'), h('th', null, 'Score')),
    withData.map((p) => h('tr', null, h('td', null, p.date), h('td', null, p.reviews), h('td', null, p.correct), h('td', null, p.score ?? '—'))),
  );
  return h('figure', { style: { margin: '0' } }, svg, table);
}

export function bar(value: number, max: number, red = false): HTMLElement {
  const pct = max > 0 ? Math.round((100 * value) / max) : 0;
  return h('div', { class: `bar${red ? ' red' : ''}`, role: 'presentation' }, h('span', { style: { width: `${pct}%` } }));
}
