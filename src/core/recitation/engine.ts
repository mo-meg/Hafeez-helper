/**
 * Speech-recognition engine boundary for the Recitation tracker.
 *
 * The engine is TajweedFormer (Quran Lab, `@quran-lab/tajweedformer`), which runs in the browser
 * (WebAssembly in a Worker). It is a streaming *sound-unit* model: it does not write Arabic words,
 * it returns the units it heard (38 in all). The comparison
 * text is therefore built from the model's own reference table (the expected units of every ayah),
 * never from Arabic spelling. The core only sees this interface, so tests use a fake engine.
 */

import type { HeardUnit } from './segment.ts';

/**
 * The decoded state of the current take (every update carries the whole take so far). Units are
 * flat: the model's word bars are not used (measured: it often emits none in continuous recitation;
 * segment.ts cuts the stream into the canonical words). Unit times are take times in ms.
 */
export interface HeardUpdate {
  readonly units: readonly HeardUnit[];
  /** Leading units that will not change any more in this take. */
  readonly settledUnits: number;
  /** True on the last update of a take. */
  readonly final: boolean;
  /** The take's text as the model renders it (display only). */
  readonly text: string;
  /** The latest chunk held speech. */
  readonly speech: boolean;
}

/** Expected units of one ayah, as the model's reference table gives them. */
export interface AyahUnits {
  /** Unit ids in reading order, word bar included. */
  readonly units: readonly number[];
  /** For each unit, the word it belongs to. */
  readonly words: readonly number[];
  readonly wordCount: number;
}

/** 'ended': the engine closed the take by itself (length limit, hidden page …); 'error': it failed. */
export type TakeEndReason = 'ended' | 'error';

/** One take: audio in, updates out. */
export interface EngineTake {
  /** Mono 16 kHz samples. */
  push(pcm16k: Float32Array): void;
  /** Ends the take; resolves after the final update was delivered. */
  finish(): Promise<void>;
  cancel(): Promise<void>;
}

export interface LoadProgress {
  readonly bytesDone: number;
  readonly bytesTotal: number;
}

export interface RecitationEngine {
  readonly name: string;
  /** Unit id of the word bar (and blank), which never belong to a word. */
  readonly separators: ReadonlySet<number>;
  /** Downloads (first time) and opens the model. Rejects with a readable message. Idempotent. */
  load(onProgress?: (p: LoadProgress) => void): Promise<void>;
  /** Expected units of an ayah (after load). */
  ayahUnits(surah: number, ayah: number): Promise<AyahUnits>;
  /** Opens a take. `onEnd` is called when the engine ends the take by itself. */
  start(onUpdate: (u: HeardUpdate) => void, onEnd: (reason: TakeEndReason, error?: unknown) => void): EngineTake;
}

/** Compact comparison form of a unit sequence: one private-use character per unit. */
export function unitKey(units: readonly number[]): string {
  let s = '';
  for (const u of units) s += String.fromCharCode(0xe000 + u);
  return s;
}

/** Splits an ayah's expected units into per-word comparison forms (in reading order). */
export function wordForms(a: AyahUnits, separators: ReadonlySet<number>): string[] {
  const out: number[][] = [];
  let current: number | null = null;
  a.units.forEach((u, i) => {
    if (separators.has(u)) return;
    const w = a.words[i] ?? -1;
    if (w !== current || !out.length) {
      out.push([]);
      current = w;
    }
    (out[out.length - 1] as number[]).push(u);
  });
  return out.map(unitKey);
}
