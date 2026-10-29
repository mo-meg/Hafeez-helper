import type { Mistake, RecallOutcome, ReviewEvent } from '../model.ts';
import { scopeContains, type IndexInterval } from '../quran/scope.ts';
import { daysBetween } from '../util/ids.ts';

/**
 * "Estimated revision quality" — a transparent, configurable heuristic, NOT a validated measure.
 *
 * Inputs are ONLY mistake records and explicit recall outcomes (ReviewEvent). Audio playback is
 * not an input, so the score cannot be raised by replaying audio without a recall attempt.
 *
 * For every ayah in scope that has at least one recorded mistake:
 *   1. Take its review outcomes, keeping only the LAST outcome per session (repeating an ayah
 *      within one sitting counts once), then the most recent `window` outcomes.
 *   2. value = recency-weighted mean of outcome values (easy 1, difficult 0.7, prompt 0.35,
 *      again 0). Never-reviewed ayat get `unreviewedValue`.
 *   3. Staleness: if the last successful recall is older than `staleAfterDays`, subtract
 *      `stalePenaltyPerDay` per extra day (capped at `maxStalePenalty`).
 *   4. Ayat whose mistakes are all resolved get at least `resolvedFloor` (user-confirmed).
 * Score = round(100 × mean(value)). No mistakes in scope → null (nothing to estimate).
 */
export interface ScoringConfig {
  readonly outcomeValues: Readonly<Record<RecallOutcome, number>>;
  readonly window: number;
  readonly recencyWeights: readonly number[];
  readonly unreviewedValue: number;
  readonly staleAfterDays: number;
  readonly stalePenaltyPerDay: number;
  readonly maxStalePenalty: number;
  readonly resolvedFloor: number;
}

export const DEFAULT_SCORING: ScoringConfig = {
  outcomeValues: { correct_easy: 1, correct_difficult: 0.7, needed_prompt: 0.35, mistake_again: 0 },
  window: 5,
  recencyWeights: [1, 0.8, 0.6, 0.45, 0.35],
  unreviewedValue: 0.25,
  staleAfterDays: 14,
  stalePenaltyPerDay: 0.005,
  maxStalePenalty: 0.3,
  resolvedFloor: 0.8,
};

export interface AyahQuality {
  readonly globalIndex: number;
  readonly value: number;
  readonly countedOutcomes: number;
  readonly lastSuccessAt: string | null;
  readonly stale: boolean;
  readonly allResolved: boolean;
}

export interface QualityBreakdown {
  /** 0..100, or null when there are no recorded mistakes in scope. */
  readonly score: number | null;
  readonly ayahCount: number;
  readonly reviewedAyahCount: number;
  readonly unreviewedAyahCount: number;
  readonly staleAyahCount: number;
  readonly outcomeCounts: Readonly<Record<RecallOutcome, number>>;
  readonly perAyah: readonly AyahQuality[];
}

const isSuccess = (o: RecallOutcome) => o === 'correct_easy' || o === 'correct_difficult';

/** Keeps the last event per session; events without a session are kept individually. */
export function dedupeBySession(events: readonly ReviewEvent[]): ReviewEvent[] {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const lastBySession = new Map<string, ReviewEvent>();
  const out: ReviewEvent[] = [];
  for (const e of sorted) {
    if (e.sessionId === null) out.push(e);
    else lastBySession.set(e.sessionId, e);
  }
  out.push(...lastBySession.values());
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export function computeQuality(
  mistakes: readonly Mistake[],
  reviews: readonly ReviewEvent[],
  now: Date,
  scope: readonly IndexInterval[] | null = null,
  cfg: ScoringConfig = DEFAULT_SCORING,
): QualityBreakdown {
  const nowIso = now.toISOString();
  const inScope = (idx: number) => scope === null || scopeContains(scope, idx);
  // Only consider mistakes that existed at `now` (enables consistent historical trends).
  const ms = mistakes.filter((m) => inScope(m.globalIndex) && m.createdAt <= nowIso);
  const byAyah = new Map<number, Mistake[]>();
  for (const m of ms) byAyah.set(m.globalIndex, [...(byAyah.get(m.globalIndex) ?? []), m]);

  // One review per ayah per session: multiple marked words in an ayah share one recall.
  const reviewsByAyah = new Map<number, ReviewEvent[]>();
  const seen = new Set<string>();
  for (const r of reviews) {
    if (r.at > nowIso || !byAyah.has(r.globalIndex)) continue;
    // Events recorded together for several words of one ayah share the same timestamp.
    const key = `${r.globalIndex}|${r.sessionId ?? '-'}|${r.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reviewsByAyah.set(r.globalIndex, [...(reviewsByAyah.get(r.globalIndex) ?? []), r]);
  }

  const outcomeCounts: Record<RecallOutcome, number> = { correct_easy: 0, correct_difficult: 0, needed_prompt: 0, mistake_again: 0 };
  const perAyah: AyahQuality[] = [];
  for (const [globalIndex, list] of [...byAyah.entries()].sort((a, b) => a[0] - b[0])) {
    const events = dedupeBySession(reviewsByAyah.get(globalIndex) ?? []);
    for (const e of events) outcomeCounts[e.outcome]++;
    const recent = events.slice(-cfg.window).reverse(); // most recent first
    let value: number;
    if (recent.length === 0) {
      value = cfg.unreviewedValue;
    } else {
      let num = 0;
      let den = 0;
      recent.forEach((e, i) => {
        const w = cfg.recencyWeights[i] ?? cfg.recencyWeights[cfg.recencyWeights.length - 1] ?? 1;
        num += w * cfg.outcomeValues[e.outcome];
        den += w;
      });
      value = num / den;
    }
    const lastSuccess = [...events].reverse().find((e) => isSuccess(e.outcome))?.at ?? null;
    let stale = false;
    const ref = lastSuccess ?? null;
    if (ref) {
      const days = daysBetween(new Date(ref), now);
      if (days > cfg.staleAfterDays) {
        stale = true;
        value -= Math.min(cfg.maxStalePenalty, (days - cfg.staleAfterDays) * cfg.stalePenaltyPerDay);
      }
    }
    const allResolved = list.every((m) => m.status === 'resolved');
    if (allResolved) value = Math.max(value, cfg.resolvedFloor);
    value = Math.min(1, Math.max(0, value));
    perAyah.push({ globalIndex, value, countedOutcomes: events.length, lastSuccessAt: lastSuccess, stale, allResolved });
  }

  const reviewed = perAyah.filter((a) => a.countedOutcomes > 0).length;
  const score = perAyah.length === 0 ? null : Math.round((100 * perAyah.reduce((s, a) => s + a.value, 0)) / perAyah.length);
  return {
    score,
    ayahCount: perAyah.length,
    reviewedAyahCount: reviewed,
    unreviewedAyahCount: perAyah.length - reviewed,
    staleAyahCount: perAyah.filter((a) => a.stale).length,
    outcomeCounts,
    perAyah,
  };
}
