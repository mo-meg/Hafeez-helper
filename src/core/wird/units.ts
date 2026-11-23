/**
 * Quran revision units of the Wird Planner. 1 juz = 2 hizb = 8 rub' (quarters) by definition, so
 * every unit maps to a span of quarters without any downloaded data. Quarter spans are the common
 * currency for overlap, containment, merging and equivalents between plans of different units.
 */
export const WIRD_UNITS = ['juz', 'hizb', 'quarter'] as const;
export type WirdUnit = (typeof WIRD_UNITS)[number];

export const UNIT_COUNT: Readonly<Record<WirdUnit, number>> = { juz: 30, hizb: 60, quarter: 240 };
/** Quarters per unit. */
export const UNIT_QUARTERS: Readonly<Record<WirdUnit, number>> = { juz: 8, hizb: 4, quarter: 1 };

/** Inclusive quarter span (1..240). */
export interface QuarterSpan {
  readonly from: number;
  readonly to: number;
}

export function isValidUnit(unit: WirdUnit, n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= UNIT_COUNT[unit];
}

export function quarterSpan(unit: WirdUnit, n: number): QuarterSpan {
  if (!isValidUnit(unit, n)) throw new RangeError(`${unit} ${n} does not exist`);
  const q = UNIT_QUARTERS[unit];
  return { from: (n - 1) * q + 1, to: n * q };
}

export function rangeQuarterSpan(unit: WirdUnit, from: number, to: number): QuarterSpan {
  return { from: quarterSpan(unit, from).from, to: quarterSpan(unit, to).to };
}

export const spanContains = (outer: QuarterSpan, inner: QuarterSpan) => outer.from <= inner.from && inner.to <= outer.to;
export const spansOverlap = (a: QuarterSpan, b: QuarterSpan) => a.from <= b.to && b.from <= a.to;

/** Unit numbers from..to inclusive. */
export function unitRange(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

/**
 * The same quarter span expressed in another unit, when it lines up exactly with that unit's
 * boundaries (e.g. Hizb 13–30 = Juz 7–15). Null when it does not (Hizb 2–3 is not whole juz).
 */
export function convertSpan(span: QuarterSpan, unit: WirdUnit): { from: number; to: number } | null {
  const q = UNIT_QUARTERS[unit];
  if ((span.from - 1) % q !== 0 || span.to % q !== 0) return null;
  return { from: (span.from - 1) / q + 1, to: span.to / q };
}

/** Splits sorted unit numbers into consecutive runs: [1,2,3,7,8] → [[1,3],[7,8]]. */
export function runs(numbers: readonly number[]): Array<{ from: number; to: number }> {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const out: Array<{ from: number; to: number }> = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && last.to === n - 1) last.to = n;
    else out.push({ from: n, to: n });
  }
  return out;
}

export type RangeError_ = 'unit' | 'order';

/** Validates a plan range; returns null when valid. */
export function validateRange(unit: WirdUnit, from: number, to: number): RangeError_ | null {
  if (!isValidUnit(unit, from) || !isValidUnit(unit, to)) return 'unit';
  if (from > to) return 'order';
  return null;
}
