import { VERIFIED_JUZ_STARTS } from './anchors.ts';
import { fromIndex, toIndex } from './refs.ts';
import { TOTAL_AYAT } from './surahs.ts';
import type { AyahLocation, AyahRef, DivisionKind, DivisionRange } from './types.ts';

export type StartList = ReadonlyArray<readonly [number, number]>;

/** Serialized division dataset. Produced by data providers; validated before use. */
export interface DivisionDataset {
  readonly schema: 'hafeez-divisions/1';
  readonly id: string;
  readonly label: string;
  readonly numbering: 'hafs-kufan';
  readonly source: { readonly name: string; readonly url: string; readonly license: string; readonly retrievedAt?: string };
  readonly juzStarts: StartList;
  readonly quarterStarts?: StartList;
  readonly eighthStarts?: StartList;
  /** Provenance of eighthStarts when imported separately from the rest of the dataset. */
  readonly eighthsSource?: { readonly name: string; readonly url: string; readonly license: string };
  readonly pageStarts?: StartList;
  /** True only for synthetic test fixtures (never shown as real boundaries). */
  readonly synthetic?: boolean;
}

export const EXPECTED_COUNTS: Readonly<Record<DivisionKind, number>> = {
  juz: 30,
  hizb: 60,
  quarter: 240,
  eighth: 480,
  page: 604,
};

export class DivisionUnavailableError extends Error {
  readonly kind: DivisionKind;
  constructor(kind: DivisionKind) {
    super(
      kind === 'eighth'
        ? 'Eighth (thumn) boundaries are not part of the loaded division dataset. Import a verified eighths dataset in Settings.'
        : `${kind} boundaries are not available yet. Download the Quran data in Settings → Quran data.`,
    );
    this.name = 'DivisionUnavailableError';
    this.kind = kind;
  }
}

/** Dataset containing only the bundled, verified juz anchors (used before any download). */
export const ANCHOR_ONLY_DATASET: DivisionDataset = {
  schema: 'hafeez-divisions/1',
  id: 'verified-anchors',
  label: 'Verified juz anchors only',
  numbering: 'hafs-kufan',
  source: { name: 'Bundled verified anchors', url: 'docs/DATA_SOURCES.md', license: 'facts' },
  juzStarts: VERIFIED_JUZ_STARTS,
};

/**
 * Immutable lookup structure over a validated dataset. Every boundary comes from the dataset's
 * start lists; ranges end one ayah before the next division starts (or at An-Nas 6).
 */
export class DivisionIndex {
  readonly dataset: DivisionDataset;
  private readonly starts: Partial<Record<DivisionKind, number[]>>;

  constructor(dataset: DivisionDataset) {
    this.dataset = dataset;
    const toIdx = (list: StartList | undefined) => list?.map(([s, a]) => toIndex({ surah: s, ayah: a }));
    const quarters = toIdx(dataset.quarterStarts);
    this.starts = {
      juz: toIdx(dataset.juzStarts),
      quarter: quarters,
      // A hizb is by definition four quarters; its start is the start of quarter 4k+1.
      hizb: quarters?.filter((_, i) => i % 4 === 0),
      eighth: toIdx(dataset.eighthStarts),
      page: toIdx(dataset.pageStarts),
    };
  }

  has(kind: DivisionKind): boolean {
    return (this.starts[kind]?.length ?? 0) > 0;
  }

  count(kind: DivisionKind): number {
    return this.starts[kind]?.length ?? 0;
  }

  private list(kind: DivisionKind): number[] {
    const l = this.starts[kind];
    if (!l || l.length === 0) throw new DivisionUnavailableError(kind);
    return l;
  }

  range(kind: DivisionKind, number: number): DivisionRange {
    const l = this.list(kind);
    const start = l[number - 1];
    if (start === undefined || !Number.isInteger(number)) {
      throw new RangeError(`${kind} ${number} does not exist (1..${l.length})`);
    }
    const next = l[number];
    const endIndex = next === undefined ? TOTAL_AYAT : Math.max(start, next - 1);
    return { kind, number, startIndex: start, endIndex, start: fromIndex(start), end: fromIndex(endIndex) };
  }

  all(kind: DivisionKind): DivisionRange[] {
    return this.list(kind).map((_, i) => this.range(kind, i + 1));
  }

  /** Division number containing a global index, or null if the kind is unavailable. */
  numberAt(kind: DivisionKind, index: number): number | null {
    const l = this.starts[kind];
    if (!l || l.length === 0) return null;
    let lo = 0;
    let hi = l.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((l[mid] as number) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  locate(ref: AyahRef): AyahLocation {
    const index = toIndex(ref);
    const quarter = this.numberAt('quarter', index);
    const eighth = this.numberAt('eighth', index);
    return {
      ref,
      index,
      juz: this.numberAt('juz', index),
      hizb: this.numberAt('hizb', index),
      quarter,
      quarterInHizb: quarter === null ? null : ((quarter - 1) % 4) + 1,
      eighth,
      eighthInHizb: eighth === null ? null : ((eighth - 1) % 8) + 1,
      page: this.numberAt('page', index),
    };
  }

  /** Child divisions fully contained in a parent division (e.g. quarters of a hizb). */
  children(parent: DivisionRange, childKind: DivisionKind): DivisionRange[] {
    if (!this.has(childKind)) return [];
    return this.all(childKind).filter((c) => c.startIndex >= parent.startIndex && c.startIndex <= parent.endIndex);
  }
}
