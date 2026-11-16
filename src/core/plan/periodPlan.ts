import { isUnresolved, type DailyPlan, type Mistake, type ReviewEvent, type RevisionSession } from '../model.ts';
import type { DivisionIndex } from '../quran/divisions.ts';
import { scopeContains, scopeIntervals, type IndexInterval, type RevisionScope } from '../quran/scope.ts';
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

/** One step of a revision day. `total` = ayat to cover; `covered` = ayat with evidence. */
export interface StepProgress {
  readonly total: number;
  readonly covered: number;
  /** 0..1; 1 when there is nothing to do or the step was marked by hand. */
  readonly fraction: number;
}

export interface DayProgress {
  readonly date: string;
  readonly scope: RevisionScope | null;
  readonly planId: string | null;
  /** Step 1: the portion's ayat with mistakes, revised in a mistakes session or a test. */
  readonly check: StepProgress & { readonly nothingToCheck: boolean };
  /** Step 2: the portion recited, by listening in full or marked "I recited it". */
  readonly recite: StepProgress & { readonly marked: boolean };
  /** The user marked the whole day as done. */
  readonly markedDone: boolean;
  readonly status: DayStatus;
}

export interface PeriodProgress {
  readonly plan: PeriodPlan;
  readonly days: readonly DayProgress[];
  /** Average step 1 progress over revision days that have mistakes to revise; null if none has. */
  readonly checkFraction: number | null;
  /** Average step 2 progress over all revision days (0..1). */
  readonly reciteFraction: number;
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

export interface PeriodInput {
  readonly plan: PeriodPlan;
  readonly dailyPlans: readonly DailyPlan[];
  readonly sessions: readonly RevisionSession[];
  readonly reviews: readonly ReviewEvent[];
  readonly mistakes: readonly Mistake[];
  readonly index: DivisionIndex;
  readonly now: Date;
}

const dayOf = (iso: string) => localDateKey(new Date(iso));

/** For each ayah, the last local date within the period with evidence of the given kind. */
function lastSeen(plan: PeriodPlan, entries: Iterable<[number, string]>): Map<number, string> {
  const seen = new Map<number, string>();
  for (const [g, iso] of entries) {
    const k = dayOf(iso);
    if (k < plan.start || k > plan.end) continue;
    if ((seen.get(g) ?? '') < k) seen.set(g, k);
  }
  return seen;
}

function* played(sessions: readonly RevisionSession[], modes: readonly RevisionSession['mode'][]): Generator<[number, string]> {
  for (const s of sessions) if (!s.demo && modes.includes(s.mode)) for (const g of s.playedAyahIndexes) yield [g, s.startedAt];
}

function* answered(reviews: readonly ReviewEvent[]): Generator<[number, string]> {
  for (const r of reviews) if (!r.demo) yield [r.globalIndex, r.at];
}

const ratio = (covered: number, total: number) => (total ? Math.min(1, covered / total) : 1);

/**
 * Progress of each revision day, in two steps, counted from what happened on that day or later in
 * the period (so a missed day can be caught up):
 * 1. Mistakes: of the portion's ayat that had an open mistake on that day, the share revised in a
 *    mistakes (or combined) session or answered in a test/recall. Nothing to check counts as done.
 * 2. Recitation: the share of the portion played to the end in a full (or combined) listening
 *    session, or all of it once the user marks "I recited it".
 * A day is done when both steps are complete, or when the user marks the whole day as done.
 */
export function periodProgress(input: PeriodInput): PeriodProgress {
  const { plan, index } = input;
  const today = localDateKey(input.now);
  const checkSeen = lastSeen(plan, [...played(input.sessions, ['mistakes', 'combined']), ...answered(input.reviews)]);
  const reciteSeen = lastSeen(plan, played(input.sessions, ['full', 'combined']));
  const byDate = new Map(input.dailyPlans.filter((p) => p.kind === 'revision' && p.date >= plan.start && p.date <= plan.end).map((p) => [p.date, p]));
  const mistakes = input.mistakes.filter((m) => !m.demo);

  const days: DayProgress[] = periodDates(plan).map((date) => {
    const dp = byDate.get(date);
    if (!dp) {
      const none = { total: 0, covered: 0, fraction: 0 };
      return { date, scope: null, planId: null, check: { ...none, nothingToCheck: true }, recite: { ...none, marked: false }, markedDone: false, status: 'rest' };
    }
    let intervals: IndexInterval[] = [];
    try {
      intervals = scopeIntervals(dp.scope, index);
    } catch {
      intervals = [];
    }
    // Ayat with a mistake that was open on this day: marked by then, not resolved before it.
    const toCheck = new Set<number>();
    for (const m of mistakes) {
      if (!scopeContains(intervals, m.globalIndex)) continue;
      if (dayOf(m.createdAt) > date && date < today) continue;
      if (!isUnresolved(m.status) && m.resolvedAt && dayOf(m.resolvedAt) < date) continue;
      toCheck.add(m.globalIndex);
    }
    let checked = 0;
    for (const g of toCheck) if ((checkSeen.get(g) ?? '') >= date) checked++;
    let total = 0;
    let recited = 0;
    for (const iv of intervals) {
      for (let g = iv.start; g <= iv.end; g++) {
        total++;
        if ((reciteSeen.get(g) ?? '') >= date) recited++;
      }
    }
    const marked = !!dp.markedRecitedAt;
    const markedDone = !!dp.markedDoneAt;
    const check = { total: toCheck.size, covered: checked, fraction: markedDone ? 1 : ratio(checked, toCheck.size), nothingToCheck: toCheck.size === 0 };
    const recite = { total, covered: marked || markedDone ? total : recited, fraction: marked || markedDone ? 1 : total ? recited / total : 0, marked };
    const complete = markedDone || (check.fraction >= 1 && recite.fraction >= 1 && total > 0);
    const status: DayStatus = complete ? 'done' : date < today ? 'missed' : date === today ? 'today' : 'upcoming';
    return { date, scope: dp.scope, planId: dp.id, check, recite, markedDone, status };
  });

  const work = days.filter((d) => d.scope);
  const avg = (list: readonly DayProgress[], f: (d: DayProgress) => number) => (list.length ? list.reduce((n, d) => n + f(d), 0) / list.length : 0);
  const withMistakes = work.filter((d) => !d.check.nothingToCheck);
  const daysLeft = today > plan.end ? 0 : days.filter((d) => d.date >= today).length;
  return {
    plan,
    days,
    checkFraction: withMistakes.length ? avg(withMistakes, (d) => d.check.fraction) : null,
    reciteFraction: avg(work, (d) => d.recite.fraction),
    revisionDays: work.length,
    doneDays: work.filter((d) => d.status === 'done').length,
    missedDays: work.filter((d) => d.status === 'missed').length,
    today: days.find((d) => d.date === today) ?? null,
    next: work.find((d) => d.date > today) ?? null,
    daysLeft,
    finished: daysLeft === 0,
  };
}
