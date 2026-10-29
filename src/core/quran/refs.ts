import { SURAHS, SURAH_COUNT, TOTAL_AYAT, surahInfo } from './surahs.ts';
import type { AyahRef } from './types.ts';

/** Global index (1-based) of the first ayah of each surah. Derived from verified ayah counts. */
const SURAH_START_INDEX: readonly number[] = (() => {
  const starts: number[] = [];
  let running = 1;
  for (const s of SURAHS) {
    starts.push(running);
    running += s.ayahCount;
  }
  return starts;
})();

export function isValidRef(ref: { surah: number; ayah: number }): boolean {
  if (!Number.isInteger(ref.surah) || !Number.isInteger(ref.ayah)) return false;
  if (ref.surah < 1 || ref.surah > SURAH_COUNT) return false;
  return ref.ayah >= 1 && ref.ayah <= surahInfo(ref.surah).ayahCount;
}

export function assertValidRef(ref: AyahRef): void {
  if (!isValidRef(ref)) throw new RangeError(`Invalid ayah reference ${ref.surah}:${ref.ayah}`);
}

/** Canonical global index (1..6236) in mushaf order. */
export function toIndex(ref: AyahRef): number {
  assertValidRef(ref);
  return (SURAH_START_INDEX[ref.surah - 1] as number) + ref.ayah - 1;
}

export function fromIndex(index: number): AyahRef {
  if (!Number.isInteger(index) || index < 1 || index > TOTAL_AYAT) {
    throw new RangeError(`Global ayah index ${index} out of range (1..${TOTAL_AYAT})`);
  }
  // Binary search over surah starts.
  let lo = 0;
  let hi = SURAH_START_INDEX.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((SURAH_START_INDEX[mid] as number) <= index) lo = mid;
    else hi = mid - 1;
  }
  return { surah: lo + 1, ayah: index - (SURAH_START_INDEX[lo] as number) + 1 };
}

export function compareRefs(a: AyahRef, b: AyahRef): number {
  return a.surah - b.surah || a.ayah - b.ayah;
}

export function refKey(ref: AyahRef): string {
  return `${ref.surah}:${ref.ayah}`;
}

export function parseRef(text: string): AyahRef | null {
  const m = /^\s*(\d{1,3})\s*[:.]\s*(\d{1,3})\s*$/.exec(text);
  if (!m) return null;
  const ref = { surah: Number(m[1]), ayah: Number(m[2]) };
  return isValidRef(ref) ? ref : null;
}

/** Next ayah in mushaf order, crossing surah boundaries. Null after An-Nas 6. */
export function nextRef(ref: AyahRef): AyahRef | null {
  const i = toIndex(ref);
  return i >= TOTAL_AYAT ? null : fromIndex(i + 1);
}

/** Previous ayah in mushaf order, crossing surah boundaries. Null before Al-Fatihah 1. */
export function prevRef(ref: AyahRef): AyahRef | null {
  const i = toIndex(ref);
  return i <= 1 ? null : fromIndex(i - 1);
}

export function sameRef(a: AyahRef, b: AyahRef): boolean {
  return a.surah === b.surah && a.ayah === b.ayah;
}

export function formatRef(ref: AyahRef): string {
  return `${surahInfo(ref.surah).nameTransliterated} ${ref.surah}:${ref.ayah}`;
}

export function surahStartIndex(surah: number): number {
  surahInfo(surah);
  return SURAH_START_INDEX[surah - 1] as number;
}

export function surahEndIndex(surah: number): number {
  return surahStartIndex(surah) + surahInfo(surah).ayahCount - 1;
}

/** Sorts a list of objects carrying a ref in canonical Quran order (stable). */
export function sortByQuranOrder<T>(items: readonly T[], getRef: (item: T) => AyahRef): T[] {
  return items
    .map((item, i) => ({ item, i, idx: toIndex(getRef(item)) }))
    .sort((a, b) => a.idx - b.idx || a.i - b.i)
    .map((x) => x.item);
}
