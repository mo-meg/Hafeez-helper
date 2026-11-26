import type { HypWord } from './align.ts';
import { MODEL_RATE } from './audio.ts';
import type { RecitationCorpus } from './corpus.ts';
import type { EngineTake, HeardUpdate, LoadProgress, RecitationEngine, TakeEndReason } from './engine.ts';
import { UnitSegmenter, type HeardUnit } from './segment.ts';
import type { RecitationTracker, TrackerSnapshot, WordStatus } from './tracker.ts';

export type RecitationStatus = 'idle' | 'loading' | 'listening' | 'stopping' | 'stopped' | 'error';
export type RecitationErrorKind = 'model' | 'engine' | 'microphone';

export interface RecitationState {
  readonly status: RecitationStatus;
  readonly error: { readonly kind: RecitationErrorKind; readonly detail: string } | null;
  /** True while the model hears no speech (for the "waiting for recitation" hint). */
  readonly silent: boolean;
  /** Paused by the user: audio is ignored, the session continues on resume. */
  readonly paused: boolean;
  /** The pause was automatic (nothing recited for RecitationTiming.autoPauseMs). */
  readonly autoPaused: boolean;
  /** What the model heard in the current take, in its own sound notation (display only — never Quran text). */
  readonly heard: string;
  /** Model download progress while loading (first use only). */
  readonly progress: LoadProgress | null;
  readonly tracker: TrackerSnapshot;
}

/** Timers that act on the reciter's silence (ms of fed audio; 0 = off). */
export interface RecitationTiming {
  /** Stuck before the next word this long (and quiet for at least a second): show it, record it as forgotten. */
  readonly promptMs: number;
  /** Nothing recited this long: pause listening (the model stops working until resumed). */
  readonly autoPauseMs: number;
}

export const DEFAULT_TIMING: RecitationTiming = { promptMs: 3000, autoPauseMs: 30000 };
/** The prompt never fires while the reciter is audibly saying something (shorter than this quiet). */
const PROMPT_QUIET_MS = 1000;

/** One segmenter per corpus (it indexes the whole text once). */
const segmenters = new WeakMap<RecitationCorpus, UnitSegmenter>();
function segmenterFor(corpus: RecitationCorpus): UnitSegmenter {
  let s = segmenters.get(corpus);
  if (!s) segmenters.set(corpus, (s = new UnitSegmenter(corpus)));
  return s;
}

interface TakeCtx {
  take: EngineTake | null;
  /** Session time (ms of audio fed before this take). */
  readonly offsetMs: number;
  /** Units of this take already handed on (as words) or dropped. */
  consumed: number;
  done: Promise<void> | null;
}

/**
 * Glue between audio input, the streaming engine and the tracker.
 *
 * The engine decodes continuously and re-sends the whole take on every update (every ~160 ms: the
 * shortest context the model offers, for fast recitation).
 * Settled units (that will not change any more) are cut into the canonical words by the
 * UnitSegmenter; each word reaches the tracker once, the last one only when the next has begun or
 * the take ended.
 * Pausing ends the take; resuming opens a new one. Session time counts fed audio only, so a pause
 * never looks like hesitation. A take the engine ends by itself (length limit) is continued in a new one.
 */
export class RecitationController {
  private readonly engine: RecitationEngine;
  readonly tracker: RecitationTracker;
  private readonly onUpdate: (s: RecitationState) => void;
  private status: RecitationStatus = 'idle';
  private error: RecitationState['error'] = null;
  private silent = true;
  private paused = false;
  private autoPaused = false;
  private heard = '';
  private readonly timing: RecitationTiming;
  /** Fed-audio time of the last move of the tracker's cursor / of the last chunk with speech. */
  private lastMoveMs = 0;
  private lastSpeechMs = 0;
  private lastCursor: number | null = null;
  private progress: LoadProgress | null = null;
  private ctx: TakeCtx | null = null;
  private fedMs = 0;
  private lastEndMs: number | null = null;
  private closing: Promise<void>[] = [];
  private readonly segmenter: UnitSegmenter;

