import type { AyahRef } from '../quran/types.ts';
import { align, MATCH_SIM, search, type Alignment, type HypWord } from './align.ts';
import { similarity } from './normalize.ts';
import type { RecitationCorpus } from './corpus.ts';

/**
 * What the reciter sees for a word. There is no "checking" state: a word the tracker is still unsure
 * about shows as correct straight away and turns red only once a mistake is confirmed. Repeating
 * words (going back to re-recite) is normal and never marked.
 */
export type WordStatus = 'correct' | 'incorrect' | 'skipped' | 'hesitation';
/** Internal state: a suspected mistake waits ('pending') and a not-clearly-heard word is 'uncertain'. */
type InnerStatus = WordStatus | 'uncertain' | 'pending';
export type FindingKind = 'incorrect' | 'skipped' | 'hesitation';
/**
 * What counts as a wrong word. 'memorization': only words left out or clearly changed (letters and
 * vowels are not judged). 'vowels': a word must also match letter for letter, vowel for vowel.
 */
export type CheckLevel = 'memorization' | 'vowels';
export type TrackerMode = 'searching' | 'focused';

/** A detected event, keyed by canonical word. Only `incorrect`/`skipped`/`hesitation` are mistakes. */
export interface Finding {
  readonly key: string;
  readonly kind: FindingKind;
  readonly flat: number;
  readonly ref: AyahRef;
  readonly position: number;
  /** Verbatim canonical token (never the transcript). */
  readonly tokenText: string;
  /** What the model heard (comparison form), for substitutions. */
  readonly heard: string | null;
  /** Session audio time in ms. */
  readonly atMs: number;
}

export interface RecognisedChunk {
  readonly words: readonly HypWord[];
  /** Session time (ms) of the chunk start/end. */
  readonly startMs: number;
  readonly endMs: number;
  /** Silence immediately before this chunk (ms). */
  readonly silenceBeforeMs: number;
  /**
   * The segmenter located these words by searching the text (not near the cursor): the flat index of
   * the first word. While searching, the tracker takes this place directly instead of searching again.
   */
  readonly anchor?: number;
}

export interface TrackerConfig {
  /** Delay before a suspected mistake is confirmed (self-correction window), ms of audio. */
  readonly confirmMs: number;
  /** Words the reciter must move past a suspected mistake before it is confirmed. */
  readonly confirmWords: number;
  /** A pause at least this long inside an ayah counts as hesitation. */
  readonly hesitationMs: number;
  /** ASR word confidence below this is never treated as a mistake. */
  readonly minConfidence: number;
  /** Consecutive unreliable chunks before falling back to broader search. */
  readonly lostAfter: number;
  /** Words of history kept while searching. */
  readonly searchWords: number;
  /** A missing word inside a recognised gap at least this long is "not clearly heard", not skipped. */
  readonly unheardGapMs: number;
  /** After losing track, a re-located position at most this many words ahead marks the gap skipped. */
  readonly maxSkipWords: number;
  /** Lowest sound-unit similarity of a recited word that still counts as correct. */
  readonly okSim: number;
  /**
   * Once the place is known the reciter can only move on to the next few ayat (or go back to the
   * previous one): the text is never searched elsewhere, so a similar passage in another surah
   * cannot take over. Ayat allowed after the current one / before it.
   */
  readonly lockAheadAyat: number;
  readonly lockBackAyat: number;
  /** Skipped words are reported only in runs of at least this many (a lone unheard word is not). */
  readonly minSkipRun: number;
}

/**
 * Similarity needed per check level. In memorization mode a word with a few different sound units
 * (a vowel, a letter) is still the right word; only a clearly different word is wrong. In vowels
 * mode the units must match (one stray unit in a long word is tolerated).
 */
export const CHECK_OK_SIM: Record<CheckLevel, number> = { memorization: 0.45, vowels: 0.9 };

/** How readily suspected mistakes are reported. */
export type Sensitivity = 'lenient' | 'normal' | 'strict';

/**
 * Per sensitivity: the similarity needed relative to the check level, the self-correction wait,
 * the words to move past, the lowest model confidence still judged, and the shortest skipped run.
 */
export const SENSITIVITY: Record<Sensitivity, { okSim: Record<CheckLevel, number>; confirmMs: number; confirmWords: number; minConfidence: number; minSkipRun: number }> = {
  lenient: { okSim: { memorization: 0.3, vowels: 0.8 }, confirmMs: 2500, confirmWords: 3, minConfidence: 0.65, minSkipRun: 2 },
  normal: { okSim: CHECK_OK_SIM, confirmMs: 1500, confirmWords: 2, minConfidence: 0.5, minSkipRun: 1 },
  strict: { okSim: { memorization: 0.6, vowels: 0.95 }, confirmMs: 1000, confirmWords: 1, minConfidence: 0.35, minSkipRun: 1 },
};

