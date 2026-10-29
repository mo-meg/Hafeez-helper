import {
  isUnresolved,
  MISTAKE_CATEGORIES,
  type DailyPlan,
  type Mistake,
  type MistakeCategory,
  type ReviewEvent,
  type RevisionSession,
} from '../model.ts';
import { effectiveDueDate, isDue } from '../review/scheduler.ts';
import { computeQuality, DEFAULT_SCORING, type QualityBreakdown, type ScoringConfig } from '../review/scoring.ts';
import type { DivisionIndex } from '../quran/divisions.ts';
import { surahEndIndex, surahStartIndex } from '../quran/refs.ts';
import type { DivisionKind } from '../quran/types.ts';
import { addDays, localDateKey } from '../util/ids.ts';

export interface GroupPerformance {
  readonly key: number;
  readonly mistakes: number;
  readonly unresolved: number;
  readonly resolved: number;
  readonly score: number | null;
}

export interface TrendPoint {
  readonly date: string;
  readonly reviews: number;
  readonly correct: number;
  /** Share of recall attempts that day that were correct (easy or difficult); null if none. */
  readonly accuracy: number | null;
  /** Overall estimated quality at the end of that day (same rules for every day). */
  readonly score: number | null;
}

export interface PracticeItem {
  readonly globalIndex: number;
  readonly surah: number;
  readonly ayah: number;
  readonly mistakeIds: readonly string[];
  readonly lapses: number;
  readonly unresolved: number;
  readonly lastReviewedAt: string | null;
}

export interface DashboardData {
  readonly generatedAt: string;
  readonly ayatWithMistakes: number;
  readonly totalMistakes: number;
  readonly unresolved: number;
  readonly resolved: number;
  /** Mistakes that occurred again after being marked (lapses) or were reopened after resolution. */
  readonly reappeared: number;
  readonly reopened: number;
  readonly ayatReviewedToday: number;
  readonly recallsToday: number;
  readonly todayPlan: DailyPlan | null;
  /** Consecutive days (ending today, or yesterday if nothing yet today) with ≥1 recall outcome. */
  readonly streakDays: number;
  readonly overall: QualityBreakdown;
  readonly trend: readonly TrendPoint[];
  readonly bySurah: readonly GroupPerformance[];
  readonly byDivision: Readonly<Partial<Record<DivisionKind, readonly GroupPerformance[]>>>;
  readonly categories: ReadonlyArray<{ category: MistakeCategory; total: number; unresolved: number }>;
  readonly mostPractice: readonly PracticeItem[];
  readonly notReviewedRecently: readonly PracticeItem[];
  readonly due: readonly Mistake[];
  readonly upcoming: readonly Mistake[];
  readonly completedSessions: number;
  readonly hasDemoData: boolean;
}

export interface AggregateInput {
  readonly mistakes: readonly Mistake[];
  readonly reviews: readonly ReviewEvent[];
  readonly sessions: readonly RevisionSession[];
  readonly plans: readonly DailyPlan[];
  readonly index: DivisionIndex | null;
  readonly now: Date;
  readonly trendDays?: number;
  readonly notRecentDays?: number;
  readonly scoring?: ScoringConfig;
}

const endOfLocalDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

function performance(
  keyOf: (m: Mistake) => number | null,
  mistakes: readonly Mistake[],
  reviews: readonly ReviewEvent[],
  now: Date,
  intervalOf: (key: number) => { start: number; end: number },
  scoring: ScoringConfig,
): GroupPerformance[] {
  const groups = new Map<number, Mistake[]>();
  for (const m of mistakes) {
    const k = keyOf(m);
    if (k !== null) groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, ms]) => ({
      key,
      mistakes: ms.length,
      unresolved: ms.filter((m) => isUnresolved(m.status)).length,
      resolved: ms.filter((m) => m.status === 'resolved').length,
      score: computeQuality(ms, reviews, now, [intervalOf(key)], scoring).score,
    }));
}

function practiceItems(mistakes: readonly Mistake[]): PracticeItem[] {
  const byAyah = new Map<number, Mistake[]>();
  for (const m of mistakes) byAyah.set(m.globalIndex, [...(byAyah.get(m.globalIndex) ?? []), m]);
  return [...byAyah.entries()].map(([globalIndex, ms]) => ({
    globalIndex,
    surah: (ms[0] as Mistake).surah,
    ayah: (ms[0] as Mistake).ayah,
    mistakeIds: ms.map((m) => m.id),
    lapses: ms.reduce((n, m) => n + m.lapseCount + m.reopenCount, 0),
    unresolved: ms.filter((m) => isUnresolved(m.status)).length,
    lastReviewedAt: ms.map((m) => m.lastReviewedAt).filter((x): x is string => x !== null).sort().at(-1) ?? null,
  }));
}

