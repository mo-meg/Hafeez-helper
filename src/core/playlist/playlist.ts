import { isUnresolved, type Mistake, type MistakeCategory, type MistakeStatus, type WordMark } from '../model.ts';
import { fromIndex, surahEndIndex, surahStartIndex } from '../quran/refs.ts';
import { scopeContains, type IndexInterval } from '../quran/scope.ts';
import { TOTAL_AYAT } from '../quran/surahs.ts';
import type { AyahRef } from '../quran/types.ts';

export type WordPracticeMode = 'grouped' | 'per_word';

export interface PlaylistOptions {
  /** Restrict to these categories (empty/undefined = all). */
  readonly categories?: readonly MistakeCategory[];
  /** Statuses to include. Default: all unresolved statuses. */
  readonly statuses?: readonly MistakeStatus[];
  /** Ayat played before / after each marked ayah for context (0 = none). */
  readonly contextBefore?: number;
  readonly contextAfter?: number;
  /** Allow context ayat from a neighbouring surah. Default false. */
  readonly contextAcrossSurahs?: boolean;
  /**
   * 'grouped' (default): an ayah with several marked words is played as ONE item.
   * 'per_word': one item per marked word (same full-ayah audio, the focus word is highlighted).
   */
  readonly wordPractice?: WordPracticeMode;
  /** Restrict to specific mistake ids (e.g. "only today's due mistakes"). */
  readonly mistakeIds?: readonly string[];
}

export type ItemRole = 'mistake' | 'context' | 'portion';

export interface PlaylistItem {
  readonly globalIndex: number;
  readonly ref: AyahRef;
  readonly role: ItemRole;
  /** Mistakes attached to this ayah (empty for context/portion ayat without mistakes). */
  readonly mistakeIds: readonly string[];
  readonly categories: readonly MistakeCategory[];
  readonly words: readonly WordMark[];
  /** In 'per_word' mode, the word this item focuses on. */
  readonly focusWord: WordMark | null;
}

export interface PlaylistGroup {
  readonly id: string;
  readonly items: readonly PlaylistItem[];
}

export interface Playlist {
  readonly kind: 'mistakes' | 'portion';
  readonly groups: readonly PlaylistGroup[];
  /** Distinct marked ayat (Quran order). */
  readonly mistakeAyahIndexes: readonly number[];
  readonly contextAyahCount: number;
  readonly mistakeCount: number;
  /** Matching mistakes that were excluded because they are outside the scope. */
  readonly excludedOutOfScope: number;
}

const DEFAULT_STATUSES: readonly MistakeStatus[] = ['new', 'needs_practice', 'under_review', 'improved', 'reopened'];

function selectMistakes(mistakes: readonly Mistake[], scope: readonly IndexInterval[], o: PlaylistOptions) {
  const statuses = o.statuses?.length ? o.statuses : DEFAULT_STATUSES;
  const matching = mistakes.filter(
    (m) =>
      statuses.includes(m.status) &&
      (!o.categories?.length || o.categories.includes(m.category)) &&
      (!o.mistakeIds || o.mistakeIds.includes(m.id)),
  );
  const inScope = matching.filter((m) => scopeContains(scope, m.globalIndex));
  return { inScope, excluded: matching.length - inScope.length };
}

/**
 * Builds the personalized mistake playlist:
 * filter (status/category/scope) → group by ayah (dedupe) → canonical Quran order →
 * add optional context ayat → merge overlapping/adjacent windows into groups.
 */
