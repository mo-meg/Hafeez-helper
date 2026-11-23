/**
 * Wird statistics, computed only from completion records on tasks (never from the calendar alone).
 * Full revision sessions are reported separately and never count as daily assignments.
 */
import { datesBetween, shiftDate, weekStartOf, type Weekday } from './dates.ts';
import { isDifficult, QUALITIES, type Quality, type WirdPlan, type WirdTask } from './model.ts';
import { UNIT_QUARTERS, type WirdUnit } from './units.ts';

export type DayResult = 'complete' | 'partial' | 'missed' | 'open';

/** A daily task's result: complete / partial / missed (nothing done), or open (nothing done yet, still catchable). */
export function taskResult(t: WirdTask): DayResult {
  const live = t.units.filter((u) => u.closed !== 'removed');
  const done = live.filter((u) => u.doneAt !== null).length;
  if (!live.length || done === live.length) return 'complete';
  if (done > 0) return 'partial';
  return live.some((u) => u.closed === null) ? 'open' : 'missed';
}

export interface Counts {
  scheduled: number;
  done: number;
}
const rate = (c: Counts): number | null => (c.scheduled ? c.done / c.scheduled : null);

export interface PlanStats {
  readonly plan: WirdPlan;
  readonly scheduled: number;
  readonly done: number;
  readonly rate: number | null;
  readonly overdue: number;
  readonly merged: number;
  readonly days: Readonly<Record<DayResult, number>>;
  readonly full: Readonly<Record<'complete' | 'partial' | 'missed', number>>;
  readonly quality: Readonly<Record<Quality, number>>;
  /** Share of rated units that were rated Excellent or Good (null when nothing was rated). */
  readonly strongShare: number | null;
}

export interface WirdStats {
  readonly plans: readonly PlanStats[];
  readonly overall: { readonly scheduled: number; readonly done: number; readonly rate: number | null; readonly overdue: number; readonly missedDays: number; readonly completeDays: number; readonly partialDays: number };
  /** Units completed (daily + full revision), per unit kind, and as hizb equivalents. */
  readonly unitsDone: Readonly<Record<WirdUnit, number>> & { readonly hizbEquivalent: number };
  readonly last7: ReadonlyArray<{ readonly date: string; readonly scheduled: number; readonly done: number }>;
  readonly weekly: ReadonlyArray<{ readonly weekStart: string; readonly scheduled: number; readonly done: number; readonly rate: number | null }>;
  /** Last 30 days across all plans. 'none' = nothing scheduled (rest, paused or no plan). */
  readonly month: ReadonlyArray<{ readonly date: string; readonly state: DayResult | 'none' }>;
  /** Share of the last 30 days' revision days with at least one unit done. */
  readonly consistency: number | null;
  readonly streak: { readonly current: number; readonly best: number };
  readonly quality: Readonly<Record<Quality, number>>;
  readonly difficult: ReadonlyArray<{ readonly unit: WirdUnit; readonly n: number; readonly count: number; readonly planIds: readonly string[] }>;
}

const emptyQuality = (): Record<Quality, number> => Object.fromEntries(QUALITIES.map((q) => [q, 0])) as Record<Quality, number>;

/** Units that count for a day's rate: everything scheduled before today, plus today's units already done. */
function countTask(t: WirdTask, today: string, c: Counts): void {
  for (const u of t.units) {
    if (u.closed === 'removed') continue;
    if (t.date < today || u.doneAt !== null) c.scheduled++;
    if (u.doneAt !== null) c.done++;
  }
}

function combinedState(tasks: readonly WirdTask[]): DayResult | 'none' {
  const daily = tasks.filter((t) => !t.units.every((u) => u.closed === 'removed'));
  if (!daily.length) return 'none';
  const r = daily.map(taskResult);
  if (r.every((x) => x === 'complete')) return 'complete';
  if (r.some((x) => x === 'complete' || x === 'partial')) return 'partial';
  return r.some((x) => x === 'open') ? 'open' : 'missed';
}

/**
 * Forgiving streak: consecutive days on which at least one unit of every plan due that day was
 * done. Days with nothing due (rest, paused, full revision only) neither count nor break it; today
 * only breaks it once it is over.
 */
