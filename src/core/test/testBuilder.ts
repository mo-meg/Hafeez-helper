import { isTransitionMistake, isUnresolved, RECALL_OUTCOMES, type Mistake, type MistakeCategory, type RecallOutcome } from '../model.ts';
import { fromIndex } from '../quran/refs.ts';
import { scopeContains, type IndexInterval } from '../quran/scope.ts';
import type { AyahRef } from '../quran/types.ts';

/**
 * Recall test built from recorded mistakes.
 *
 * Every card shows the previous ayah in full as context (none before 1:1).
 * - "within" card: a mistake inside an ayah. The ayah is shown up to the first marked word;
 *   that word and everything after it, to the end of the ayah, is hidden.
 * - "transition" card: a "Linking ayat" mistake, a mistake on the first word, or a whole-ayah
 *   mark. The whole ayah is hidden.
 * One card per ayah. With several mistakes in one ayah the card has one SEGMENT per mistake:
 * revealing (or hinting) stops just before the next mistake, which stays hidden until the
 * current one is answered.
 */
export type TestCardKind = 'within' | 'transition';

export interface TestCard {
  readonly id: string;
  readonly globalIndex: number;
  readonly ref: AyahRef;
  readonly kind: TestCardKind;
  readonly mistakeIds: readonly string[];
  readonly categories: readonly MistakeCategory[];
  /** Word positions marked in this ayah (sorted). */
  readonly markedPositions: readonly number[];
  /** First hidden word position; 1 means the whole ayah is hidden. */
  readonly hideFrom: number;
  /** Previous ayah, shown in full before the target on every card; null only for 1:1. */
  readonly promptIndex: number | null;
  /** One step per mistake position, in reading order. */
  readonly segments: readonly TestSegment[];
}

export interface TestSegment {
  /** First hidden word position of this step. */
  readonly from: number;
  /** Last word position revealed by this step; null = to the end of the ayah. */
  readonly to: number | null;
  /** Mistakes answered in this step. */
  readonly mistakeIds: readonly string[];
}

function buildSegments(ms: readonly Mistake[], transition: boolean): TestSegment[] {
  // Transition / whole-ayah marks belong to the start of the ayah (position 1).
  const posOf = (m: Mistake) => (m.word && !(m.category === 'ayah_transition' && m.word.position !== 1) ? m.word.position : 1);
  const starts = [...new Set([...(transition ? [1] : []), ...ms.map(posOf)])].sort((a, b) => a - b);
  return starts.map((from, i) => {
    const next = starts[i + 1];
    return { from, to: next === undefined ? null : next - 1, mistakeIds: ms.filter((m) => posOf(m) === from).map((m) => m.id) };
  });
}

export interface TestOptions {
  /** Also test mistakes already marked resolved. */
  readonly includeResolved?: boolean;
  /** Shuffle the cards (deterministic for a given seed); default is Quran order. */
  readonly shuffle?: boolean;
  readonly seed?: number;
}

/** Small deterministic PRNG (mulberry32) so shuffles are reproducible in tests. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildTestCards(mistakes: readonly Mistake[], scope: readonly IndexInterval[], options: TestOptions = {}): TestCard[] {
  const selected = mistakes.filter((m) => scopeContains(scope, m.globalIndex) && (options.includeResolved || isUnresolved(m.status)));
  const byAyah = new Map<number, Mistake[]>();
  for (const m of selected) byAyah.set(m.globalIndex, [...(byAyah.get(m.globalIndex) ?? []), m]);
  const cards: TestCard[] = [...byAyah.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([globalIndex, ms]) => {
      const transition = ms.some(isTransitionMistake);
      const positions = [...new Set(ms.flatMap((m) => (m.word ? [m.word.position] : [])))].sort((a, b) => a - b);
      const hideFrom = transition ? 1 : (positions[0] ?? 1);
      return {
        id: `t${globalIndex}`,
        globalIndex,
        ref: fromIndex(globalIndex),
        kind: transition ? 'transition' : 'within',
        mistakeIds: ms.map((m) => m.id),
        categories: [...new Set(ms.map((m) => m.category))],
        markedPositions: positions,
        hideFrom,
        promptIndex: globalIndex > 1 ? globalIndex - 1 : null,
        segments: buildSegments(ms, transition),
      };
    });
  if (options.shuffle) {
    const rand = rng(options.seed ?? 1);
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [cards[i], cards[j]] = [cards[j] as TestCard, cards[i] as TestCard];
    }
  }
  return cards;
}

/** Reveal state of one card. Positions are 1-based word positions of the target ayah. */
export interface RevealState {
  /** Index of the current step (mistake) within the card. */
  readonly segment: number;
  /** Highest visible word position (everything after it is hidden). */
  readonly revealedThrough: number;
  /** Hints used in the current step. */
  readonly hintsUsed: number;
  /** The current step is fully revealed (ready to answer). */
  readonly segmentRevealed: boolean;
}

export function initialReveal(card: TestCard): RevealState {
  return { segment: 0, revealedThrough: card.hideFrom - 1, hintsUsed: 0, segmentRevealed: false };
}

/** Last word position the current step may reveal (just before the next mistake). */
export function segmentEnd(card: TestCard, state: RevealState, wordCount: number): number {
  const to = card.segments[state.segment]?.to ?? null;
  return to === null ? wordCount : Math.min(to, wordCount);
}

/** Uncovers one more word, never past the end of the current step. */
export function hint(card: TestCard, state: RevealState, wordCount: number): RevealState {
  if (state.segmentRevealed) return state;
  const limit = segmentEnd(card, state, wordCount);
  const through = Math.min(limit, state.revealedThrough + 1);
  return { ...state, revealedThrough: through, hintsUsed: state.hintsUsed + 1, segmentRevealed: through >= limit };
}

/** Reveals the current step up to (not including) the next mistake. */
export function revealSegment(card: TestCard, state: RevealState, wordCount: number): RevealState {
  return { ...state, revealedThrough: segmentEnd(card, state, wordCount), segmentRevealed: true };
}

/** Moves to the next mistake of the same ayah, or returns null after the last one. */
export function nextSegment(card: TestCard, state: RevealState): RevealState | null {
  if (state.segment + 1 >= card.segments.length) return null;
  return { segment: state.segment + 1, revealedThrough: state.revealedThrough, hintsUsed: 0, segmentRevealed: false };
}

export function isWordVisible(_card: TestCard, state: RevealState, position: number): boolean {
  return position <= state.revealedThrough;
}

/** Using a hint means the step needed a prompt, so the "correct" outcomes are no longer allowed. */
export function allowedOutcomes(state: RevealState): readonly RecallOutcome[] {
  return state.hintsUsed > 0 ? ['needed_prompt', 'mistake_again'] : RECALL_OUTCOMES;
}

/** Total number of answers a test asks for (one per step). */
export function totalSteps(cards: readonly TestCard[]): number {
  return cards.reduce((n, c) => n + c.segments.length, 0);
}
