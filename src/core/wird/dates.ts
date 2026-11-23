/** Local calendar date keys (YYYY-MM-DD). All Wird plans use the device's local day. */
import { localDateKey } from '../util/ids.ts';

/** 0 = Sunday … 6 = Saturday (as Date.getDay()). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

export const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateKey(k: string): Date {
  const [y, m, d] = k.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

export function isDateKey(k: string): boolean {
  if (!DATE_KEY_RE.test(k)) return false;
  return localDateKey(parseDateKey(k)) === k;
}

export function shiftDate(k: string, days: number): string {
  const d = parseDateKey(k);
  return localDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

export const weekdayOf = (k: string): Weekday => parseDateKey(k).getDay() as Weekday;

/** Whole days from a to b (b − a). */
export function dayDiff(a: string, b: string): number {
  return Math.round((parseDateKey(b).getTime() - parseDateKey(a).getTime()) / 86_400_000);
}

/** The first date of the week containing `k`, for a week starting on `weekStart`. */
export function weekStartOf(k: string, weekStart: Weekday): string {
  return shiftDate(k, -((weekdayOf(k) - weekStart + 7) % 7));
}

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let k = from; k <= to; k = shiftDate(k, 1)) out.push(k);
  return out;
}

/** Weekdays ordered from the week start (e.g. Saturday-start: Sat, Sun, … Fri). */
export function orderedWeekdays(days: readonly Weekday[], weekStart: Weekday): Weekday[] {
  return [...new Set(days)].sort((a, b) => ((a - weekStart + 7) % 7) - ((b - weekStart + 7) % 7));
}
