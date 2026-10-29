import type { Mistake, RepeatConfig, SessionMode } from '../model.ts';
import { buildMistakePlaylist, buildPortionPlaylist, type Playlist, type PlaylistOptions } from '../playlist/playlist.ts';
import { concatSequences, expandSequence, type PlaybackStep } from '../playlist/sequence.ts';
import type { DivisionIndex } from '../quran/divisions.ts';
import { scopeIntervals, type RevisionScope } from '../quran/scope.ts';

export interface SessionConfig {
  readonly mode: SessionMode;
  readonly scope: RevisionScope;
  readonly planId: string | null;
  /** Human-readable label of what is being revised. */
  readonly label: string;
  readonly options: PlaylistOptions;
  readonly repeat: RepeatConfig;
  /** Plays per ayah in the full-portion phase. */
  readonly portionAyahRepeat: number;
  readonly reciterId: string;
}

export interface BuiltSession {
  readonly mistakePlaylist: Playlist | null;
  readonly portionPlaylist: Playlist | null;
  readonly steps: readonly PlaybackStep[];
  /** Distinct marked ayat (Quran order) that the session covers. */
  readonly mistakeAyahIndexes: readonly number[];
}

/**
 * mistakes → only marked ayat (with options);
 * full     → every ayah of the scope (portionAyahRepeat plays each);
 * combined → marked ayat first, then the full portion.
 */
export function buildSession(config: SessionConfig, mistakes: readonly Mistake[], index: DivisionIndex): BuiltSession {
  const intervals = scopeIntervals(config.scope, index);
  const portionRepeat: RepeatConfig = { ...config.repeat, ayahRepeat: config.portionAyahRepeat, groupRepeat: 1, playlistRepeat: 1, repeatContext: true };
  const mp = config.mode === 'full' ? null : buildMistakePlaylist(mistakes, intervals, config.options);
  const pp = config.mode === 'mistakes' ? null : buildPortionPlaylist(mistakes, intervals);
  const parts: Array<{ steps: PlaybackStep[]; config: RepeatConfig }> = [];
  if (mp) parts.push({ steps: expandSequence(mp, config.repeat, 'mistakes'), config: config.repeat });
  if (pp) parts.push({ steps: expandSequence(pp, portionRepeat, 'portion'), config: portionRepeat });
  return {
    mistakePlaylist: mp,
    portionPlaylist: pp,
    steps: concatSequences(parts),
    mistakeAyahIndexes: (mp ?? pp)?.mistakeAyahIndexes ?? [],
  };
}
