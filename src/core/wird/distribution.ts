import { orderedWeekdays, type Weekday } from './dates.ts';
import type { DayRange, WirdConfig } from './model.ts';
import { unitRange } from './units.ts';

/** Balanced sizes, larger first: balancedSizes(18, 5) = [4, 4, 4, 3, 3]. */
export function balancedSizes(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  const base = Math.floor(total / parts);
  const extra = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Contiguous ranges for the revision days of a weekly plan, in week order. */
export function autoWeeklyRanges(c: Pick<WirdConfig, 'from' | 'to' | 'revisionDays' | 'weekStart'>): DayRange[] {
  const days = orderedWeekdays(c.revisionDays, c.weekStart);
  const sizes = balancedSizes(c.to - c.from + 1, days.length);
  const out: DayRange[] = [];
  let next = c.from;
  days.forEach((day, i) => {
    const size = sizes[i] ?? 0;
    if (size > 0) out.push({ day, from: next, to: next + size - 1 });
    next += size;
  });
  return out;
}

/** Units scheduled on a weekday of a weekly-cycle plan. */
export function weeklyUnits(c: WirdConfig, day: Weekday): number[] {
  if (!c.revisionDays.includes(day)) return [];
  const ranges = c.distribution === 'manual' ? c.manual : autoWeeklyRanges(c);
  return ranges.filter((r) => r.day === day).flatMap((r) => unitRange(r.from, r.to));
}

/** Units of the k-th revision day (0-based) of a fixed-daily plan; the window wraps around the range. */
export function dailyUnits(c: Pick<WirdConfig, 'from' | 'to' | 'dailyAmount' | 'startOffset'>, k: number): number[] {
  const length = c.to - c.from + 1;
  const amount = Math.min(c.dailyAmount, length);
  const start = (c.startOffset + k * amount) % length;
  return Array.from({ length: amount }, (_, i) => c.from + ((start + i) % length));
}

export interface ManualCheck {
  /** Units of the range assigned to no day. */
  readonly missing: number[];
  /** Units assigned to more than one day. */
  readonly duplicated: number[];
  /** Revision days without a range. */
  readonly emptyDays: Weekday[];
  /** Ranges outside the plan range, reversed, or on a non-revision day. */
  readonly invalid: DayRange[];
}

export function checkManual(c: Pick<WirdConfig, 'from' | 'to' | 'revisionDays' | 'manual'>): ManualCheck {
  const count = new Map<number, number>();
  const invalid: DayRange[] = [];
  for (const r of c.manual) {
    if (r.from > r.to || r.from < c.from || r.to > c.to || !c.revisionDays.includes(r.day)) {
      invalid.push(r);
      continue;
    }
    for (const n of unitRange(r.from, r.to)) count.set(n, (count.get(n) ?? 0) + 1);
  }
  const range = unitRange(c.from, c.to);
  return {
    missing: range.filter((n) => !count.has(n)),
    duplicated: range.filter((n) => (count.get(n) ?? 0) > 1),
    emptyDays: c.revisionDays.filter((d) => !c.manual.some((r) => r.day === d)),
    invalid,
  };
}

/** True when a manual split may be saved (gaps/repeats only with explicit consent). */
export function manualOk(check: ManualCheck, allowGaps: boolean): boolean {
  if (check.invalid.length || check.emptyDays.length) return false;
  return allowGaps || (check.missing.length === 0 && check.duplicated.length === 0);
}