export function trackerConfigFor(level: CheckLevel, sensitivity: Sensitivity = 'normal'): Partial<TrackerConfig> {
  const s = SENSITIVITY[sensitivity];
  return { okSim: s.okSim[level], confirmMs: s.confirmMs, confirmWords: s.confirmWords, minConfidence: s.minConfidence, minSkipRun: s.minSkipRun };
}

/**
 * Removes a leading isti'adha / basmala said before reciting (measured on a real recording:
 * «أعوذ بالله من الشيطان الرجيم» otherwise locks onto An-Nahl 16:98). A basmala is kept while
 * nothing follows it, so Al-Fatihah 1:1 can still be found once the next words arrive.
 */
export function stripPreamble(words: readonly HypWord[], corpus: Pick<RecitationCorpus, 'istiadha' | 'basmala'>): HypWord[] {
  let out = [...words];
  const ISTIADHA = corpus.istiadha;
  const BASMALA = corpus.basmala;
  // Sound units of a phrase vary a little with the joins between words, so a close match counts.
  const same = (a: string | undefined, b: string | undefined) => !!a && !!b && (a === b || similarity(a, b) >= MATCH_SIM);
  const starts = (seq: readonly string[], minLen: number) => {
    let n = 0;
    while (n < seq.length && n < out.length && same(out[n]?.norm, seq[n])) n++;
    return n >= minLen || (n === out.length && n > 0 && n < seq.length) ? n : 0;
  };
  const a = starts(ISTIADHA, 3);
  if (a) out = out.slice(a);
  const b = starts(BASMALA, 4);
  if (b === 4 && out.length > 4) out = out.slice(4);
  return out;
}

/** Tuned for fast recitation (hadr): mistakes confirm sooner, only long pauses count as hesitation. */
export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  confirmMs: 1500,
  confirmWords: 2,
  hesitationMs: 6000,
  minConfidence: 0.5,
  lostAfter: 2,
  searchWords: 14,
  unheardGapMs: 650,
  maxSkipWords: 40,
  okSim: CHECK_OK_SIM.memorization,
  lockAheadAyat: 2,
  lockBackAyat: 1,
  minSkipRun: 1,
};

interface Pending {
  readonly kind: 'incorrect' | 'skipped';
  readonly atMs: number;
  readonly heard: string | null;
}

export interface TrackerSnapshot {
  readonly mode: TrackerMode;
  readonly cursor: number | null;
  readonly location: { readonly ref: AyahRef; readonly position: number; readonly page: number | null } | null;
  readonly status: ReadonlyMap<number, WordStatus>;
  readonly findings: readonly Finding[];
  readonly recitedWords: number;
  readonly selfCorrections: number;
}

/**
 * Follows a recitation through the canonical text. Pure and deterministic: it only consumes
 * recognised words (from any engine) and never changes Quran content.
 *
 * Stage A (searching): match the rolling word buffer against the whole Quran (or, after losing
 * track, first the pages around the last known place) until one passage is confidently identified.
 * Stage B (focused): align each new chunk against a small window after the cursor on the current
 * and next page. Unreliable chunks are not highlighted; repeated failures fall back to Stage A.
 */
export class RecitationTracker {
  readonly corpus: RecitationCorpus;
  readonly config: TrackerConfig;
  mode: TrackerMode = 'searching';
  cursor: number | null = null;
  private lastKnown: number | null = null;
  private buffer: HypWord[] = [];
  private carryHyp: HypWord[] = [];
  /** Last recognised word placed in the text (for gaps that span two recognition steps). */
  private lastHeard: { flat: number; endMs: number } | null = null;
  /** Words matched in the latest focused steps, re-examined when tracking is lost. */
  private recent: { flat: number; word: HypWord }[] = [];
  private takenBack: { flat: number; word: HypWord }[] = [];
  private poorHyp: HypWord[] = [];
  private poor = 0;
  private readonly status = new Map<number, InnerStatus>();
  private readonly pending = new Map<number, Pending>();
  private readonly findingKeys = new Set<string>();
  private readonly found: Finding[] = [];
  private selfCorrections = 0;
  private nowMs = 0;