  constructor(deps: { engine: RecitationEngine; tracker: RecitationTracker; onUpdate: (s: RecitationState) => void; segmenter?: UnitSegmenter; timing?: Partial<RecitationTiming> }) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.engine = deps.engine;
    this.tracker = deps.tracker;
    this.onUpdate = deps.onUpdate;
    this.segmenter = deps.segmenter ?? segmenterFor(deps.tracker.corpus);
  }

  state(): RecitationState {
    return { status: this.status, error: this.error, silent: this.silent, paused: this.paused, autoPaused: this.autoPaused, heard: this.heard, progress: this.progress, tracker: this.tracker.snapshot() };
  }

  async start(): Promise<boolean> {
    this.set('loading');
    try {
      await this.engine.load((p) => {
        this.progress = p;
        this.emit();
      });
    } catch (e) {
      this.progress = null;
      this.fail('model', e);
      return false;
    }
    this.progress = null;
    this.resetSilence();
    this.openTake();
    this.set('listening');
    return true;
  }

  /** User correction of one word (see RecitationTracker.override); repaints at once. */
  overrideWord(flat: number, status: WordStatus | null): void {
    this.tracker.override(flat, status);
    this.emit();
  }

  /** Feeds 16 kHz mono samples. */
  feed(pcm16k: Float32Array): void {
    if (this.status !== 'listening' || this.paused || !this.ctx?.take) return;
    this.ctx.take.push(pcm16k);
    this.fedMs += (pcm16k.length * 1000) / MODEL_RATE;
    this.watchSilence();
  }

  /** Stuck before a word → show it as forgotten; silent for long → pause. Driven by fed audio time. */
  private watchSilence(): void {
    const { promptMs, autoPauseMs } = this.timing;
    const now = this.fedMs;
    if (promptMs > 0 && this.tracker.mode === 'focused' && now - this.lastMoveMs >= promptMs && now - this.lastSpeechMs >= Math.min(promptMs, PROMPT_QUIET_MS)) {
      if (this.tracker.prompt(now) !== null) this.emit();
    }
    if (autoPauseMs > 0 && now - Math.max(this.lastMoveMs, this.lastSpeechMs) >= autoPauseMs) {
      this.autoPaused = true;
      this.pause();
    }
  }

  /** Restarts the silence timers (start, resume). */
  private resetSilence(): void {
    this.lastMoveMs = this.fedMs;
    this.lastSpeechMs = this.fedMs;
  }

  /** Pauses listening; the current take is closed so nothing is half-recognised. */
  pause(): void {
    if (this.status !== 'listening' || this.paused) return;
    this.paused = true;
    this.silent = true;
    this.closeTake();
    this.emit();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.autoPaused = false;
    this.resetSilence();
    if (this.status === 'listening' && !this.ctx) this.openTake();
    this.emit();
  }

  /** Microphone or input failure: keep what was recognised, finish gracefully. */
  async interrupt(detail: unknown): Promise<void> {
    if (this.status === 'stopped' || this.status === 'idle') return;
    await this.stop();
    this.fail('microphone', detail);
  }

  async stop(): Promise<void> {
    if (this.status !== 'listening' && this.status !== 'loading') return;
    this.set('stopping');
    this.closeTake();
    await this.idle();
    this.tracker.finish();
    if ((this.status as RecitationStatus) === 'stopping') this.set('stopped');
    else this.emit();
  }

  /** Resolves when every closed take has delivered its final words (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.closing.length) await this.closing.shift();
  }

  private openTake(): void {
    const ctx: TakeCtx = { take: null, offsetMs: this.fedMs, consumed: 0, done: null };
    this.ctx = ctx;
    try {
      ctx.take = this.engine.start(
        (u) => this.onTakeUpdate(ctx, u),
        (reason, err) => this.onTakeEnd(ctx, reason, err),
      );
    } catch (e) {
      this.ctx = null;
      this.fail('engine', e);
    }
  }

  private closeTake(): void {
    const ctx = this.ctx;
    this.ctx = null;
    if (!ctx?.take) return;
    const take = ctx.take;
    ctx.done = take.finish().catch((e: unknown) => {
      if (this.status !== 'error') this.fail('engine', e);
    });
    this.closing.push(ctx.done);
  }

  private onTakeUpdate(ctx: TakeCtx, u: HeardUpdate): void {
    if (u.text.trim()) this.heard = u.text.trim();
    if (ctx === this.ctx) {
      this.silent = !u.speech;
      if (u.speech) this.lastSpeechMs = this.fedMs;
    }
    const settled = u.final ? u.units.length : Math.min(u.settledUnits, u.units.length);
    let words: HypWord[] = [];
    let anchor: number | undefined;
    if (settled > ctx.consumed) {
      const pending: HeardUnit[] = u.units.slice(ctx.consumed, settled).map((x) => ({ ...x, startMs: ctx.offsetMs + x.startMs, endMs: ctx.offsetMs + x.endMs }));
      const cursor = this.tracker.mode === 'focused' ? this.tracker.cursor : null;
      const r = this.segmenter.segment(pending, cursor, u.final, this.tracker.bounds());
      ctx.consumed += r.consumed;
      words = r.words;
      anchor = r.anchor;
    }
    if (words.length) {
      const first = words[0] as HypWord;
      const last = words[words.length - 1] as HypWord;
      const silenceBeforeMs = this.lastEndMs === null ? 0 : Math.max(0, (first.startMs as number) - this.lastEndMs);
      this.tracker.push({ words, startMs: first.startMs as number, endMs: last.endMs as number, silenceBeforeMs, ...(anchor !== undefined ? { anchor } : {}) });
      this.lastEndMs = last.endMs as number;
    } else if (u.final) {
      const at = this.lastEndMs ?? ctx.offsetMs;
      this.tracker.push({ words: [], startMs: at, endMs: at, silenceBeforeMs: 0 });
    }
    if (this.tracker.cursor !== this.lastCursor) {
      this.lastCursor = this.tracker.cursor;
      this.lastMoveMs = this.fedMs;
    }
    this.emit();
  }

  private onTakeEnd(ctx: TakeCtx, reason: TakeEndReason, err?: unknown): void {
    if (ctx !== this.ctx) return; // a take we closed ourselves
    if (reason === 'ended' && this.status === 'listening') {
      // E.g. the engine's take length limit: continue in a new take without losing audio.
      this.ctx = null;
      this.openTake();
      return;
    }
    if (reason === 'error') {
      this.ctx = null;
      this.tracker.finish();
      this.fail('engine', err ?? new Error('recognition stopped'));
    }
  }

  private fail(kind: RecitationErrorKind, e: unknown): void {
    this.error = { kind, detail: e instanceof Error ? e.message : String(e) };
    this.set('error');
  }

  private set(s: RecitationStatus): void {
    this.status = s;
    this.emit();
  }

  private emit(): void {
    this.onUpdate(this.state());
  }
}
