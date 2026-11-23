/** One-time conversion of the retired week/month Period Plan into a Wird plan. */
import type { DailyPlan } from '../model.ts';
import type { DivisionIndex } from '../quran/divisions.ts';
import { divisionSpan, normalizeScope, type RevisionScope } from '../quran/scope.ts';
import { weekdayOf, type Weekday } from './dates.ts';
import type { DayRange, WirdConfig } from './model.ts';
import { convertSpan, rangeQuarterSpan, WIRD_UNITS, type WirdUnit } from './units.ts';

export interface LegacyPeriod {
  readonly period: 'week' | 'month';
  readonly start: string;
  readonly end: string;
}

/** A plan-range of a scope when it is whole juz / hizb / quarters; null otherwise (surahs, pages, ayah ranges). */
export function scopeUnits(scope: RevisionScope, index: DivisionIndex): { unit: WirdUnit; from: number; to: number } | null {
  const s = normalizeScope(scope);
  if (s.type === 'division') return (WIRD_UNITS as readonly string[]).includes(s.kind) ? { unit: s.kind as WirdUnit, from: s.number, to: s.number } : null;
  try {
    const span = divisionSpan(s, index);
    return span && (WIRD_UNITS as readonly string[]).includes(span.kind) ? { unit: span.kind as WirdUnit, from: span.from, to: span.to } : null;
  } catch {
    return null;
  }
}

const FINE: Record<WirdUnit, number> = { quarter: 0, hizb: 1, juz: 2 };

/**
 * The weekly pattern of an unfinished Period Plan as a Wird configuration (manual weekly split,
 * gaps and repeats allowed because the old template could contain them). Null when the plan is
 * over or none of its days is a whole juz / hizb / quarter range.
 */
export function configFromPeriod(p: LegacyPeriod, dailyPlans: readonly DailyPlan[], index: DivisionIndex, today: string): Omit<WirdConfig, 'effectiveFrom'> | null {
  if (p.end < today) return null;
  const byDay = new Map<Weekday, { unit: WirdUnit; from: number; to: number }>();
  for (const dp of [...dailyPlans].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (dp.kind !== 'revision' || dp.date < p.start || dp.date > p.end) continue;
    const wd = weekdayOf(dp.date);
    if (byDay.has(wd)) continue;
    const u = scopeUnits(dp.scope, index);
    if (u) byDay.set(wd, u);
  }
  if (!byDay.size) return null;
  const unit = [...byDay.values()].reduce<WirdUnit>((a, b) => (FINE[b.unit] < FINE[a] ? b.unit : a), 'juz');
  const manual: DayRange[] = [];
  for (const [day, r] of byDay) {
    const conv = convertSpan(rangeQuarterSpan(r.unit, r.from, r.to), unit);
    if (conv) manual.push({ day, ...conv });
  }
  const from = Math.min(...manual.map((m) => m.from));
  const to = Math.max(...manual.map((m) => m.to));
  return {
    unit,
    from,
    to,
    revisionDays: [...byDay.keys()].sort(),
    fullDays: [],
    weekStart: weekdayOf(p.start),
    cycle: 'weekly',
    distribution: 'manual',
    manual,
    allowGaps: true,
    dailyAmount: 1,
    startOffset: 0,
    targetDate: null,
    carry: 'strict',
    fullDayOverdue: 'full_plus_overdue',
  };
}