/** Pure aggregation over stored records. Nothing is fabricated: empty data → zeros/nulls. */
export function aggregateDashboard(input: AggregateInput): DashboardData {
  const { mistakes, reviews, sessions, plans, index, now } = input;
  const scoring = input.scoring ?? DEFAULT_SCORING;
  const today = localDateKey(now);
  const reviewDays = new Map<string, ReviewEvent[]>();
  for (const r of reviews) {
    const d = localDateKey(new Date(r.at));
    reviewDays.set(d, [...(reviewDays.get(d) ?? []), r]);
  }
  // Several marked words of one ayah reviewed together count as one recall.
  const recallKey = (r: ReviewEvent) => `${r.globalIndex}|${r.sessionId ?? '-'}|${r.at}`;
  const distinctRecalls = (list: readonly ReviewEvent[]) => {
    const m = new Map<string, ReviewEvent>();
    for (const r of list) m.set(recallKey(r), r);
    return [...m.values()];
  };

  const todays = distinctRecalls(reviewDays.get(today) ?? []);

  let streak = 0;
  let cursor = now;
  if (!reviewDays.has(today)) cursor = addDays(now, -1);
  while (reviewDays.has(localDateKey(cursor))) {
    streak++;
    cursor = addDays(cursor, -1);
  }

  const trendDays = input.trendDays ?? 30;
  const trend: TrendPoint[] = [];
  for (let i = trendDays - 1; i >= 0; i--) {
    const day = addDays(now, -i);
    const key = localDateKey(day);
    const list = distinctRecalls(reviewDays.get(key) ?? []);
    const correct = list.filter((r) => r.outcome === 'correct_easy' || r.outcome === 'correct_difficult').length;
    const end = i === 0 ? now : endOfLocalDay(day);
    trend.push({
      date: key,
      reviews: list.length,
      correct,
      accuracy: list.length ? correct / list.length : null,
      score: computeQuality(mistakes, reviews, end, null, scoring).score,
    });
  }

  const byDivision: Partial<Record<DivisionKind, GroupPerformance[]>> = {};
  if (index) {
    for (const kind of ['juz', 'hizb', 'quarter', 'eighth'] as const) {
      if (!index.has(kind)) continue;
      byDivision[kind] = performance(
        (m) => index.numberAt(kind, m.globalIndex),
        mistakes,
        reviews,
        now,
        (k) => {
          const r = index.range(kind, k);
          return { start: r.startIndex, end: r.endIndex };
        },
        scoring,
      );
    }
  }

  const items = practiceItems(mistakes);
  const notRecentCutoff = addDays(now, -(input.notRecentDays ?? 14)).toISOString();
  const unresolvedList = mistakes.filter((m) => isUnresolved(m.status));
  const due = unresolvedList
    .filter((m) => isDue(m, now))
    .sort((a, b) => (effectiveDueDate(a)?.getTime() ?? 0) - (effectiveDueDate(b)?.getTime() ?? 0) || a.globalIndex - b.globalIndex);
  const upcoming = unresolvedList
    .filter((m) => !isDue(m, now))
    .sort((a, b) => (effectiveDueDate(a)?.getTime() ?? 0) - (effectiveDueDate(b)?.getTime() ?? 0))
    .slice(0, 10);

  return {
    generatedAt: now.toISOString(),
    ayatWithMistakes: new Set(mistakes.map((m) => m.globalIndex)).size,
    totalMistakes: mistakes.length,
    unresolved: unresolvedList.length,
    resolved: mistakes.length - unresolvedList.length,
    reappeared: mistakes.filter((m) => m.lapseCount > 0 || m.reopenCount > 0).length,
    reopened: mistakes.filter((m) => m.reopenCount > 0).length,
    ayatReviewedToday: new Set(todays.map((r) => r.globalIndex)).size,
    recallsToday: todays.length,
    todayPlan: plans.find((p) => p.date === today && p.kind === 'revision') ?? null,
    streakDays: streak,
    overall: computeQuality(mistakes, reviews, now, null, scoring),
    trend,
    bySurah: performance((m) => m.surah, mistakes, reviews, now, (s) => ({ start: surahStartIndex(s), end: surahEndIndex(s) }), scoring),
    byDivision,
    categories: MISTAKE_CATEGORIES.map((category) => ({
      category,
      total: mistakes.filter((m) => m.category === category).length,
      unresolved: unresolvedList.filter((m) => m.category === category).length,
    })),
    mostPractice: items
      .filter((i) => i.unresolved > 0)
      .sort((a, b) => b.lapses - a.lapses || b.unresolved - a.unresolved || a.globalIndex - b.globalIndex)
      .slice(0, 10),
    notReviewedRecently: items
      .filter((i) => i.unresolved > 0 && (i.lastReviewedAt === null || i.lastReviewedAt < notRecentCutoff))
      .sort((a, b) => (a.lastReviewedAt ?? '').localeCompare(b.lastReviewedAt ?? '') || a.globalIndex - b.globalIndex)
      .slice(0, 10),
    due,
    upcoming,
    completedSessions: sessions.filter((s) => s.status === 'completed').length,
    hasDemoData: mistakes.some((m) => m.demo) || reviews.some((r) => r.demo),
  };
}