  constructor(corpus: RecitationCorpus, config: Partial<TrackerConfig> = {}) {
    this.corpus = corpus;
    this.config = { ...DEFAULT_TRACKER_CONFIG, ...config };
  }

  push(chunk: RecognisedChunk): void {
    this.nowMs = Math.max(this.nowMs, chunk.endMs);
    if (chunk.words.length) {
      if (this.mode === 'searching') this.searchStep(chunk);
      else this.focusedStep(chunk);
    }
    this.confirmDue(false);
  }

  /**
   * Flat word range [from, to) the recitation may continue in, or null while the place was never
   * found (then the whole Quran is searched). From the start of the previous ayah to the end of
   * the ayah `lockAheadAyat` after the current one.
   */
  bounds(): [number, number] | null {
    const base = this.mode === 'focused' ? this.cursor : this.lastKnown;
    if (base === null) return null;
    const size = this.corpus.size;
    const ayah = this.corpus.words[Math.min(Math.max(0, base), size - 1)]?.ayahIndex;
    if (ayah === undefined) return null;
    const from = this.corpus.ayahStart(Math.max(1, ayah - this.config.lockBackAyat));
    const to = Math.min(size, this.corpus.ayahStart(ayah + this.config.lockAheadAyat + 1));
    return [Math.min(from, base), Math.max(to, Math.min(size, base + 1))];
  }

  /** Confirms everything still pending (call when the session ends). */
  finish(): void {
    if (this.carryHyp.length && this.mode === 'focused') {
      const words = this.carryHyp;
      this.carryHyp = [];
      const t = words[words.length - 1]?.endMs ?? this.nowMs;
      this.focusedStep({ words, startMs: words[0]?.startMs ?? t, endMs: t, silenceBeforeMs: 0 }, true);
    }
    this.confirmDue(true);
  }

  snapshot(): TrackerSnapshot {
    const c = this.cursor;
    const at = c === null ? null : Math.min(c, this.corpus.size - 1);
    const w = at === null ? null : this.corpus.words[at];
    let recited = 0;
    const shown = new Map<number, WordStatus>();
    for (const [k, s] of this.status) {
      if (s !== 'skipped') recited++;
      shown.set(k, s === 'pending' || s === 'uncertain' ? 'correct' : s);
    }
    return {
      mode: this.mode,
      cursor: c,
      location: w && at !== null ? { ref: this.corpus.ref(at), position: w.position, page: this.corpus.pageAt(at) } : null,
      status: shown,
      findings: [...this.found],
      recitedWords: recited,
      selfCorrections: this.selfCorrections,
    };
  }

  // ------------------------------------------------------------------ stage A
  private searchStep(chunk: RecognisedChunk): void {
    this.buffer = stripPreamble([...this.buffer, ...chunk.words], this.corpus);
    if (this.buffer.length > this.config.searchWords) this.buffer = this.buffer.slice(-this.config.searchWords);
    let res: ReturnType<typeof search> | null = null;
    const lock = this.bounds();
    if (chunk.anchor !== undefined && (!lock || (chunk.anchor >= lock[0] && chunk.anchor < lock[1]))) {
      // The segmenter already found the place (e.g. an ayah opening): check it with a fixed start.
      const words = chunk.words;
      const a = align(this.corpus, words, chunk.anchor, chunk.anchor + words.length * 2 + 6);
      if (a.end !== null && a.matches >= Math.max(1, words.length * 0.5)) {
        this.buffer = [...words];
        res = { best: { alignment: a, cursor: a.end, score: a.matches }, second: null, confident: true };
      }
    }
    if (!res && lock) {
      // The place is known: only the next ayat (or the previous one) are possible, never elsewhere.
      const local = search(this.corpus, this.buffer, { window: lock, minRun: 2 });
      if (local.confident) res = local;
      if (!res) return;
    }
    if (!res && this.lastKnown !== null) {
      const page = this.corpus.pageAt(this.lastKnown);
      const win = page === null ? [Math.max(0, this.lastKnown - 150), this.lastKnown + 300] as const : this.corpus.pageSpan(page - 1, page + 2);
      const local = search(this.corpus, this.buffer, { window: win, minRun: 3 });
      if (local.confident) res = local;
    }
    res ??= search(this.corpus, this.buffer);
    if (!res.confident || !res.best) return;
    const first = res.best.alignment.first;
    // Taken-back words that the new place does not explain stay where they were.
    const placed = new Set(res.best.alignment.ops.flatMap((o) => (o.op === 'match' || o.op === 'near' ? [this.buffer[o.hyp]] : [])));
    for (const r of this.takenBack) {
      if (!placed.has(r.word)) {
        this.status.set(r.flat, 'correct');
        if (this.lastKnown !== null && r.flat >= this.lastKnown) this.lastKnown = r.flat + 1;
      }
    }
    this.takenBack = [];
    if (this.lastKnown !== null && first !== null && first > this.lastKnown && first - this.lastKnown <= this.config.maxSkipWords) {
      for (let k = this.lastKnown; k < first; k++) if (!this.status.has(k) || this.status.get(k) === 'pending') this.suspect(k, 'skipped', null, chunk.startMs);
    }
    this.apply(res.best.alignment, this.buffer, chunk, false);
    this.cursor = res.best.cursor;
    this.lastKnown = this.cursor;
    this.mode = 'focused';
    this.poor = 0;
    this.buffer = [];
  }