function streaks(tasks: readonly WirdTask[], today: string): { current: number; best: number } {
  const dueByDate = new Map<string, Set<string>>();
  const doneByDate = new Map<string, Set<string>>();
  let first = today;
  for (const t of tasks) {
    if (t.kind === 'daily') {
      (dueByDate.get(t.date) ?? dueByDate.set(t.date, new Set()).get(t.date))?.add(t.planId);
      if (t.date < first) first = t.date;
    }
    for (const u of t.units) if (u.doneOn) (doneByDate.get(u.doneOn) ?? doneByDate.set(u.doneOn, new Set()).get(u.doneOn))?.add(t.planId);
  }
  const satisfied = (d: string) => {
    const due = dueByDate.get(d);
    if (!due) return null;
    const done = doneByDate.get(d);
    return [...due].every((p) => done?.has(p));
  };
  let best = 0;
  let run = 0;
  for (const d of datesBetween(first, today)) {
    const s = satisfied(d);
    if (s === null || (s === false && d === today)) continue;
    run = s ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return { current: run, best };
}

export function wirdStats(plans: readonly WirdPlan[], tasks: readonly WirdTask[], today: string, weekStart: Weekday = 6): WirdStats {
  const known = new Set(plans.map((p) => p.id));
  const all = tasks.filter((t) => known.has(t.planId) && t.date <= today);
  const daily = all.filter((t) => t.kind === 'daily');
  const overallQuality = emptyQuality();
  const unitsDone: Record<WirdUnit, number> = { juz: 0, hizb: 0, quarter: 0 };
  const difficult = new Map<string, { unit: WirdUnit; n: number; count: number; planIds: Set<string> }>();

  const perPlan: PlanStats[] = plans.map((plan) => {
    const own = all.filter((t) => t.planId === plan.id);
    const c: Counts = { scheduled: 0, done: 0 };
    const days: Record<DayResult, number> = { complete: 0, partial: 0, missed: 0, open: 0 };
    const full = { complete: 0, partial: 0, missed: 0 };
    const quality = emptyQuality();
    let overdue = 0;
    let merged = 0;
    for (const t of own) {
      for (const u of t.units) {
        if (u.doneAt !== null) unitsDone[t.unit]++;
        if (u.quality) {
          quality[u.quality]++;
          overallQuality[u.quality]++;
          if (isDifficult(u.quality)) {
            const key = `${t.unit}:${u.n}`;
            const e = difficult.get(key) ?? { unit: t.unit, n: u.n, count: 0, planIds: new Set<string>() };
            e.count++;
            e.planIds.add(plan.id);
            difficult.set(key, e);
          }
        }
      }
      if (t.kind === 'full') {
        if (t.date < today || t.units.some((u) => u.doneAt)) {
          const r = taskResult(t);
          full[r === 'open' ? 'missed' : r]++;
        }
        continue;
      }
      countTask(t, today, c);
      for (const u of t.units) {
        if (u.closed === 'merged') merged++;
        if (t.date < today && u.doneAt === null && u.closed === null && !(u.dueOn && u.dueOn > today)) overdue++;
      }
      // A day whose units were all removed by a plan change is neither done nor missed.
      if (t.units.every((u) => u.closed === 'removed')) continue;
      if (t.date < today || t.units.every((u) => u.doneAt !== null || u.closed === 'removed')) days[taskResult(t)]++;
    }
    const rated = QUALITIES.reduce((s, q) => s + quality[q], 0);
    return { plan, scheduled: c.scheduled, done: c.done, rate: rate(c), overdue, merged, days, full, quality, strongShare: rated ? (quality.excellent + quality.good) / rated : null };
  });

  const overall: Counts = { scheduled: 0, done: 0 };
  for (const p of perPlan) {
    overall.scheduled += p.scheduled;
    overall.done += p.done;
  }
  const last7 = datesBetween(shiftDate(today, -6), today).map((date) => {
    const c: Counts = { scheduled: 0, done: 0 };
    for (const t of daily) if (t.date === date) countTask(t, today, c);
    return { date, ...c };
  });
  const thisWeek = weekStartOf(today, weekStart);
  const weekly = Array.from({ length: 8 }, (_, i) => shiftDate(thisWeek, -7 * (7 - i))).map((ws) => {
    const end = shiftDate(ws, 6);
    const c: Counts = { scheduled: 0, done: 0 };
    for (const t of daily) if (t.date >= ws && t.date <= end) countTask(t, today, c);
    return { weekStart: ws, ...c, rate: rate(c) };
  });
  const month = datesBetween(shiftDate(today, -29), today).map((date) => ({ date, state: combinedState(daily.filter((t) => t.date === date)) }));
  const revisionDays = month.filter((m) => m.state !== 'none' && (m.date < today || m.state === 'complete' || m.state === 'partial'));
  const active = revisionDays.filter((m) => m.state === 'complete' || m.state === 'partial').length;

  return {
    plans: perPlan,
    overall: {
      ...overall,
      rate: rate(overall),
      overdue: perPlan.reduce((s, p) => s + p.overdue, 0),
      missedDays: perPlan.reduce((s, p) => s + p.days.missed, 0),
      completeDays: perPlan.reduce((s, p) => s + p.days.complete, 0),
      partialDays: perPlan.reduce((s, p) => s + p.days.partial, 0),
    },
    unitsDone: { ...unitsDone, hizbEquivalent: (unitsDone.juz * UNIT_QUARTERS.juz + unitsDone.hizb * UNIT_QUARTERS.hizb + unitsDone.quarter) / 4 },
    last7,
    weekly,
    month,
    consistency: revisionDays.length ? active / revisionDays.length : null,
    streak: streaks(daily.concat(all.filter((t) => t.kind === 'full')), today),
    quality: overallQuality,
    difficult: [...difficult.values()].sort((a, b) => b.count - a.count || a.n - b.n).slice(0, 10).map((d) => ({ ...d, planIds: [...d.planIds] })),
  };
}
