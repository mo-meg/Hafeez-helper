import type { DifficultyOverride, Mistake, MistakeCategory, RecallOutcome, Severity } from '../model.ts';
import { addDays, daysBetween } from '../util/ids.ts';

/**
 * Deterministic review scheduler (a transparent ladder, not an opaque model).
 * interval = ladder[step] × severity × category × lapses × difficulty × overdue-bonus,
 * clamped to [minDays, maxDays] and rounded to whole days.
 */
export interface SchedulerConfig {
  readonly ladderDays: readonly number[];
  readonly severityFactor: Readonly<Record<Severity, number>>;
  readonly categoryFactor: Readonly<Partial<Record<MistakeCategory, number>>>;
  readonly lapsePenalty: number;
  readonly minLapseFactor: number;
  readonly difficultyFactor: Readonly<Record<DifficultyOverride, number>>;
  readonly maxOverdueBonus: number;
  readonly minDays: number;
  readonly maxDays: number;
}

export const DEFAULT_SCHEDULER: SchedulerConfig = {
  ladderDays: [1, 2, 4, 7, 14, 30, 60],
  severityFactor: { 1: 1, 2: 0.8, 3: 0.6 },
  // Mutashabihat confusions and broken links between ayat are reviewed more often.
  categoryFactor: { similar_ayah: 0.75, ayah_transition: 0.75 },
  lapsePenalty: 0.15,
  minLapseFactor: 0.4,
  difficultyFactor: { easier: 1.5, normal: 1, harder: 0.6 },
  maxOverdueBonus: 1.5,
  minDays: 1,
  maxDays: 120,
};

export interface ScheduleInput {
  readonly outcome: RecallOutcome;
  /** Streak AFTER applying the outcome (see policy.ts). */
  readonly successStreak: number;
  readonly lapseCount: number;
  readonly severity: Severity;
  readonly category: MistakeCategory;
  readonly difficulty: DifficultyOverride;
  readonly previousIntervalDays: number;
  readonly lastReviewedAt: string | null;
  readonly reviewedAt: Date;
}

export function computeIntervalDays(input: ScheduleInput, cfg: SchedulerConfig = DEFAULT_SCHEDULER): number {
  const ladder = cfg.ladderDays;
  const top = ladder.length - 1;
  let base: number;
  switch (input.outcome) {
    case 'mistake_again':
    case 'needed_prompt':
      base = ladder[0] as number;
      break;
    case 'correct_difficult':
      base = ladder[Math.min(input.successStreak, top)] as number;
      break;
    case 'correct_easy':
      base = ladder[Math.min(input.successStreak, top)] as number;
      break;
  }
  let factor =
    cfg.severityFactor[input.severity] *
    (cfg.categoryFactor[input.category] ?? 1) *
    Math.max(cfg.minLapseFactor, 1 - cfg.lapsePenalty * input.lapseCount) *
    cfg.difficultyFactor[input.difficulty];
  // Successful recall after a longer-than-planned gap is stronger evidence of retention.
  if (input.outcome === 'correct_easy' && input.lastReviewedAt && input.previousIntervalDays > 0) {
    const elapsed = daysBetween(new Date(input.lastReviewedAt), input.reviewedAt);
    if (elapsed > input.previousIntervalDays) {
      factor *= Math.min(cfg.maxOverdueBonus, elapsed / input.previousIntervalDays);
    }
  }
  return Math.min(cfg.maxDays, Math.max(cfg.minDays, Math.round(base * factor)));
}

/** The date the mistake should next be reviewed (manual override wins). Null if resolved. */
export function effectiveDueDate(m: Mistake): Date | null {
  if (m.status === 'resolved') return null;
  const iso = m.schedule.manualNextReviewAt ?? m.schedule.nextReviewAt ?? m.createdAt;
  return new Date(iso);
}

export function isDue(m: Mistake, now: Date): boolean {
  const d = effectiveDueDate(m);
  return d !== null && d.getTime() <= now.getTime();
}

export function nextReviewIso(reviewedAt: Date, intervalDays: number): string {
  return addDays(reviewedAt, intervalDays).toISOString();
}
