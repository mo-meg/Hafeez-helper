import type { RevisionScope } from './quran/scope.ts';
import type { AyahRef } from './quran/types.ts';

export const MISTAKE_CATEGORIES = [
  'forgotten',
  'hesitation',
  'incorrect_word',
  'similar_ayah',
  'ayah_transition',
  'ayah_ending',
  'tajweed',
  'other',
] as const;
export type MistakeCategory = (typeof MISTAKE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<MistakeCategory, string> = {
  forgotten: 'Forgotten word',
  hesitation: 'Hesitation / delayed recall',
  incorrect_word: 'Incorrect word',
  similar_ayah: 'Confused with similar ayah',
  ayah_transition: 'Linking ayat (transition)',
  ayah_ending: 'Incorrect ayah ending',
  tajweed: 'Pronunciation / Tajweed',
  other: 'Other',
};

export const MISTAKE_STATUSES = ['new', 'needs_practice', 'under_review', 'improved', 'resolved', 'reopened'] as const;
export type MistakeStatus = (typeof MISTAKE_STATUSES)[number];

export const STATUS_LABELS: Record<MistakeStatus, string> = {
  new: 'New',
  needs_practice: 'Needs practice',
  under_review: 'Under review',
  improved: 'Improved',
  resolved: 'Resolved',
  reopened: 'Reopened',
};

/**
 * A mistake on the first word of an ayah usually means the reciter could not link the previous
 * ayah to this one, so that type is suggested automatically (the user can still change it).
 */
export function suggestedCategory(wordPosition: number | null): MistakeCategory | null {
  return wordPosition === 1 ? 'ayah_transition' : null;
}

/** True when recalling this mistake depends on the link from the previous ayah. */
export function isTransitionMistake(m: { category: MistakeCategory; word: { position: number } | null }): boolean {
  return m.category === 'ayah_transition' || m.word === null || m.word.position === 1;
}

/** Unresolved = still part of mistake revision playlists by default. */
export function isUnresolved(status: MistakeStatus): boolean {
  return status !== 'resolved';
}

export const RECALL_OUTCOMES = ['correct_easy', 'correct_difficult', 'needed_prompt', 'mistake_again'] as const;
export type RecallOutcome = (typeof RECALL_OUTCOMES)[number];

export const OUTCOME_LABELS: Record<RecallOutcome, string> = {
  correct_easy: 'Correct without difficulty',
  correct_difficult: 'Correct but difficult',
  needed_prompt: 'Needed a prompt',
  mistake_again: 'Made a mistake again',
};

export type Severity = 1 | 2 | 3;
export type DifficultyOverride = 'easier' | 'normal' | 'harder';

export interface WordMark {
  /** 1-based position among word tokens of the ayah in `edition`. */
  readonly position: number;
  /** Verbatim token snapshot from the edition at marking time (integrity check). */
  readonly tokenText: string;
}

export interface MistakeSchedule {
  /** Current interval of the deterministic scheduler, in days. */
  readonly intervalDays: number;
  /** Suggested next review (ISO timestamp) computed by the scheduler. */
  readonly nextReviewAt: string | null;
  /** User override; when set it takes precedence over `nextReviewAt`. */
  readonly manualNextReviewAt: string | null;
  readonly difficultyOverride: DifficultyOverride;
}

export interface Mistake {
  readonly id: string;
  readonly surah: number;
  readonly ayah: number;
  /** Canonical global ayah index 1..6236 (denormalized for fast range queries). */
  readonly globalIndex: number;
  /** Text edition the word position refers to, or null for ayah-level marks. */
  readonly edition: string | null;
  readonly word: WordMark | null;
  readonly category: MistakeCategory;
  readonly status: MistakeStatus;
  readonly severity: Severity;
  readonly note: string;
  /** User's self-reported confidence 1 (low) .. 5 (high), or null. */
  readonly confidence: number | null;
  /** Ayah this one is confused with (for "similar ayah" mistakes). */
  readonly confusedWith: AyahRef | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastReviewedAt: string | null;
  readonly resolvedAt: string | null;
  /** Number of recall reviews recorded. */
  readonly reviewCount: number;
  /** Times the mistake occurred again (re-marked while reading, or "mistake again" outcome). */
  readonly lapseCount: number;
  /** Consecutive "correct without difficulty" outcomes in distinct sessions. */
  readonly successStreak: number;
  /** Session in which the streak last grew (streak grows at most once per session). */
  readonly lastStreakSessionId: string | null;
  readonly reopenCount: number;
  readonly schedule: MistakeSchedule;
  /** Present only on clearly-labelled demo records. */
  readonly demo?: boolean;
}

export interface ReviewEvent {
  readonly id: string;
  readonly mistakeId: string;
  readonly surah: number;
  readonly ayah: number;
  readonly globalIndex: number;
  readonly sessionId: string | null;
  readonly at: string;
  readonly outcome: RecallOutcome;
  readonly assisted: boolean;
  /** How many plays of this ayah preceded the assessment in the session. */
  readonly repetitions: number;
  readonly durationMs: number | null;
  readonly prevStatus: MistakeStatus;
  readonly nextStatus: MistakeStatus;
  readonly demo?: boolean;
}

export type MistakeEventType = 'marked' | 'remarked' | 'edited' | 'status_changed' | 'resolved' | 'reopened' | 'schedule_overridden';

export interface MistakeEvent {
  readonly id: string;
  readonly mistakeId: string;
  readonly at: string;
  readonly type: MistakeEventType;
  readonly from?: MistakeStatus;
  readonly to?: MistakeStatus;
  readonly detail?: string;
  readonly demo?: boolean;
}

export type PlanKind = 'revision' | 'memorization';
export type PlanStatus = 'pending' | 'in_progress' | 'completed';

export interface DailyPlan {
  readonly id: string;
  /** Local calendar date YYYY-MM-DD. */
  readonly date: string;
  readonly kind: PlanKind;
  readonly scope: RevisionScope;
  readonly status: PlanStatus;
  readonly sessionIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export type SessionMode = 'mistakes' | 'full' | 'combined' | 'test';
export type SessionStatus = 'active' | 'completed' | 'abandoned';

export interface RepeatConfig {
  /** Total plays of each marked ayah per group pass (5 = five plays, not 1 + 5). */
  readonly ayahRepeat: number;
  /** Total passes over each group (marked ayah plus its context ayat). */
  readonly groupRepeat: number;
  /** Total passes over the whole playlist. */
  readonly playlistRepeat: number;
  /** Whether context (neighbouring) ayat are also repeated `ayahRepeat` times. */
  readonly repeatContext: boolean;
  readonly pauseBetweenRepetitionsMs: number;
  readonly pauseBetweenAyatMs: number;
  readonly playbackRate: number;
}

export interface RevisionSession {
  readonly id: string;
  readonly planId: string | null;
  readonly mode: SessionMode;
  readonly scope: RevisionScope;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: SessionStatus;
  readonly reciterId: string;
  readonly repeat: RepeatConfig;
  /** Global indexes of marked ayat in the playlist (Quran order). */
  readonly mistakeAyahIndexes: readonly number[];
  readonly plannedSteps: number;
  readonly completedSteps: number;
  /** Distinct ayat whose audio finished at least once. Playback evidence only — never a recall. */
  readonly playedAyahIndexes: readonly number[];
  readonly demo?: boolean;
}
