import type { RecitationCorpus } from './corpus.ts';
import { similarity } from './normalize.ts';

/** One recognised word handed to the matcher (normalised; timestamps only when the model gave them). */
export interface HypWord {
  readonly norm: string;
  readonly raw: string;
  /** Absolute session time in ms, when word timestamps are available. */
  readonly startMs?: number;
  readonly endMs?: number;
  readonly confidence?: number;
}

export type AlignOp =
  | { readonly op: 'match'; readonly ref: number; readonly hyp: number; readonly sim: number }
  | { readonly op: 'near'; readonly ref: number; readonly hyp: number; readonly sim: number }
  | { readonly op: 'sub'; readonly ref: number; readonly hyp: number; readonly sim: number }
  | { readonly op: 'del'; readonly ref: number }
  | { readonly op: 'ins'; readonly hyp: number };

export interface Alignment {
  readonly ops: AlignOp[];
  readonly cost: number;
  readonly matches: number;
  /** Longest run of consecutive exact/near matches. */
  readonly run: number;
  /** First matched and one-past-last consumed reference index (null when nothing matched). */
  readonly first: number | null;
  readonly end: number | null;
}

export const MATCH_SIM = 0.84;
export const NEAR_SIM = 0.6;
/** Words the reciter commonly adds before a passage (isti'adha / basmala); cheap to ignore. */
const PREAMBLE = new Set(['اعوذ', 'بالله', 'من', 'الشيطان', 'الرجيم', 'بسم', 'الله', 'الرحمن', 'الرحيم']);

/**
 * Semi-global word alignment of recognised words against canonical words [from, to).
 * Unrecited reference words after the last match are free (the reciter has not reached them);
 * with `freeStart` leading reference words are free too (used by global search).
 */
export function align(corpus: RecitationCorpus, hyp: readonly HypWord[], from: number, to: number, freeStart = false): Alignment {
  const lo = Math.max(0, from);
  const hi = Math.min(corpus.size, to);
  const m = hi - lo;
  const n = hyp.length;
  const insCost = (i: number) => (PREAMBLE.has(hyp[i]?.norm ?? '') ? 0.35 : 1);
  const sims: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < m; j++) row.push(similarity(hyp[i]?.norm ?? '', corpus.words[lo + j]?.norm ?? ''));
    sims.push(row);
  }
  const subCost = (s: number) => (s >= MATCH_SIM ? 0 : s >= NEAR_SIM ? 0.5 : 1);
  // D[i][j]: cost aligning hyp[0..i) with ref[lo..lo+j)
  const D: Float64Array[] = [];
  const B: Uint8Array[] = []; // 1 diag, 2 up (ins), 3 left (del), 4 merge (1 hyp : 2 ref), 5 split (2 hyp : 1 ref)
  for (let i = 0; i <= n; i++) {
    D.push(new Float64Array(m + 1));
    B.push(new Uint8Array(m + 1));
  }
  for (let j = 1; j <= m; j++) {
    (D[0] as Float64Array)[j] = freeStart ? 0 : j;
    (B[0] as Uint8Array)[j] = 3;
  }
  for (let i = 1; i <= n; i++) {
    const Di = D[i] as Float64Array;
    const Dp = D[i - 1] as Float64Array;
    const Bi = B[i] as Uint8Array;
    Di[0] = (Dp[0] as number) + insCost(i - 1);
    Bi[0] = 2;
    for (let j = 1; j <= m; j++) {
      const diag = (Dp[j - 1] as number) + subCost(sims[i - 1]?.[j - 1] ?? 0);
      const up = (Dp[j] as number) + insCost(i - 1);
      const left = (Di[j - 1] as number) + 1;
      if (diag <= up && diag <= left) {
        Di[j] = diag;
        Bi[j] = 1;
      } else if (up <= left) {
        Di[j] = up;
        Bi[j] = 2;
      } else {
        Di[j] = left;
        Bi[j] = 3;
      }
      // One recognised word for two canonical words (measured: «شفاحفره» for شَفَا حُفۡرَةࣲ, «أينما»
      // for KFGQPC's أَيۡنَ مَا), and two recognised words for one canonical word.
      if (j >= 2) {
        const merged = (Dp[j - 2] as number) + (similarity(hyp[i - 1]?.norm ?? '', `${corpus.words[lo + j - 2]?.norm}${corpus.words[lo + j - 1]?.norm}`) >= MATCH_SIM ? 0.1 : Infinity);
        if (merged < (Di[j] as number)) {
          Di[j] = merged;
          Bi[j] = 4;
        }
      }
      if (i >= 2) {
        const split = ((D[i - 2] as Float64Array)[j - 1] as number) + (similarity(`${hyp[i - 2]?.norm}${hyp[i - 1]?.norm}`, corpus.words[lo + j - 1]?.norm ?? '') >= MATCH_SIM ? 0.1 : Infinity);
        if (split < (Di[j] as number)) {
          Di[j] = split;
          Bi[j] = 5;
        }
      }
    }
  }
  let bestJ = 0;
  const Dn = D[n] as Float64Array;
  for (let j = 1; j <= m; j++) if ((Dn[j] as number) <= (Dn[bestJ] as number)) bestJ = j;
  const ops: AlignOp[] = [];
  let i = n;
  let j = bestJ;
  while (i > 0 || j > 0) {
    const b = i === 0 ? 3 : j === 0 ? 2 : (B[i] as Uint8Array)[j];
    if (b === 1) {
      const sim = sims[i - 1]?.[j - 1] ?? 0;
      ops.push({ op: sim >= MATCH_SIM ? 'match' : sim >= NEAR_SIM ? 'near' : 'sub', ref: lo + j - 1, hyp: i - 1, sim });
      i--;
      j--;
    } else if (b === 4) {
      ops.push({ op: 'match', ref: lo + j - 1, hyp: i - 1, sim: 1 }, { op: 'match', ref: lo + j - 2, hyp: i - 1, sim: 1 });
      i--;
      j -= 2;
    } else if (b === 5) {
      ops.push({ op: 'match', ref: lo + j - 1, hyp: i - 2, sim: 1 });
      i -= 2;
      j--;
    } else if (b === 2) {
      ops.push({ op: 'ins', hyp: i - 1 });
      i--;
    } else {
      if (!freeStart || i > 0) ops.push({ op: 'del', ref: lo + j - 1 });
      j--;
    }
  }
  ops.reverse();
  // Leading deletions before the first consumed word are only real skips when the start is fixed.
  let matches = 0;
  let run = 0;
  let cur = 0;
  let first: number | null = null;
  let end: number | null = null;
  for (const o of ops) {
    if (o.op === 'match' || o.op === 'near') {
      matches += o.op === 'match' ? 1 : 0.5;
      cur++;
      run = Math.max(run, cur);
    } else if (o.op !== 'ins' || !PREAMBLE.has(hyp[o.hyp]?.norm ?? '')) cur = 0;
    if (o.op !== 'ins') {
      if (first === null && (o.op === 'match' || o.op === 'near')) first = o.ref;
      if (o.op !== 'del') end = o.ref + 1;
    }
  }
  return { ops, cost: Dn[bestJ] as number, matches, run, first, end };
}

