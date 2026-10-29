/** A canonical reference to one ayah (Hafs / Kufan numbering unless an edition says otherwise). */
export interface AyahRef {
  readonly surah: number;
  readonly ayah: number;
}

/**
 * A reference to one word token of an ayah in a specific text edition.
 * `position` is 1-based and counts only selectable word tokens (pause marks are excluded).
 * `tokenText` is a verbatim snapshot of the token from the edition, used for integrity checks;
 * it is never shown as Quran text on its own without the edition being loaded.
 */
export interface WordRef extends AyahRef {
  readonly position: number;
  readonly edition: string;
  readonly tokenText: string;
}

/** Division kinds supported by the navigation layer. */
export type DivisionKind = 'juz' | 'hizb' | 'quarter' | 'eighth' | 'page';

export interface DivisionRange {
  readonly kind: DivisionKind;
  readonly number: number;
  /** Global (1..6236) index of the first ayah, inclusive. */
  readonly startIndex: number;
  /** Global index of the last ayah, inclusive. */
  readonly endIndex: number;
  readonly start: AyahRef;
  readonly end: AyahRef;
}

export interface SurahInfo {
  readonly number: number;
  readonly ayahCount: number;
  readonly nameArabic: string;
  readonly nameTransliterated: string;
}

/** Where an ayah sits in each division system that is available. */
export interface AyahLocation {
  readonly ref: AyahRef;
  readonly index: number;
  readonly juz: number | null;
  readonly hizb: number | null;
  readonly quarter: number | null;
  /** 1..4 within the hizb. */
  readonly quarterInHizb: number | null;
  readonly eighth: number | null;
  /** 1..8 within the hizb. */
  readonly eighthInHizb: number | null;
  readonly page: number | null;
}
