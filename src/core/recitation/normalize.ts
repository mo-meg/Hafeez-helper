import { skeleton } from '../quran/tokenize.ts';

/**
 * Comparison-only normalisation of Arabic words (canonical text and ASR output alike).
 * Never used for display: the canonical Quran text is always rendered verbatim.
 * Folds hamza seats, alef forms, ta marbuta and alef maqsura so that Uthmani spelling
 * (e.g. ٱلصَّلَوٰةَ) and the model's plain spelling (الصلاة) compare as near-equal.
 */
export function normWord(word: string): string {
  return skeleton(word)
    // KFGQPC Quranic marks outside the shared skeleton set, e.g. open tanween U+08F0–U+08F2 in رَحۡمَةࣰ
    .replace(/[\u08D3-\u08FF]/gu, '')
    .replace(/[آأإٱٲٳ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/ئ/gu, 'ي')
    .replace(/ؤ/gu, 'و')
    .replace(/ة/gu, 'ه')
    .replace(/ء/gu, '')
    .replace(/[ۥۦ]/gu, '')
    .replace(/\s+/gu, '');
}

/** Splits an ASR transcript into normalised words (empty tokens dropped). */
export function normWords(text: string): string[] {
  return text.split(/\s+/u).map(normWord).filter((w) => w.length > 0);
}

/**
 * Letter pairs that differ only in emphasis/articulation (e.g. ص/س, ض/د). Measured on a real user
 * recording: the model sometimes writes the plain letter for a correctly recited emphatic one, so
 * these cost half. A pronunciation slip is a tajweed matter, not a memorisation mistake.
 */
const CLOSE = new Set(['صس', 'ضد', 'ضظ', 'ظز', 'ظذ', 'ذز', 'طت', 'قك', 'حه', 'عا', 'ثس', 'ذد', 'غخ'].flatMap((p) => [p, `${p[1]}${p[0]}`]));

/** Levenshtein-based similarity in [0, 1]. Long-vowel variants (ا/و/ي) and close letters cost half. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const vowel = (c: string | undefined) => c === 'ا' || c === 'و' || c === 'ي';
  const cost = (c: string | undefined) => (vowel(c) ? 0.5 : 1);
  let prev = [0];
  for (let j = 1; j <= b.length; j++) prev.push((prev[j - 1] as number) + cost(b[j - 1]));
  let rowStart = 0;
  for (let i = 1; i <= a.length; i++) {
    rowStart += cost(a[i - 1]);
    const cur = [rowStart];
    for (let j = 1; j <= b.length; j++) {
      const ca = a[i - 1];
      const cb = b[j - 1];
      const sub = ca === cb ? 0 : (vowel(ca) && vowel(cb)) || CLOSE.has(`${ca}${cb}`) ? 0.5 : 1;
      cur.push(Math.min((prev[j] as number) + cost(ca), (cur[j - 1] as number) + cost(cb), (prev[j - 1] as number) + sub));
    }
    prev = cur;
  }
  return Math.max(0, 1 - (prev[b.length] as number) / Math.max(a.length, b.length));
}
