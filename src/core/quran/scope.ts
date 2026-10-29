import type { DivisionIndex } from './divisions.ts';
import { formatRef, surahEndIndex, surahStartIndex, toIndex } from './refs.ts';
import { surahInfo, TOTAL_AYAT } from './surahs.ts';
import type { AyahRef, DivisionKind } from './types.ts';

/** A portion of the Quran used for plans, playlists and filters. */
export type RevisionScope =
  | { readonly type: 'all' }
  | { readonly type: 'division'; readonly kind: DivisionKind; readonly number: number }
  | { readonly type: 'surahs'; readonly surahs: readonly number[] }
  | { readonly type: 'range'; readonly start: AyahRef; readonly end: AyahRef };

/** Inclusive global-index interval. */
export interface IndexInterval {
  readonly start: number;
  readonly end: number;
}

const KIND_LABEL: Record<DivisionKind, string> = {
  juz: 'Juz',
  hizb: 'Hizb',
  quarter: 'Quarter',
  eighth: 'Eighth (Thumn)',
  page: 'Page',
};

export function kindLabel(kind: DivisionKind): string {
  return KIND_LABEL[kind];
}

/** Resolves a scope into sorted, non-overlapping intervals of global ayah indexes. */
export function scopeIntervals(scope: RevisionScope, index: DivisionIndex): IndexInterval[] {
  switch (scope.type) {
    case 'all':
      return [{ start: 1, end: TOTAL_AYAT }];
    case 'division': {
      const r = index.range(scope.kind, scope.number);
      return [{ start: r.startIndex, end: r.endIndex }];
    }
    case 'surahs': {
      const unique = [...new Set(scope.surahs)].sort((a, b) => a - b);
      return mergeIntervals(unique.map((s) => ({ start: surahStartIndex(s), end: surahEndIndex(s) })));
    }
    case 'range': {
      const a = toIndex(scope.start);
      const b = toIndex(scope.end);
      return [{ start: Math.min(a, b), end: Math.max(a, b) }];
    }
  }
}

export function mergeIntervals(list: IndexInterval[]): IndexInterval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out: IndexInterval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end + 1) out[out.length - 1] = { start: last.start, end: Math.max(last.end, iv.end) };
    else out.push(iv);
  }
  return out;
}

export function scopeContains(intervals: readonly IndexInterval[], globalIndex: number): boolean {
  return intervals.some((iv) => globalIndex >= iv.start && globalIndex <= iv.end);
}

export function scopeAyahCount(intervals: readonly IndexInterval[]): number {
  return intervals.reduce((n, iv) => n + iv.end - iv.start + 1, 0);
}

export function describeScope(scope: RevisionScope, index?: DivisionIndex): string {
  switch (scope.type) {
    case 'all':
      return 'Entire Quran';
    case 'division': {
      const base = `${kindLabel(scope.kind)} ${scope.number}`;
      if (!index || !index.has(scope.kind)) return base;
      if (scope.kind === 'quarter' || scope.kind === 'eighth') {
        const per = scope.kind === 'quarter' ? 4 : 8;
        const hizb = Math.floor((scope.number - 1) / per) + 1;
        const within = ((scope.number - 1) % per) + 1;
        return `${base} (Hizb ${hizb}, ${within}/${per})`;
      }
      return base;
    }
    case 'surahs':
      return scope.surahs.length === 1
        ? `Surah ${surahInfo(scope.surahs[0] as number).nameTransliterated}`
        : `${scope.surahs.length} surahs`;
    case 'range':
      return `${formatRef(scope.start)} – ${formatRef(scope.end)}`;
  }
}

export function scopeKey(scope: RevisionScope): string {
  switch (scope.type) {
    case 'all':
      return 'all';
    case 'division':
      return `${scope.kind}:${scope.number}`;
    case 'surahs':
      return `surahs:${[...scope.surahs].sort((a, b) => a - b).join(',')}`;
    case 'range':
      return `range:${scope.start.surah}:${scope.start.ayah}-${scope.end.surah}:${scope.end.ayah}`;
  }
}
