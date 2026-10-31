/**
 * Pure helpers for the Quran reader's auto-scroll (focus) mode. No DOM access, so they are
 * unit-tested directly; the browser controller lives in src/ui/components/autoScroll.ts.
 */
import type { DivisionKind } from '../quran/types.ts';

export const SPEED_MIN = 1;
export const SPEED_MAX = 30;
export const SPEED_DEFAULT = 8;

/** Pixels per second at speed level 1 with the default Quran font scale. */
const BASE_PX_PER_SECOND = 2.5;

export function clampSpeed(level: unknown): number {
  const n = typeof level === 'number' && Number.isFinite(level) ? Math.round(level) : SPEED_DEFAULT;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
}

/**
 * Scroll speed in CSS pixels per second. Bigger text means taller lines, so the speed grows
 * with the font scale: the same level reads at the same pace whatever the text size.
 */
export function pxPerSecond(level: number, fontScale = 1): number {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return clampSpeed(level) * BASE_PX_PER_SECOND * scale;
}

/** Whole minutes (rounded up) needed to scroll `remainingPx` at `pxPerSec`. */
export function minutesLeft(remainingPx: number, pxPerSec: number): number {
  if (!(remainingPx > 0) || !(pxPerSec > 0)) return 0;
  return Math.ceil(remainingPx / pxPerSec / 60);
}

/** The portion that follows the one being read, as a Quran-route query; null at the very end. */
export type NextPortion = { readonly kind: DivisionKind; readonly number: number } | { readonly kind: 'surah'; readonly number: number };

export function nextPortion(
  current: { readonly division: { readonly kind: DivisionKind; readonly number: number } | null; readonly surah: number | null },
  count: (kind: DivisionKind) => number,
): NextPortion | null {
  const d = current.division;
  if (d) return d.number < count(d.kind) ? { kind: d.kind, number: d.number + 1 } : null;
  const s = current.surah ?? 1;
  return s < 114 ? { kind: 'surah', number: s + 1 } : null;
}

export function portionQuery(p: NextPortion): string {
  return `${p.kind}=${p.number}`;
}
