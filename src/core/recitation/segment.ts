import type { HypWord } from './align.ts';
import type { RecitationCorpus } from './corpus.ts';

/** One sound unit the model heard (word bar and blank excluded). */
export interface HeardUnit {
  readonly id: number;
  readonly name: string;
  /** Session time in ms. */
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: number | null;
}

export interface SegmentConfig {
  /** Units needed before a passage is searched in the whole Quran. */
  readonly minSearchUnits: number;
  /** Highest alignment cost per heard unit that still counts as "found here". */
  readonly maxCostPerUnit: number;
  /** Best place must beat the best other place by this many cost units. */
  readonly minMargin: number;
  /** Units kept while searching (older ones are dropped). */
  readonly maxBuffer: number;
  /** Units needed before the ayah openings are searched (the fast first lock-on). */
  readonly minStartUnits: number;
  /** Words of each ayah opening that are indexed for the fast lock-on. */
  readonly startWords: number;
}

export const DEFAULT_SEGMENT: SegmentConfig = { minSearchUnits: 18, maxCostPerUnit: 0.35, minMargin: 3, maxBuffer: 240, minStartUnits: 8, startWords: 4 };

const NGRAM = 6;
/** Shorter n-grams for the ayah-opening index: few units are heard when the first lock-on is tried. */
const START_NGRAM = 4;
/** Ayah openings are tried only while the heard units are this short (longer: the whole-Quran search). */
const MAX_START_UNITS = 90;
/** Units kept while the place is locked but the latest units do not fit the allowed ayat. */
const LOCKED_KEEP_UNITS = 36;
const ch = (id: number) => String.fromCharCode(0xe000 + id);

interface Placed {
  /** For each heard unit, the stream index it matched / substituted, or -1 (inserted). */
  readonly map: Int32Array;
  readonly cost: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Cuts the model's continuous unit stream into the canonical words.
 *
 * Measured with the real model (2026-11-24): in continuous recitation it often emits no word bar at
 * all, so its own word grouping cannot be used. Instead the heard units are aligned (unit-level
 * edit distance) with the expected units of the text — near the tracker's cursor, or, while
 * searching, against the whole Quran via unit n-grams — and each heard unit takes the word of the
 * expected unit it lines up with. The words handed to the tracker therefore have the canonical
 * boundaries; differences inside them stay visible to the tracker as near/sub matches.
 */
export class UnitSegmenter {
  private readonly corpus: RecitationCorpus;
  private readonly cfg: SegmentConfig;
  /** All expected units of the text, word after word (word bar removed). */
  private readonly stream: string;
  private readonly wordAt: Int32Array;
  private readonly wordStart: Int32Array;
  private index: Map<string, number[]> | null = null;
  private startIdx: Map<string, { p: number; s: number }[]> | null = null;

  constructor(corpus: RecitationCorpus, cfg: Partial<SegmentConfig> = {}) {
    this.corpus = corpus;
    this.cfg = { ...DEFAULT_SEGMENT, ...cfg };
    const parts: string[] = [];
    this.wordStart = new Int32Array(corpus.size + 1);
    let n = 0;
    corpus.words.forEach((w, k) => {
      this.wordStart[k] = n;
      parts.push(w.norm);
      n += w.norm.length;
    });
    this.wordStart[corpus.size] = n;
    this.stream = parts.join('');
    this.wordAt = new Int32Array(n);
    for (let k = 0; k < corpus.size; k++) this.wordAt.fill(k, this.wordStart[k] as number, this.wordStart[k + 1] as number);
  }