  // ------------------------------------------------------------------ stage B
  private focusedStep(chunk: RecognisedChunk, last = false): void {
    const cursor = this.cursor as number;
    // Words that were too few to judge last time are judged together with the new ones.
    const carried = this.carryHyp.length;
    const hyp = carried ? [...this.carryHyp, ...chunk.words] : chunk.words;
    this.carryHyp = [];
    if (hyp.length < 2 && !last) {
      this.carryHyp = [...hyp]; // one word alone is too ambiguous to place (continue vs. go back)
      return;
    }
    const page = this.corpus.pageAt(cursor);
    const [pFrom, pTo0] = page === null ? [0, this.corpus.size] : this.corpus.pageSpan(page, page + 1);
    const lockTo = this.bounds()?.[1] ?? this.corpus.size;
    const pTo = Math.min(pTo0, lockTo);
    let best: { a: Alignment; back: number } | null = null;
    // Try continuing at the cursor, or going back up to 8 words (repetition / self-correction).
    for (let back = 0; back <= 8; back++) {
      const s = cursor - back;
      if (s < 0 || s < pFrom - 8) break;
      const a = align(this.corpus, hyp, s, Math.min(pTo + 20, lockTo, s + hyp.length * 2 + 6));
      const cost = a.cost + back * 0.15;
      if (!best || cost < best.a.cost + best.back * 0.15) best = { a, back };
    }
    const a = best?.a;
    const reliable = !!a && a.end !== null && a.matches >= Math.max(0.5, hyp.length * 0.45);
    if ((!a || !reliable) && hyp.length < 3 && !last) {
      this.carryHyp = [...hyp];
      return;
    }
    if (!a || !reliable) {
      this.poor++;
      this.poorHyp.push(...hyp);
      if (this.poor >= this.config.lostAfter) {
        // The last few words before losing track may already belong to the new place (e.g. two
        // ayat that start alike): take them back and let the search place them again.
        const back = this.recent.filter((r) => ['correct', 'uncertain', 'pending'].includes(this.status.get(r.flat) ?? ''));
        for (const r of back) {
          this.status.delete(r.flat);
          this.pending.delete(r.flat);
        }
        this.lastKnown = back[0]?.flat ?? cursor;
        this.mode = 'searching';
        this.buffer = [...back.map((r) => r.word), ...this.poorHyp];
        this.poorHyp = [];
        this.takenBack = back;
        this.recent = [];
      }
      return;
    }
    this.poor = 0;
    this.poorHyp = [];
    if (!carried && chunk.silenceBeforeMs >= this.config.hesitationMs) this.hesitation(a.first ?? cursor, chunk.startMs);
    this.apply(a, hyp, chunk, true);
    this.cursor = a.end as number;
    this.lastKnown = this.cursor;
  }

