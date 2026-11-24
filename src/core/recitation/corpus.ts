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
  /** Comparison-only form: normalised Arabic, or the model's expected sound units (see engine.ts). */
  readonly norm: string;
  /** Normalised Arabic spelling (always; used to find well-known phrases such as the basmala). */
  readonly plain: string;
  /** A pause (waqf) sign follows this word in the mushaf, so stopping here is not hesitation. */
  readonly pauseAfter: boolean;
}

/**
 * Flat, read-only word list of the whole canonical text with a bigram index for global search.
 * Built once per text edition (~78k words); never modifies the text.
 */
/** Arabic forms of what reciters say before a passage (isti'adha, basmala). */
const ISTIADHA = ['اعوذ', 'بالله', 'من', 'الشيطان', 'الرجيم'];
const BASMALA = ['بسم', 'الله', 'الرحمن', 'الرحيم'];

/**
 * Comparison forms per ayah (global ayah index → one form per word, in reading order). When the
 * count differs from the canonical word count, forms are spread proportionally (never invented).
 */
export type ComparisonForms = (ayahIndex: number) => readonly string[] | null;

export class RecitationCorpus {
  readonly words: CorpusWord[] = [];
  readonly edition: string;
  /** 'arabic' = normalised spelling; 'units' = the recognition model's sound units. */
  readonly kind: 'arabic' | 'units';
  /** Ayat whose model word count differed from the canonical one (diagnostics). */
  readonly mismatchedAyat: number[] = [];
  readonly istiadha: readonly string[];
  readonly basmala: readonly string[];
  /** Words of the isti'adha / basmala (cheap to ignore before a passage). */
  readonly preamble: ReadonlySet<string>;
  private readonly ayahFirst: number[] = [];
  private readonly bigrams = new Map<string, number[]>();
  private readonly index: DivisionIndex | null;

  constructor(text: QuranText, index: DivisionIndex | null = null, forms: ComparisonForms | null = null) {
    this.edition = text.edition;
    this.kind = forms ? 'units' : 'arabic';
    this.index = index && index.has('page') ? index : null;
    for (let i = 1; i <= TOTAL_AYAT; i++) {
      this.ayahFirst[i] = this.words.length;
      const tokens = text.ayahAt(i).tokens;
      const ayah: CorpusWord[] = [];
      tokens.forEach((t, k) => {
        if (t.position === null) return;
        const plain = normWord(t.text);
        const next = tokens[k + 1];
        // waqf signs: U+06D6–U+06DB, either as their own token or attached to the word
        const pauseAfter = /[\u06D6-\u06DB]/u.test(t.text) || (!!next && next.position === null && /[\u06D6-\u06DB]/u.test(next.text));
        if (plain) ayah.push({ ayahIndex: i, position: t.position, text: t.text, norm: plain, plain, pauseAfter });
      });
      const f = forms ? forms(i) : null;
      if (f) {
        const mapped = mapForms(f, ayah.length);
        if (f.length !== ayah.length) this.mismatchedAyat.push(i);
        ayah.forEach((w, k) => this.words.push({ ...w, norm: mapped[k] as string }));
      } else this.words.push(...ayah);
    }
    this.ayahFirst[TOTAL_AYAT + 1] = this.words.length;
    for (let k = 0; k + 1 < this.words.length; k++) {
      const key = `${this.words[k]?.norm} ${this.words[k + 1]?.norm}`;
      const list = this.bigrams.get(key);
      if (list) list.push(k);
      else this.bigrams.set(key, [k]);
    }
    this.istiadha = this.formsOf(ISTIADHA);
    this.basmala = this.formsOf(BASMALA);
    this.preamble = new Set([...this.istiadha, ...this.basmala].filter((x) => x));
  }

  /** Comparison forms of Arabic words, taken from where they occur in the text ('' when absent). */
  private formsOf(plain: readonly string[]): string[] {
    if (this.kind === 'arabic') return [...plain];
    return plain.map((p) => this.words.find((w) => w.plain === p)?.norm ?? '');
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

/**
 * Maps `forms` onto `count` canonical words. Equal counts map one to one; otherwise each canonical
 * word gets the forms whose proportional position falls on it (concatenated), and a canonical word
 * that gets none shares its neighbour's, so no word is left without a comparison form.
 */
export function mapForms(forms: readonly string[], count: number): string[] {
  if (forms.length === count) return [...forms];
  const out: string[] = Array.from({ length: count }, () => '');
  forms.forEach((f, r) => {
    const k = Math.min(count - 1, Math.floor((r * count) / Math.max(1, forms.length)));
    out[k] += f;
  });
  for (let k = 0; k < count; k++) if (!out[k]) out[k] = out[k - 1] || out.find((x) => x) || '\uF8FF';
  return out;
}
