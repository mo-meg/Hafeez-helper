/**
 * SYNTHETIC RECITATION FIXTURE — NOT QURAN TEXT.
 * Every "ayah" is made of distinct pseudo-random 4-letter Arabic letter strings so that passage
 * identification can be tested deterministically. Ayat 3:5 and 40:5 are deliberately identical
 * to test ambiguity handling. Page boundaries come from the synthetic division fixture.
 */
import type { HypWord } from '../../src/core/recitation/align.ts';
import { RecitationCorpus } from '../../src/core/recitation/corpus.ts';
import { normWord } from '../../src/core/recitation/normalize.ts';
import { DivisionIndex } from '../../src/core/quran/divisions.ts';
import { toIndex } from '../../src/core/quran/refs.ts';
import { TOTAL_AYAT } from '../../src/core/quran/surahs.ts';
import { QuranText, type QuranTextDataset } from '../../src/core/quran/text.ts';
import type { AyahRef } from '../../src/core/quran/types.ts';
import { syntheticDivisions } from './synthetic.ts';

const LETTERS = 'بتثجحخدذرزسشصضطظعغفقكلمنه';

export function recitationText(): QuranTextDataset {
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const word = () => Array.from({ length: 4 }, () => LETTERS[Math.floor(rnd() * LETTERS.length)]).join('');
  const ayat: string[] = [];
  for (let i = 1; i <= TOTAL_AYAT; i++) ayat.push(Array.from({ length: 6 + (i % 5) }, word).join(' '));
  ayat[toIndex({ surah: 40, ayah: 5 }) - 1] = ayat[toIndex({ surah: 3, ayah: 5 }) - 1] as string;
  return { schema: 'hafeez-text/1', edition: 'synthetic-recitation', label: 'SYNTHETIC — NOT QURAN TEXT', source: { name: 'test', url: 'tests/fixtures/recitation.ts', license: 'MIT' }, synthetic: true, ayat };
}

let cached: { corpus: RecitationCorpus; text: QuranText; index: DivisionIndex } | null = null;
export function recitationCorpus() {
  if (!cached) {
    const text = new QuranText(recitationText());
    const index = new DivisionIndex(syntheticDivisions({ withPages: true }));
    cached = { corpus: new RecitationCorpus(text, index), text, index };
  }
  return cached;
}

/** Canonical words of an ayah as hypothesis words (what a perfect model would output). */
export function ayahWords(ref: AyahRef): HypWord[] {
  const { text } = recitationCorpus();
  return text.ayah(ref).tokens.filter((t) => t.position !== null).map((t) => ({ norm: normWord(t.text), raw: t.text }));
}

export function flatWords(from: number, count: number): HypWord[] {
  const { corpus } = recitationCorpus();
  return corpus.words.slice(from, from + count).map((w) => ({ norm: w.norm, raw: w.text }));
}

export const junk = (n: number, tag = 'ق'): HypWord[] => Array.from({ length: n }, (_, i) => ({ norm: `ءءء${tag}${i}`.replace(/ء/g, 'ڤ'), raw: 'x' }));