  private apply(a: Alignment, hyp: readonly HypWord[], chunk: RecognisedChunk, fixedStart: boolean): void {
        let lastWordEnd: number | null = null;
    let seenMatch = false;
    for (const o of a.ops) {
      if (o.op === 'ins') continue; // extra words (repetition, noise) are never marked
      if (o.op === 'del') {
        if (!seenMatch && !fixedStart) continue;
        const prior = this.status.get(o.ref);
        if (prior !== undefined && prior !== 'pending') continue;
        if (this.unheardGap(a, o.ref, hyp)) this.status.set(o.ref, 'uncertain');
        else this.suspect(o.ref, 'skipped', null, chunk.startMs);
        continue;
      }
      // Search: words before the first match are noise/preamble, not substitutions.
      if (!fixedStart && !seenMatch && o.op === 'sub') continue;
      const w = hyp[o.hyp];
      const t = w?.startMs ?? chunk.startMs;
      if (lastWordEnd !== null && w?.startMs !== undefined && w.startMs - lastWordEnd >= this.config.hesitationMs) this.hesitation(o.ref, w.startMs);
      if (w?.endMs !== undefined) lastWordEnd = w.endMs;
      const prior = this.status.get(o.ref);
      if (w?.endMs !== undefined) this.lastHeard = { flat: o.ref, endMs: w.endMs };
      if (fixedStart && w) this.recent = [...this.recent, { flat: o.ref, word: w }].slice(-4);
      if (o.op === 'match' || o.op === 'near') seenMatch = true;
      const ok = o.sim >= this.config.okSim;
      const lowConf = w?.confidence !== undefined && w.confidence < this.config.minConfidence;
      if (ok) {
        if (this.pending.has(o.ref)) {
          this.pending.delete(o.ref);
          this.selfCorrections++;
          this.status.set(o.ref, 'correct');
        } else if (prior === undefined || prior === 'uncertain') this.status.set(o.ref, 'correct');
      } else if (lowConf) {
        if (prior === undefined || prior === 'pending') {
          this.pending.delete(o.ref);
          this.status.set(o.ref, 'uncertain');
        }
      } else if (prior === undefined || prior === 'uncertain') this.suspect(o.ref, 'incorrect', w?.raw || w?.norm || null, t);
    }
  }

  /**
   * True when the model's word timestamps show a long stretch of audio where the missing word
   * would be: something was said there but not recognised, so it is not evidence of a skip.
   */
  private unheardGap(a: Alignment, ref: number, hyp: readonly HypWord[]): boolean {
    let before: HypWord | undefined;
    let after: HypWord | undefined;
    for (const o of a.ops) {
      if (o.op === 'del' || o.op === 'ins') continue;
      if (o.ref < ref) before = hyp[o.hyp];
      else if (o.ref > ref) {
        after = hyp[o.hyp];
        break;
      }
    }
    if (before === undefined && this.lastHeard && this.lastHeard.flat < ref) before = { norm: '', raw: '', endMs: this.lastHeard.endMs };
    if (before?.endMs === undefined || after?.startMs === undefined) return false;
    return after.startMs - before.endMs >= this.config.unheardGapMs;
  }

  private suspect(flat: number, kind: Pending['kind'], heard: string | null, atMs: number): void {
    this.status.set(flat, 'pending');
    this.pending.set(flat, { kind, heard, atMs });
  }

  private hesitation(flat: number, atMs: number): void {
    const w = this.corpus.words[flat];
    const prev = this.corpus.words[flat - 1];
    if (!w || w.position === 1 || prev?.pauseAfter) return; // pausing between ayat or at a waqf sign is normal
    this.record('hesitation', flat, null, atMs);
    if (!this.status.has(flat)) this.status.set(flat, 'hesitation');
  }

  private confirmDue(all: boolean): void {
    const cursor = this.cursor ?? 0;
    for (const [flat, p] of [...this.pending]) {
      const due = all || (this.nowMs - p.atMs >= this.config.confirmMs && cursor >= flat + 1 + this.config.confirmWords);
      if (!due) continue;
      if (p.kind === 'skipped' && this.skipRun(flat) < this.config.minSkipRun) {
        // A lone missing word is more likely swallowed in fast recitation than left out.
        this.pending.delete(flat);
        this.status.set(flat, 'uncertain');
        continue;
      }
      this.pending.delete(flat);
      this.status.set(flat, p.kind);
      this.record(p.kind, flat, p.heard, p.atMs);
    }
  }

  /** Length of the run of (suspected or confirmed) skipped words that contains `flat`. */
  private skipRun(flat: number): number {
    const skipped = (k: number) => this.pending.get(k)?.kind === 'skipped' || this.status.get(k) === 'skipped';
    let n = 1;
    for (let k = flat - 1; k >= 0 && skipped(k); k--) n++;
    for (let k = flat + 1; k < this.corpus.size && skipped(k); k++) n++;
    return n;
  }

  private record(kind: FindingKind, flat: number, heard: string | null, atMs: number): void {
    const key = `${flat}:${kind}`;
    if (this.findingKeys.has(key)) return; // the same audio/word never yields two records
    const w = this.corpus.words[flat];
    if (!w) return;
    this.findingKeys.add(key);
    this.found.push({ key, kind, flat, ref: this.corpus.ref(flat), position: w.position, tokenText: w.text, heard, atMs });
  }
}
