import type { DivisionIndex } from '../quran/divisions.ts';
import { fromIndex } from '../quran/refs.ts';
import { TOTAL_AYAT } from '../quran/surahs.ts';
import type { QuranText } from '../quran/text.ts';
import type { AyahRef } from '../quran/types.ts';
import { normWord } from './normalize.ts';

export interface CorpusWord {
  /** 1-based global ayah index (mushaf order). */
  readonly ayahIndex: number;
  /** 1-based word position inside the ayah (same numbering as mistake word marks). */
  readonly position: number;
  /** Verbatim canonical token (display / mistake snapshot). */
  readonly text: string;
  /** Comparison-only normalised form. */
  readonly norm: string;
  /** A pause (waqf) sign follows this word in the mushaf, so stopping here is not hesitation. */
  readonly pauseAfter: boolean;
}

/**
 * Flat, read-only word list of the whole canonical text with a bigram index for global search.
 * Built once per text edition (~78k words); never modifies the text.
 */
export class RecitationCorpus {
  readonly words: CorpusWord[] = [];
  readonly edition: string;
  private readonly ayahFirst: number[] = [];
  private readonly bigrams = new Map<string, number[]>();
  private readonly index: DivisionIndex | null;

  constructor(text: QuranText, index: DivisionIndex | null = null) {
    this.edition = text.edition;
    this.index = index && index.has('page') ? index : null;
    for (let i = 1; i <= TOTAL_AYAT; i++) {
      this.ayahFirst[i] = this.words.length;
      const tokens = text.ayahAt(i).tokens;
      tokens.forEach((t, k) => {
        if (t.position === null) return;
        const norm = normWord(t.text);
        const next = tokens[k + 1];
        // waqf signs: U+06D6–U+06DB, either as their own token or attached to the word
        const pauseAfter = /[\u06D6-\u06DB]/u.test(t.text) || (!!next && next.position === null && /[\u06D6-\u06DB]/u.test(next.text));
        if (norm) this.words.push({ ayahIndex: i, position: t.position, text: t.text, norm, pauseAfter });
      });
    }
    this.ayahFirst[TOTAL_AYAT + 1] = this.words.length;
    for (let k = 0; k + 1 < this.words.length; k++) {
      const key = `${this.words[k]?.norm} ${this.words[k + 1]?.norm}`;
      const list = this.bigrams.get(key);
      if (list) list.push(k);
      else this.bigrams.set(key, [k]);
    }
  }

  get size(): number {
    return this.words.length;
  }

  bigramHits(a: string, b: string): readonly number[] {
    return this.bigrams.get(`${a} ${b}`) ?? [];
  }

  /** Flat index of the first word of an ayah. */
  ayahStart(ayahIndex: number): number {
    return this.ayahFirst[ayahIndex] ?? this.words.length;
  }

  ref(flat: number): AyahRef {
    return fromIndex(this.words[Math.min(flat, this.words.length - 1)]?.ayahIndex ?? 1);
  }

  /** Madani mushaf page of a word, from the verified division metadata (null when unavailable). */
  pageAt(flat: number): number | null {
    const w = this.words[Math.min(flat, this.words.length - 1)];
    return w && this.index ? this.index.numberAt('page', w.ayahIndex) : null;
  }

  /** Flat word range [start, end) covering mushaf pages `from..to` (clamped). */
  pageSpan(from: number, to: number): [number, number] {
    if (!this.index) return [0, this.words.length];
    const last = this.index.count('page');
    const a = this.index.range('page', Math.max(1, from));
    const b = this.index.range('page', Math.min(last, to));
    return [this.ayahStart(a.startIndex), this.ayahStart(b.endIndex + 1)];
  }
}
