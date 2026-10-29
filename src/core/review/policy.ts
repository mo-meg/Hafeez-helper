import type { MistakeStatus, RecallOutcome } from '../model.ts';

/**
 * Documented review policy (see docs/SCORING_AND_SCHEDULING.md).
 * - Listening to audio never changes a status. Only an explicit recall outcome does.
 * - No outcome ever sets "resolved"; resolution is always an explicit user action.
 * - A success streak only grows across DISTINCT sessions (repeating within one sitting
 *   is not evidence of retention).
 */
export interface PolicyConfig {
  /** Streak of easy recalls (distinct sessions) at which status becomes "improved". */
  readonly improvedAfterStreak: number;
  /** Streak at which the UI suggests marking the mistake resolved. */
  readonly suggestResolveAfterStreak: number;
}

export const DEFAULT_POLICY: PolicyConfig = { improvedAfterStreak: 2, suggestResolveAfterStreak: 3 };

export interface PolicyInput {
  readonly status: MistakeStatus;
  readonly successStreak: number;
  readonly lapseCount: number;
  readonly reopenCount: number;
  /** Session id of the most recent "correct_easy" outcome that counted toward the streak. */
  readonly lastStreakSessionId: string | null;
}

export interface PolicyResult {
  readonly status: MistakeStatus;
  readonly successStreak: number;
  readonly lapseCount: number;
  readonly reopenCount: number;
  readonly streakCounted: boolean;
}

export function applyOutcome(
  input: PolicyInput,
  outcome: RecallOutcome,
  sessionId: string | null,
  config: PolicyConfig = DEFAULT_POLICY,
): PolicyResult {
  const { status, successStreak, lapseCount, reopenCount } = input;
  switch (outcome) {
    case 'mistake_again':
      return {
        status: status === 'resolved' ? 'reopened' : 'needs_practice',
        successStreak: 0,
        lapseCount: lapseCount + 1,
        reopenCount: status === 'resolved' ? reopenCount + 1 : reopenCount,
        streakCounted: false,
      };
    case 'needed_prompt':
      return {
        status: status === 'resolved' ? 'reopened' : 'needs_practice',
        successStreak: 0,
        lapseCount,
        reopenCount: status === 'resolved' ? reopenCount + 1 : reopenCount,
        streakCounted: false,
      };
    case 'correct_difficult':
      return {
        status: status === 'resolved' ? 'resolved' : 'under_review',
        successStreak,
        lapseCount,
        reopenCount,
        streakCounted: false,
      };
    case 'correct_easy': {
      const sameSession = sessionId !== null && sessionId === input.lastStreakSessionId;
      const streak = sameSession ? successStreak : successStreak + 1;
      let next: MistakeStatus;
      if (status === 'resolved') next = 'resolved';
      else next = streak >= config.improvedAfterStreak ? 'improved' : 'under_review';
      return { status: next, successStreak: streak, lapseCount, reopenCount, streakCounted: !sameSession };
    }
  }
}

export function shouldSuggestResolve(status: MistakeStatus, successStreak: number, config: PolicyConfig = DEFAULT_POLICY): boolean {
  return status !== 'resolved' && successStreak >= config.suggestResolveAfterStreak;
}
