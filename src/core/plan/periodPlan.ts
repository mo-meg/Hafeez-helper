import type { DailyPlan, ReviewEvent, RevisionSession } from '../model.ts';
import type { DivisionIndex } from '../quran/divisions.ts';
import { scopeIntervals, type IndexInterval, type RevisionScope } from '../quran/scope.ts';
import { localDateKey } from '../util/ids.ts';

export type PlanPeriod = 'week' | 'month';

/** A week or month of revision. The portion for each day is that date's daily revision plan. */
export interface PeriodPlan {
  readonly period: PlanPeriod;
  /** First and last local date (YYYY-MM-DD), inclusive. */
  readonly start: string;
  readonly end: string;
}

/** One entry per weekday offset from the start date (0..6); null = rest day. */
export type WeekTemplate = readonly (RevisionScope | null)[];

export const parseDateKey = (k: string): Date => {
  const [y, m, d] = k.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};

export const shiftDateKey = (k: string, days: number): string => {
  const d = parseDateKey(k);
  return localDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
};

/** A week is 7 days from the start date; a month runs to the day before the same date next month. */
export function makePeriodPlan(period: PlanPeriod, start: string): PeriodPlan {
  const s = parseDateKey(start);
  const end = period === 'week' ? new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6) : new Date(s.getFullYear(), s.getMonth() + 1, s.getDate() - 1);
  return { period, start, end: localDateKey(end) };
}

export function periodDates(plan: PeriodPlan): string[] {
  const out: string[] = [];
  for (let k = plan.start; k <= plan.end; k = shiftDateKey(k, 1)) out.push(k);
  return out;
}

/** The weekly pattern applied to every date of the period (the pattern repeats each week). */
export function expandTemplate(plan: PeriodPlan, template: WeekTemplate): Array<{ date: string; scope: RevisionScope | null }> {
  return periodDates(plan).map((date, i) => ({ date, scope: template[i % 7] ?? null }));
}

export type DayStatus = 'rest' | 'done' | 'missed' | 'today' | 'upcoming';

export interface DayProgress {
  readonly date: string;
  readonly scope: RevisionScope | null;
  readonly planId: string | null;
  readonly totalAyat: number;
  readonly coveredAyat: number;
  /** 0..1 */
  readonly fraction: number;
  readonly status: DayStatus;
}

export interface PeriodProgress {
  readonly plan: PeriodPlan;
  readonly days: readonly DayProgress[];
  /** Sums over revision days (a portion planned on two days counts twice). */
  readonly totalAyat: number;
  readonly coveredAyat: number;
  readonly fraction: number;
  readonly revisionDays: number;
  readonly doneDays: number;
  readonly missedDays: number;
  readonly today: DayProgress | null;
  /** The first revision day after today, if any. */
  readonly next: DayProgress | null;
  /** Days left including today; 0 once the period is over. */
  readonly daysLeft: number;
  readonly finished: boolean;
}

/** Day-by-day evidence: the last local date (within the period) each ayah was played in full or recalled. */
function lastSeen(plan: PeriodPlan, sessions: readonly RevisionSession[], reviews: readonly ReviewEvent[]): Map<number, string> {
  const seen = new Map<number, string>();
  const note = (g: number, iso: string) => {
    const k = localDateKey(new Date(iso));
    if (k < plan.start || k > plan.end) return;
    if ((seen.get(g) ?? '') < k) seen.set(g, k);
  };
  for (const s of sessions) if (!s.demo) for (const g of s.playedAyahIndexes) note(g, s.startedAt);
  for (const r of reviews) if (!r.demo) note(r.globalIndex, r.at);
  return seen;
}

/**
 * Progress of each day: the share of that day's ayat played to the end in a session or recalled on
 * that day or later in the period (so a missed day can be caught up). Evidence only; no manual ticks.
 */
export function periodProgress(
  plan: PeriodPlan,
  dailyPlans: readonly DailyPlan[],
  sessions: readonly RevisionSession[],
  reviews: readonly ReviewEvent[],
  index: DivisionIndex,
  now: Date,
): PeriodProgress {
  const today = localDateKey(now);
  const seen = lastSeen(plan, sessions, reviews);
  const byDate = new Map(dailyPlans.filter((p) => p.kind === 'revision' && p.date >= plan.start && p.date <= plan.end).map((p) => [p.date, p]));

  const days: DayProgress[] = periodDates(plan).map((date) => {
    const dp = byDate.get(date);
    if (!dp) return { date, scope: null, planId: null, totalAyat: 0, coveredAyat: 0, fraction: 0, status: 'rest' };
    let intervals: IndexInterval[] = [];
    try {
      intervals = scopeIntervals(dp.scope, index);
    } catch {
      intervals = [];
    }
    let total = 0;
    let covered = 0;
    for (const iv of intervals) {
      for (let g = iv.start; g <= iv.end; g++) {
        total++;
        if ((seen.get(g) ?? '') >= date) covered++;
      }
    }
    const fraction = total ? covered / total : 0;
    const status: DayStatus = total > 0 && covered >= total ? 'done' : date < today ? 'missed' : date === today ? 'today' : 'upcoming';
    return { date, scope: dp.scope, planId: dp.id, totalAyat: total, coveredAyat: covered, fraction, status };
  });

  const work = days.filter((d) => d.scope);
  const totalAyat = work.reduce((n, d) => n + d.totalAyat, 0);
  const coveredAyat = work.reduce((n, d) => n + d.coveredAyat, 0);
  const daysLeft = today > plan.end ? 0 : days.filter((d) => d.date >= today).length;
  return {
    plan,
    days,
    totalAyat,
    coveredAyat,
    fraction: totalAyat ? coveredAyat / totalAyat : 0,
    revisionDays: work.length,
    doneDays: work.filter((d) => d.status === 'done').length,
    missedDays: work.filter((d) => d.status === 'missed').length,
    today: days.find((d) => d.date === today) ?? null,
    next: work.find((d) => d.date > today) ?? null,
    daysLeft,
    finished: daysLeft === 0,
  };
}
