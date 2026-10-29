/**
 * Localized names for domain values (surahs, references, divisions, statuses…).
 * Core modules keep their English labels for tests, logs and backups; the UI uses these.
 * Surah names come from the core surah table; Quran text itself is never touched here.
 */
import { AudioUnavailableError } from '../../core/audio/playbackController.ts';
import { TemplateError, type ReciterSource } from '../../core/audio/reciters.ts';
import { DataFormatError } from '../../core/data/alquranCloud.ts';
import type { MistakeCategory, MistakeStatus, RecallOutcome, SessionMode } from '../../core/model.ts';
import { DivisionUnavailableError, type DivisionIndex } from '../../core/quran/divisions.ts';
import type { RevisionScope } from '../../core/quran/scope.ts';
import { surahInfo } from '../../core/quran/surahs.ts';
import type { AyahRef, DivisionKind } from '../../core/quran/types.ts';
import { BackupError } from '../../core/storage/backup.ts';
import { getLocale, t, tn } from './index.ts';

export function surahName(n: number): string {
  const info = surahInfo(n);
  return getLocale() === 'ar' ? info.nameArabic : info.nameTransliterated;
}

/** "Al-Baqarah 2:255" / "البقرة 2:255". */
export function refLabel(ref: AyahRef): string {
  return `${surahName(ref.surah)} ${ref.surah}:${ref.ayah}`;
}

/** Surah option text for selects: "2. Al-Baqarah" / "2. البقرة". */
export function surahOption(n: number): string {
  return `${n}. ${surahName(n)}`;
}

export function kindName(kind: DivisionKind): string {
  return t(`kind.${kind}`);
}

export function divisionLabel(kind: DivisionKind, n: number): string {
  return t('division.label', { kind: kindName(kind), n });
}

export function scopeLabel(scope: RevisionScope, index?: DivisionIndex): string {
  switch (scope.type) {
    case 'all':
      return t('scope.all');
    case 'division': {
      const base = divisionLabel(scope.kind, scope.number);
      if (!index || !index.has(scope.kind)) return base;
      if (scope.kind === 'quarter' || scope.kind === 'eighth') {
        const per = scope.kind === 'quarter' ? 4 : 8;
        return t('division.withinHizb', { base, hizb: Math.floor((scope.number - 1) / per) + 1, within: ((scope.number - 1) % per) + 1, per });
      }
      return base;
    }
    case 'surahs':
      return scope.surahs.length === 1 ? t('scope.surah', { name: surahName(scope.surahs[0] as number) }) : tn('scope.surahs', scope.surahs.length);
    case 'range':
      return t('scope.range', { from: refLabel(scope.start), to: refLabel(scope.end) });
  }
}

export const categoryLabel = (c: MistakeCategory): string => t(`cat.${c}`);
export const statusLabel = (s: MistakeStatus): string => t(`status.${s}`);
export const outcomeLabel = (o: RecallOutcome): string => t(`outcome.${o}`);
export const modeLabel = (m: SessionMode): string => t(`mode.${m}`);

export function reciterName(r: ReciterSource): string {
  return getLocale() === 'ar' && r.nameArabic ? r.nameArabic : r.name;
}

export function reciterAttribution(r: ReciterSource): string {
  if (r.host === 'everyayah') return t('set.attrEveryayah');
  if (r.host === 'islamic-network') return t('set.attrIslamicNetwork');
  return t('set.attrCustom');
}

/** Localized, user-facing text for an error. Technical details stay as supplied. */
export function errorText(e: unknown): string {
  if (e instanceof DivisionUnavailableError) return e.kind === 'eighth' ? t('error.eighthsUnavailable') : t('error.divisionUnavailable', { kind: kindName(e.kind) });
  if (e instanceof AudioUnavailableError) return t('error.offlineAudio');
  if (e instanceof TemplateError) return t('error.template', { detail: e.message });
  if (e instanceof BackupError) return t('error.backup', { detail: e.message });
  if (e instanceof DataFormatError) return t('error.dataFormat', { detail: e.message });
  if (e instanceof LocalizedError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  return getLocale() === 'en' ? msg : t('error.generic', { detail: msg });
}

/** An error whose message is already localized (thrown by UI code). */
export class LocalizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalizedError';
  }
}