export interface Candidate {
  readonly alignment: Alignment;
  /** Flat index of the next expected word after this alignment. */
  readonly cursor: number;
  readonly score: number;
}

export interface SearchResult {
  readonly best: Candidate | null;
  readonly second: Candidate | null;
  readonly confident: boolean;
}

export interface SearchOptions {
  /** Restrict the search to flat words [from, to). Default: whole Quran. */
  readonly window?: readonly [number, number];
  readonly minRun?: number;
  readonly minMargin?: number;
}

/**
 * Finds where `hyp` is being recited. Seeds candidates from exact normalised bigrams, then scores
 * each by alignment. Confident only when several consecutive words match AND the best candidate
 * clearly beats the best candidate elsewhere (repeated phrases across surahs stay ambiguous).
 */
export function search(corpus: RecitationCorpus, hyp: readonly HypWord[], opts: SearchOptions = {}): SearchResult {
  const [wFrom, wTo] = opts.window ?? [0, corpus.size];
  const minRun = opts.minRun ?? 4;
  const minMargin = opts.minMargin ?? 1.5;
  const seeds = new Map<number, number>();
  for (let i = 0; i + 1 < hyp.length; i++) {
    for (const p of corpus.bigramHits(hyp[i]?.norm ?? '', hyp[i + 1]?.norm ?? '')) {
      if (p < wFrom || p >= wTo) continue;
      const start = Math.max(0, p - i);
      const bucket = start - (start % 4);
      seeds.set(bucket, (seeds.get(bucket) ?? 0) + 1);
    }
  }
  const ranked = [...seeds.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 150);
  const cands: Candidate[] = [];
  for (const [start] of ranked) {
    const a = align(corpus, hyp, Math.max(wFrom, start - 6), Math.min(wTo, start + hyp.length * 2 + 8), true);
    if (a.end === null) continue;
    cands.push({ alignment: a, cursor: a.end, score: a.matches - a.cost * 0.5 });
  }
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0] ?? null;
  // Second best must be a different place (not the same passage reached from a neighbouring seed).
  const second = best ? cands.find((c) => Math.abs(c.cursor - best.cursor) > 12) ?? null : null;
  // Noise before the passage (leading unmatched words) does not count against it.
  let lead = 0;
  for (const o of best?.alignment.ops ?? []) {
    if (o.op === 'match' || o.op === 'near') break;
    if (o.op !== 'del') lead++;
  }
  const span = hyp.length - lead;
  const confident =
    !!best &&
    best.alignment.run >= Math.min(3, minRun) &&
    best.alignment.matches >= minRun &&
    best.alignment.matches >= span * 0.5 &&
    (!second || best.score - second.score >= minMargin);
  return { best, second, confident };
}
