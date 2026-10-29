/**
 * Splits a stored ayah text into display tokens WITHOUT altering any character.
 * Tokens that contain no Arabic letter (waqf/pause marks such as U+06D6..U+06DC, the rub-el-hizb
 * sign U+06DE, the sajda sign U+06E9, digits) are "marks": they are rendered but are not
 * selectable words and do not consume a word position.
 */
export interface Token {
  readonly text: string;
  /** 1-based word position among word tokens, or null for marks. */
  readonly position: number | null;
}

/**
 * Arabic letters: U+0621–U+063A, U+0641–U+064A, U+066E–U+066F, U+0671–U+06D3 (incl. alef wasla),
 * U+06D5, U+06EE–U+06EF, U+06FA–U+06FC.
 */
const ARABIC_LETTER = /[\u0621-\u063A\u0641-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06EE\u06EF\u06FA-\u06FC]/u;

/**
 * Marks removed by `skeleton` for comparison only: U+0610–U+061A (honorific/small signs),
 * U+064B–U+065F (harakat, shadda, sukun …), U+0670 (superscript alef), U+06D6–U+06ED
 * (Quranic annotation signs), U+0640 (tatweel).
 */
const COMPARISON_MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/gu;

export function isWordToken(token: string): boolean {
  return ARABIC_LETTER.test(token);
}

export function tokenize(text: string): Token[] {
  const parts = text.split(/\s+/u).filter((p) => p.length > 0);
  let position = 0;
  return parts.map((p) => (isWordToken(p) ? { text: p, position: ++position } : { text: p, position: null }));
}

export function wordCount(text: string): number {
  return tokenize(text).filter((t) => t.position !== null).length;
}

/** Removes harakat and Quranic annotation marks — used ONLY for comparisons, never for display. */
export function skeleton(text: string): string {
  return text
    .replace(COMPARISON_MARKS, '')
    .replace(/\u0671/gu, '\u0627') // alef wasla -> alef
    .replace(/\s+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => ARABIC_LETTER.test(w))
    .join(' ');
}