  /**
   * Segments `units` (oldest first). Returns the words that are final now and how many units they
   * used; the rest stays with the caller for the next call. `cursor` is the tracker's next expected
   * word when it is following the recitation, else null. With `final` everything placeable is used.
   * `limit` (flat words [from, to)) is where the recitation may be once its place is known: the
   * search then stays inside it and never looks at the rest of the Quran.
   */
  segment(units: readonly HeardUnit[], cursor: number | null, final: boolean, limit: readonly [number, number] | null = null): { words: HypWord[]; consumed: number; anchor?: number } {
    if (!units.length) return { words: [], consumed: 0 };
    const heard = units.map((u) => ch(u.id)).join('');
    let placed: Placed | null = null;
    let searched = false;
    if (cursor !== null) {
      const c = Math.min(Math.max(0, cursor), this.corpus.size);
      const from = this.wordStart[Math.max(0, c - 12)] as number;
      let to = Math.min(this.stream.length, (this.wordStart[c] as number) + heard.length * 2 + 60);
      if (limit) to = Math.min(to, Math.max(from, this.wordStart[Math.min(limit[1], this.corpus.size)] as number));
      const p = this.align(heard, from, to);
      if (p.cost <= Math.max(2, heard.length * this.cfg.maxCostPerUnit)) placed = p;
    }
    if (!placed && limit) {
      searched = true;
      if (heard.length < this.cfg.minStartUnits && !final) return { words: [], consumed: 0 };
      const from = this.wordStart[Math.max(0, Math.min(limit[0], this.corpus.size))] as number;
      const to = this.wordStart[Math.max(0, Math.min(limit[1], this.corpus.size))] as number;
      const p = to > from ? this.align(heard, from, to) : null;
      if (p && p.cost <= Math.max(2, heard.length * this.cfg.maxCostPerUnit)) placed = p;
      else {
        // Not (yet) recognisably the next ayat: keep only the latest units, so the reciter's return
        // to the text is found quickly, and never search anywhere else.
        const drop = final ? units.length : Math.max(0, units.length - LOCKED_KEEP_UNITS);
        return { words: [], consumed: drop };
      }
    }
    if (!placed) {
      searched = true;
      // Fast first lock-on: reciting usually starts at the beginning of an ayah.
      if (heard.length >= this.cfg.minStartUnits && heard.length <= MAX_START_UNITS) placed = this.searchStart(heard);
      if (!placed && heard.length < this.cfg.minSearchUnits && !final) return { words: [], consumed: 0 };
      placed ??= this.search(heard);
      if (!placed) {
        // Nothing found: keep the most recent units for the next try, drop the oldest.
        const drop = final ? units.length : Math.max(0, units.length - this.cfg.maxBuffer);
        return { words: [], consumed: drop };
      }
    }
    const r = this.cut(units, placed, final);
    if (searched && r.firstWord !== null) return { words: r.words, consumed: r.consumed, anchor: r.firstWord };
    return { words: r.words, consumed: r.consumed };
  }

  /**
   * Searches only the openings (first few words) of every ayah: far fewer places than the whole
   * Quran, so a short stretch of units is enough. Units before the opening (isti'adha, basmala)
   * are left out. Confident only with a clear margin over every other opening.
   */
  private searchStart(heard: string): Placed | null {
    const idx = this.startIndex();
    const votes = new Map<number, { n: number; h0: number }>();
    for (let i = 0; i + START_NGRAM <= heard.length; i++) {
      for (const hit of idx.get(heard.slice(i, i + START_NGRAM)) ?? []) {
        const h0 = i - (hit.p - hit.s);
        if (h0 < 0) continue; // the heard units would begin inside the ayah
        const v = votes.get(hit.s);
        if (v) v.n++;
        else votes.set(hit.s, { n: 1, h0 });
      }
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1].n - a[1].n || a[0] - b[0]).slice(0, 16);
    const cands: { p: Placed; per: number }[] = [];
    for (const [s, v] of ranked) {
      const tail = heard.slice(v.h0);
      if (tail.length < this.cfg.minStartUnits) continue;
      const p = this.align(tail, s, Math.min(this.stream.length, s + Math.ceil(tail.length * 1.5) + 12));
      if (p.start > s + 2) continue; // must begin at the opening
      const map = new Int32Array(heard.length).fill(-1);
      map.set(p.map, v.h0);
      cands.push({ p: { map, cost: p.cost, start: p.start, end: p.end }, per: p.cost / tail.length });
    }
    cands.sort((a, b) => a.p.cost - b.p.cost);
    const best = cands[0];
    if (!best || best.per > this.cfg.maxCostPerUnit) return null;
    const other = cands.find((c) => Math.abs(c.p.start - best.p.start) > 4);
    if (other && other.p.cost - best.p.cost < 2) return null; // several ayat open alike: wait for more
    return best.p;
  }

  private startIndex(): Map<string, { p: number; s: number }[]> {
    if (this.startIdx) return this.startIdx;
    const m = new Map<string, { p: number; s: number }[]>();
    const words = this.corpus.words;
    for (let k = 1; k < words.length; k++) {
      // Al-Fatihah 1:1 (the basmala) is left out: a basmala said before any surah would lock onto it.
      // Its 1:2 opening still finds Al-Fatihah, with the basmala as lead-in.
      if (words[k]?.position !== 1 || k === 0) continue;
      const s = this.wordStart[k] as number;
      let endWord = k + 1;
      while (endWord < words.length && endWord < k + this.cfg.startWords && words[endWord]?.position !== 1) endWord++;
      const e = this.wordStart[endWord] as number;
      for (let p = s; p + START_NGRAM <= e; p++) {
        const key = this.stream.slice(p, p + START_NGRAM);
        const l = m.get(key);
        if (l) l.push({ p, s });
        else m.set(key, [{ p, s }]);
      }
    }
    this.startIdx = m;
    return m;
  }

