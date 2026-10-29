import type { RepeatConfig } from '../model.ts';
import type { ItemRole, Playlist, PlaylistItem } from './playlist.ts';

export type Phase = 'mistakes' | 'portion';

/**
 * One concrete play of one ayah. The whole session is a flat, precomputed list of steps, so
 * repetition counts can be verified exactly and the player is a simple cursor over the list.
 */
export interface PlaybackStep {
  readonly stepIndex: number;
  readonly phase: Phase;
  readonly playlistPass: number;
  readonly playlistPasses: number;
  readonly groupIndex: number;
  readonly groupPass: number;
  readonly groupPasses: number;
  /** Position of the item inside its group. */
  readonly itemIndex: number;
  /** Stable key of the item occurrence (same for all repetitions of that item in that pass). */
  readonly itemKey: string;
  readonly item: PlaylistItem;
  readonly role: ItemRole;
  /** 1-based repetition of this item in the current group pass. */
  readonly repetition: number;
  readonly repetitions: number;
  /** Pause after this step finishes, before the next step starts. */
  readonly pauseAfterMs: number;
  readonly isLastRepetition: boolean;
}

export class RepeatConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepeatConfigError';
  }
}

export const REPEAT_LIMITS = { maxRepeat: 50, maxPauseMs: 60_000, minRate: 0.5, maxRate: 2 } as const;

export function validateRepeatConfig(c: RepeatConfig): void {
  for (const [k, v] of [['ayahRepeat', c.ayahRepeat], ['groupRepeat', c.groupRepeat], ['playlistRepeat', c.playlistRepeat]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > REPEAT_LIMITS.maxRepeat) throw new RepeatConfigError(`${k} must be an integer from 1 to ${REPEAT_LIMITS.maxRepeat} (got ${v})`);
  }
  for (const [k, v] of [['pauseBetweenRepetitionsMs', c.pauseBetweenRepetitionsMs], ['pauseBetweenAyatMs', c.pauseBetweenAyatMs]] as const) {
    if (!Number.isFinite(v) || v < 0 || v > REPEAT_LIMITS.maxPauseMs) throw new RepeatConfigError(`${k} must be between 0 and ${REPEAT_LIMITS.maxPauseMs} ms`);
  }
  if (!(c.playbackRate >= REPEAT_LIMITS.minRate && c.playbackRate <= REPEAT_LIMITS.maxRate)) {
    throw new RepeatConfigError(`playbackRate must be between ${REPEAT_LIMITS.minRate} and ${REPEAT_LIMITS.maxRate}`);
  }
}

/**
 * Expands a playlist into steps. Semantics (all counts are TOTAL plays, never "extra" plays):
 *   for playlistPass in 1..playlistRepeat
 *     for each group (Quran order)
 *       for groupPass in 1..groupRepeat
 *         for each item in the group
 *           reps = (role is 'mistake' || repeatContext) ? ayahRepeat : 1
 *           play the item `reps` times
 * In a 'portion' playlist every ayah is played `ayahRepeat` times only if repeatContext is set,
 * otherwise once (portion ayat behave like context).
 */
export function expandSequence(playlist: Playlist, config: RepeatConfig, phase: Phase = playlist.kind === 'portion' ? 'portion' : 'mistakes'): PlaybackStep[] {
  validateRepeatConfig(config);
  const steps: Omit<PlaybackStep, 'pauseAfterMs' | 'stepIndex'>[] = [];
  for (let p = 1; p <= config.playlistRepeat; p++) {
    playlist.groups.forEach((group, gi) => {
      for (let g = 1; g <= config.groupRepeat; g++) {
        group.items.forEach((item, ii) => {
          const reps = item.role === 'mistake' || config.repeatContext ? config.ayahRepeat : 1;
          const itemKey = `${phase}|${p}|${gi}|${g}|${ii}`;
          for (let r = 1; r <= reps; r++) {
            steps.push({
              phase,
              playlistPass: p,
              playlistPasses: config.playlistRepeat,
              groupIndex: gi,
              groupPass: g,
              groupPasses: config.groupRepeat,
              itemIndex: ii,
              itemKey,
              item,
              role: item.role,
              repetition: r,
              repetitions: reps,
              isLastRepetition: r === reps,
            });
          }
        });
      }
    });
  }
  return finalize(steps, config);
}

/** Concatenates phases (combined revision: mistakes first, then the full portion). */
export function concatSequences(parts: ReadonlyArray<{ steps: readonly PlaybackStep[]; config: RepeatConfig }>): PlaybackStep[] {
  const out: PlaybackStep[] = [];
  parts.forEach(({ steps, config }, pi) => {
    steps.forEach((s, i) => {
      const lastOfPart = i === steps.length - 1;
      const hasNextPart = parts.slice(pi + 1).some((x) => x.steps.length > 0);
      out.push({ ...s, stepIndex: out.length, pauseAfterMs: lastOfPart ? (hasNextPart ? config.pauseBetweenAyatMs : 0) : s.pauseAfterMs });
    });
  });
  return out;
}

function finalize(steps: Omit<PlaybackStep, 'pauseAfterMs' | 'stepIndex'>[], c: RepeatConfig): PlaybackStep[] {
  return steps.map((s, i) => {
    const next = steps[i + 1];
    let pause = 0;
    if (next) pause = next.itemKey === s.itemKey ? c.pauseBetweenRepetitionsMs : c.pauseBetweenAyatMs;
    return { ...s, stepIndex: i, pauseAfterMs: pause };
  });
}

/** Total plays per global ayah index (useful for previews and tests). */
export function playsPerAyah(steps: readonly PlaybackStep[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of steps) m.set(s.item.globalIndex, (m.get(s.item.globalIndex) ?? 0) + 1);
  return m;
}

/**
 * Duration estimate. Without verified timing data, an ayah's length is estimated from its word
 * count (secondsPerWord at rate 1) or a fallback per ayah. Clearly an estimate.
 */
export function estimateDurationMs(
  steps: readonly PlaybackStep[],
  playbackRate: number,
  wordCountOf: ((globalIndex: number) => number | null) | null,
  opts: { secondsPerWord: number; fallbackSecondsPerAyah: number } = { secondsPerWord: 0.75, fallbackSecondsPerAyah: 12 },
): number {
  let ms = 0;
  for (const s of steps) {
    const words = wordCountOf?.(s.item.globalIndex) ?? null;
    const sec = words !== null ? Math.max(2, words * opts.secondsPerWord) : opts.fallbackSecondsPerAyah;
    ms += (sec * 1000) / playbackRate + s.pauseAfterMs;
  }
  return Math.round(ms);
}
