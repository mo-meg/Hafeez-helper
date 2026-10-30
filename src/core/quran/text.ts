import { fromIndex, toIndex } from './refs.ts';
import { TOTAL_AYAT } from './surahs.ts';
import { skeleton, tokenize, type Token } from './tokenize.ts';
import type { AyahRef } from './types.ts';

/** Serialized Quran text edition (verbatim from its source). */
export interface QuranTextDataset {
  readonly schema: 'hafeez-text/1';
  /** e.g. "quran-uthmani" (AlQuran.cloud identifier). */
  readonly edition: string;
  readonly label: string;
  readonly source: { readonly name: string; readonly url: string; readonly license: string; readonly retrievedAt?: string };
  /** True when the dataset is a synthetic test fixture (never real Quran text). */
  readonly synthetic?: boolean;
  /** 6236 strings in mushaf order; index 0 is 1:1. */
  readonly ayat: readonly string[];
  /** Optional SHA-256 of `ayat.join('\n')`, recorded at download time. */
  readonly sha256?: string;
}

export interface AyahText {
  readonly ref: AyahRef;
  readonly index: number;
  /** Text of the ayah itself (basmala prefix removed when detected). */
  readonly text: string;
  /** Basmala prefix that the source prepended to the first ayah of a surah, if detected. */
  readonly basmalaPrefix: string | null;
  readonly tokens: readonly Token[];
}

/** Tanzil v1.1 encoding for small yeh inside a word. */
export function applyTanzilTextEncodingUpdates(text: string): string {
  return text.replace(/\u06e6(?=[\u064b-\u065f\u0670\u06d6-\u06ed]*[\u0621-\u064a])/g, '\u0640\u06e7');
}

export class QuranText {
  readonly dataset: QuranTextDataset;
  private readonly basmalaSkeletonWords: string[] | null;
  private readonly cache = new Map<number, AyahText>();

  constructor(dataset: QuranTextDataset) {
    if (dataset.ayat.length !== TOTAL_AYAT) {
      throw new Error(`Text edition ${dataset.edition} has ${dataset.ayat.length} ayat, expected ${TOTAL_AYAT}`);
    }
    this.dataset = dataset;
    // The basmala is identified from the dataset's own text of Al-Fatihah 1:1.
    const first = dataset.ayat[0] ?? '';
    const words = skeleton(first).split(' ').filter(Boolean);
    this.basmalaSkeletonWords = words.length === 4 ? words : null;
  }

  get edition(): string {
    return this.dataset.edition;
  }

  ayah(ref: AyahRef): AyahText {
    const index = toIndex(ref);
    const cached = this.cache.get(index);
    if (cached) return cached;
    const raw = applyTanzilTextEncodingUpdates(this.dataset.ayat[index - 1] ?? '');
    let text = raw;
    let basmalaPrefix: string | null = null;
    if (ref.ayah === 1 && ref.surah !== 1 && ref.surah !== 9 && this.basmalaSkeletonWords) {
      const parts = raw.split(/\s+/u).filter(Boolean);
      const head = parts.slice(0, 4);
      if (parts.length > 4 && skeleton(head.join(' ')).split(' ').join(' ') === this.basmalaSkeletonWords.join(' ')) {
        basmalaPrefix = head.join(' ');
        text = parts.slice(4).join(' ');
      }
    }
    const result: AyahText = { ref, index, text, basmalaPrefix, tokens: tokenize(text) };
    this.cache.set(index, result);
    return result;
  }

  ayahAt(index: number): AyahText {
    return this.ayah(fromIndex(index));
  }

  /** Verbatim token at a word position, or null if the position does not exist. */
  wordAt(ref: AyahRef, position: number): string | null {
    return this.ayah(ref).tokens.find((t) => t.position === position)?.text ?? null;
  }
}