  /** Whole-Quran search with a unit n-gram index; confident only with a clear margin. */
  private search(heard: string): Placed | null {
    const idx = this.ngrams();
    const votes = new Map<number, number>();
    for (let i = 0; i + NGRAM <= heard.length; i++) {
      for (const p of idx.get(heard.slice(i, i + NGRAM)) ?? []) {
        const b = Math.max(0, p - i) >> 4;
        votes.set(b, (votes.get(b) ?? 0) + 1);
      }
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    const cands: Placed[] = [];
    for (const [b] of ranked) {
      const s = b << 4;
      cands.push(this.align(heard, Math.max(0, s - 24), Math.min(this.stream.length, s + Math.ceil(heard.length * 1.6) + 40)));
    }
    cands.sort((a, b) => a.cost - b.cost);
    const best = cands[0];
    if (!best || best.cost > heard.length * this.cfg.maxCostPerUnit) return null;
    const other = cands.find((c) => Math.abs(c.start - best.start) > heard.length + 16);
    if (other && other.cost - best.cost < this.cfg.minMargin) return null; // e.g. a refrain: wait for more
    return best;
  }

  private ngrams(): Map<string, number[]> {
    if (this.index) return this.index;
    const m = new Map<string, number[]>();
    for (let i = 0; i + NGRAM <= this.stream.length; i++) {
      const k = this.stream.slice(i, i + NGRAM);
      const l = m.get(k);
      if (l) l.push(i);
      else m.set(k, [i]);
    }
    this.index = m;
    return m;
  }

  /** Semi-global unit alignment of `heard` inside stream[from, to): free start and end in the text. */
  private align(heard: string, from: number, to: number): Placed {
    const n = heard.length;
    const m = Math.max(0, to - from);
    const W = m + 1;
    const D = new Float64Array((n + 1) * W);
    const B = new Uint8Array((n + 1) * W); // 1 diag, 2 ins (heard extra), 3 del (text skipped)
    // An extra heard unit (noise, a breath, a preamble) costs a little less than a wrong one, so
    // sounds that fit nowhere are dropped instead of being forced onto a neighbouring word.
    const INS = 0.9;
    for (let i = 1; i <= n; i++) {
      D[i * W] = i * INS;
      B[i * W] = 2;
    }
    for (let i = 1; i <= n; i++) {
      const hc = heard.charCodeAt(i - 1);
      for (let j = 1; j <= m; j++) {
        const diag = (D[(i - 1) * W + j - 1] as number) + (hc === this.stream.charCodeAt(from + j - 1) ? 0 : 1);
        const ins = (D[(i - 1) * W + j] as number) + INS;
        const del = (D[i * W + j - 1] as number) + 1;
        let v = diag;
        let b = 1;
        if (ins < v) {
          v = ins;
          b = 2;
        }
        if (del < v) {
          v = del;
          b = 3;
        }
        D[i * W + j] = v;
        B[i * W + j] = b;
      }
    }
    let bestJ = 0;
    for (let j = 1; j <= m; j++) if ((D[n * W + j] as number) < (D[n * W + bestJ] as number)) bestJ = j;
    const map = new Int32Array(n).fill(-1);
    let i = n;
    let j = bestJ;
    let start = from + bestJ;
    while (i > 0) {
      const b = j === 0 ? 2 : B[i * W + j];
      if (b === 1) {
        map[i - 1] = from + j - 1;
        start = from + j - 1;
        i--;
        j--;
      } else if (b === 2) i--;
      else j--;
    }
    return { map, cost: D[n * W + bestJ] as number, start, end: from + bestJ };
  }

  /** Groups heard units by the word of the text unit they line up with. */
  private cut(units: readonly HeardUnit[], p: Placed, final: boolean): { words: HypWord[]; consumed: number; firstWord: number | null } {
    const groups: { word: number; from: number; to: number }[] = [];
    let lead = 0; // inserted units before the first placed one (e.g. a preamble) are dropped
    for (let i = 0; i < units.length; i++) {
      const r = p.map[i] as number;
      if (r < 0) {
        const g = groups[groups.length - 1];
        if (g) g.to = i + 1;
        else lead = i + 1;
        continue;
      }
      const w = this.wordAt[r] as number;
      const g = groups[groups.length - 1];
      if (g && g.word === w) g.to = i + 1;
      else groups.push({ word: w, from: i, to: i + 1 });
    }
    // The last word may still be going on: keep it for the next call unless the take ended or its
    // units already reach the word's last expected unit (then it is shown at once, not only when
    // the next word begins — the reciter may be stuck right after it).
    const last = groups[groups.length - 1];
    let complete = false;
    if (!final && last) {
      const lastUnit = (this.wordStart[last.word + 1] as number) - 1;
      for (let i = last.to - 1; i >= last.from && !complete; i--) complete = p.map[i] === lastUnit;
    }
    const done = final || complete ? groups : groups.slice(0, -1);
    const words = done.map((g) => {
      const us = units.slice(g.from, g.to);
      const confs = us.map((u) => u.confidence).filter((c): c is number => c !== null);
      return {
        norm: us.map((u) => ch(u.id)).join(''),
        raw: us.map((u) => u.name).join(' '),
        startMs: (us[0] as HeardUnit).startMs,
        endMs: (us[us.length - 1] as HeardUnit).endMs,
        ...(confs.length ? { confidence: Math.min(...confs) } : {}),
      };
    });
    const consumed = final ? units.length : done.length ? (done[done.length - 1] as { to: number }).to : lead;
    return { words, consumed, firstWord: done[0]?.word ?? null };
  }
}
