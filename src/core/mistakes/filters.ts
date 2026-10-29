import type { Mistake, MistakeCategory, MistakeStatus } from '../model.ts';
import type { DivisionIndex } from '../quran/divisions.ts';
import { scopeContains, type IndexInterval } from '../quran/scope.ts';

export interface MistakeFilter {
  readonly categories?: readonly MistakeCategory[];
  readonly statuses?: readonly MistakeStatus[];
  readonly surahs?: readonly number[];
  readonly hizbs?: readonly number[];
  readonly scope?: readonly IndexInterval[];
  /** Inclusive local dates (YYYY-MM-DD) on createdAt. */
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly minConfidence?: number;
  readonly maxConfidence?: number;
  readonly onlyDemo?: boolean;
  readonly excludeDemo?: boolean;
}

const localDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function filterMistakes(mistakes: readonly Mistake[], f: MistakeFilter, index: DivisionIndex | null): Mistake[] {
  return mistakes.filter((m) => {
    if (f.categories?.length && !f.categories.includes(m.category)) return false;
    if (f.statuses?.length && !f.statuses.includes(m.status)) return false;
    if (f.surahs?.length && !f.surahs.includes(m.surah)) return false;
    if (f.hizbs?.length) {
      const hizb = index?.numberAt('hizb', m.globalIndex) ?? null;
      if (hizb === null || !f.hizbs.includes(hizb)) return false;
    }
    if (f.scope && !scopeContains(f.scope, m.globalIndex)) return false;
    if (f.createdFrom && localDate(m.createdAt) < f.createdFrom) return false;
    if (f.createdTo && localDate(m.createdAt) > f.createdTo) return false;
    if (f.minConfidence !== undefined && (m.confidence ?? 0) < f.minConfidence) return false;
    if (f.maxConfidence !== undefined && m.confidence !== null && m.confidence > f.maxConfidence) return false;
    if (f.onlyDemo && !m.demo) return false;
    if (f.excludeDemo && m.demo) return false;
    return true;
  });
}