export function buildMistakePlaylist(mistakes: readonly Mistake[], scope: readonly IndexInterval[], options: PlaylistOptions = {}): Playlist {
  const { inScope, excluded } = selectMistakes(mistakes, scope, options);
  const byAyah = new Map<number, Mistake[]>();
  for (const m of inScope) byAyah.set(m.globalIndex, [...(byAyah.get(m.globalIndex) ?? []), m]);
  const ayahIndexes = [...byAyah.keys()].sort((a, b) => a - b);

  const before = Math.max(0, Math.floor(options.contextBefore ?? 0));
  const after = Math.max(0, Math.floor(options.contextAfter ?? 0));
  const across = options.contextAcrossSurahs ?? false;

  // Window per marked ayah, clipped to the Quran (and to its surah unless allowed).
  const windows = ayahIndexes.map((idx) => {
    const ref = fromIndex(idx);
    const lo = across ? 1 : surahStartIndex(ref.surah);
    const hi = across ? TOTAL_AYAT : surahEndIndex(ref.surah);
    return { start: Math.max(lo, idx - before), end: Math.min(hi, idx + after) };
  });
  const merged: Array<{ start: number; end: number }> = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end + 1) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }

  const mode = options.wordPractice ?? 'grouped';
  let contextCount = 0;
  const groups: PlaylistGroup[] = merged.map((w, gi) => {
    const items: PlaylistItem[] = [];
    for (let idx = w.start; idx <= w.end; idx++) {
      const ms = (byAyah.get(idx) ?? []).slice().sort((a, b) => (a.word?.position ?? 0) - (b.word?.position ?? 0));
      const ref = fromIndex(idx);
      if (ms.length === 0) {
        contextCount++;
        items.push({ globalIndex: idx, ref, role: 'context', mistakeIds: [], categories: [], words: [], focusWord: null });
        continue;
      }
      const words = ms.flatMap((m) => (m.word ? [m.word] : []));
      const categories = [...new Set(ms.map((m) => m.category))];
      const base = { globalIndex: idx, ref, role: 'mistake' as const, mistakeIds: ms.map((m) => m.id), categories, words };
      if (mode === 'per_word' && words.length > 1) {
        for (const wd of words) items.push({ ...base, focusWord: wd });
        // An additional ayah-level mark still gets one item of its own.
        if (ms.some((m) => !m.word)) items.push({ ...base, focusWord: null });
      } else {
        items.push({ ...base, focusWord: null });
      }
    }
    return { id: `g${gi + 1}`, items };
  });

  return {
    kind: 'mistakes',
    groups,
    mistakeAyahIndexes: ayahIndexes,
    contextAyahCount: contextCount,
    mistakeCount: inScope.length,
    excludedOutOfScope: excluded,
  };
}

/** Full-portion playlist: every ayah of the scope in order; ayat with unresolved mistakes are flagged. */
export function buildPortionPlaylist(mistakes: readonly Mistake[], scope: readonly IndexInterval[]): Playlist {
  const byAyah = new Map<number, Mistake[]>();
  for (const m of mistakes) {
    if (isUnresolved(m.status) && scopeContains(scope, m.globalIndex)) byAyah.set(m.globalIndex, [...(byAyah.get(m.globalIndex) ?? []), m]);
  }
  const groups: PlaylistGroup[] = scope.map((iv, gi) => {
    const items: PlaylistItem[] = [];
    for (let idx = iv.start; idx <= iv.end; idx++) {
      const ms = byAyah.get(idx) ?? [];
      items.push({
        globalIndex: idx,
        ref: fromIndex(idx),
        role: 'portion',
        mistakeIds: ms.map((m) => m.id),
        categories: [...new Set(ms.map((m) => m.category))],
        words: ms.flatMap((m) => (m.word ? [m.word] : [])),
        focusWord: null,
      });
    }
    return { id: `p${gi + 1}`, items };
  });
  return {
    kind: 'portion',
    groups,
    mistakeAyahIndexes: [...byAyah.keys()].sort((a, b) => a - b),
    contextAyahCount: 0,
    mistakeCount: [...byAyah.values()].reduce((n, l) => n + l.length, 0),
    excludedOutOfScope: 0,
  };
}

export function playlistAyahCount(p: Playlist): number {
  return p.groups.reduce((n, g) => n + g.items.length, 0);
}
