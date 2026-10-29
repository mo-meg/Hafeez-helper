import { formatRef } from '../quran/refs.ts';
import type { PlaybackStep } from '../playlist/sequence.ts';

/** Platform audio abstraction (HTMLAudioElement in the browser, a fake in tests). */
export interface AudioBackend {
  /** Loads a source; resolves when playable, rejects on network/decoding/404 errors. */
  load(url: string): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  setRate(rate: number): void;
  onEnded(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
}

export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Resolves the URL (remote or offline blob) for a step. Throws AudioUnavailableError if impossible. */
export type UrlResolver = (step: PlaybackStep) => Promise<string>;

export class AudioUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioUnavailableError';
  }
}

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'gap' | 'awaiting_assessment' | 'error' | 'finished';

export interface PlayerError {
  readonly message: string;
  readonly globalIndex: number;
  /** Technical reason reported by the audio backend (for display next to a localized message). */
  readonly reason: string;
  /** True when the ayah is unavailable because the device is offline and it is not cached. */
  readonly offline: boolean;
}

export interface PlayerState {
  readonly status: PlayerStatus;
  readonly steps: readonly PlaybackStep[];
  readonly index: number;
  readonly current: PlaybackStep | null;
  readonly error: PlayerError | null;
  /** Steps whose audio played to the end. */
  readonly completedSteps: number;
  /** Ayat the user explicitly skipped after an audio error. */
  readonly skippedAyat: readonly number[];
  readonly rate: number;
  readonly pauseForAssessment: boolean;
}

type Listener = (s: PlayerState) => void;

/**
 * Deterministic playback state machine over a precomputed step list.
 * Audio errors never skip silently: the player stops in 'error' until the user retries or skips.
 */
export class PlaybackController {
  private readonly backend: AudioBackend;
  private readonly timers: TimerApi;
  private readonly resolveUrl: UrlResolver;
  private steps: readonly PlaybackStep[] = [];
  private index = 0;
  private status: PlayerStatus = 'idle';
  private pausedFrom: 'playing' | 'gap' | 'loading' | null = null;
  private error: PlayerError | null = null;
  private completed = 0;
  private skipped: number[] = [];
  private rate = 1;
  private assessmentPause = false;
  private generation = 0;
  private timer: unknown = null;
  private readonly listeners = new Set<Listener>();
  private readonly completedListeners = new Set<(s: PlaybackStep) => void>();
  private readonly finishedListeners = new Set<() => void>();

  constructor(deps: { backend: AudioBackend; resolveUrl: UrlResolver; timers?: TimerApi }) {
    this.backend = deps.backend;
    this.resolveUrl = deps.resolveUrl;
    this.timers = deps.timers ?? realTimers;
    this.backend.onEnded(() => this.handleEnded());
    this.backend.onError((err) => {
      if (this.status === 'playing' || this.status === 'loading') this.fail(err);
    });
  }

  // ---- observation -------------------------------------------------------------------------
  get state(): PlayerState {
    return {
      status: this.status,
      steps: this.steps,
      index: this.index,
      current: this.steps[this.index] ?? null,
      error: this.error,
      completedSteps: this.completed,
      skippedAyat: [...this.skipped],
      rate: this.rate,
      pauseForAssessment: this.assessmentPause,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  onStepCompleted(fn: (s: PlaybackStep) => void): () => void {
    this.completedListeners.add(fn);
    return () => this.completedListeners.delete(fn);
  }

  onFinished(fn: () => void): () => void {
    this.finishedListeners.add(fn);
    return () => this.finishedListeners.delete(fn);
  }

  private emit() {
    const s = this.state;
    for (const l of this.listeners) l(s);
  }

  // ---- configuration -----------------------------------------------------------------------
  setSteps(steps: readonly PlaybackStep[]): void {
    this.cancelPending();
    this.backend.stop();
    this.steps = steps;
    this.index = 0;
    this.completed = 0;
    this.skipped = [];
    this.error = null;
    this.status = 'idle';
    this.emit();
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.backend.setRate(rate);
    this.emit();
  }

  setPauseForAssessment(on: boolean): void {
    this.assessmentPause = on;
    this.emit();
  }

  // ---- commands ----------------------------------------------------------------------------
  start(): Promise<void> {
    return this.goTo(0);
  }

  async play(): Promise<void> {
    switch (this.status) {
      case 'idle':
      case 'finished':
        return this.goTo(this.status === 'finished' ? 0 : this.index);
      case 'paused':
        if (this.pausedFrom === 'playing') {
          this.status = 'playing';
          this.pausedFrom = null;
          this.emit();
          try {
            await this.backend.play();
          } catch (e) {
            this.fail(e);
          }
          return;
        }
        if (this.pausedFrom === 'gap') return this.advance();
        return this.goTo(this.index);
      case 'awaiting_assessment':
        return this.continueAfterAssessment();
      case 'error':
        return this.retry();
      default:
        return;
    }
  }

  pause(): void {
    if (this.status === 'playing') {
      this.backend.pause();
      this.pausedFrom = 'playing';
    } else if (this.status === 'gap') {
      this.cancelPending();
      this.pausedFrom = 'gap';
    } else if (this.status === 'loading') {
      this.generation++;
      this.pausedFrom = 'loading';
    } else {
      return;
    }
    this.status = 'paused';
    this.emit();
  }

  togglePlay(): Promise<void> {
    if (this.status === 'playing' || this.status === 'gap' || this.status === 'loading') {
      this.pause();
      return Promise.resolve();
    }
    return this.play();
  }

  stop(): void {
    this.cancelPending();
    this.backend.stop();
    this.status = 'idle';
    this.index = 0;
    this.error = null;
    this.emit();
  }

  /** Next distinct ayah item (skips remaining repetitions of the current one). */
  next(): Promise<void> {
    const i = this.findNext((s, cur) => s.itemKey !== cur.itemKey);
    return i === null ? this.finish() : this.goTo(i);
  }

  /** Start of the previous item (or of the current one if it is the first). */
  prev(): Promise<void> {
    const start = this.itemStart(this.index);
    if (start === 0) return this.goTo(0);
    return this.goTo(this.itemStart(start - 1));
  }

  restartAyah(): Promise<void> {
    return this.goTo(this.itemStart(this.index));
  }

  /** Next item whose role is 'mistake' (skipping context/portion ayat). */
  nextMistake(): Promise<void> {
    const i = this.findNext((s, cur) => s.itemKey !== cur.itemKey && s.role === 'mistake');
    return i === null ? this.finish() : this.goTo(i);
  }

  restartPlaylist(): Promise<void> {
    this.completed = 0;
    return this.goTo(0);
  }

  retry(): Promise<void> {
    return this.goTo(this.index);
  }

  /** Explicitly skip an ayah whose audio failed; it is recorded as skipped. */
  skipFailed(): Promise<void> {
    const cur = this.steps[this.index];
    if (cur && !this.skipped.includes(cur.item.globalIndex)) this.skipped.push(cur.item.globalIndex);
    this.error = null;
    return this.next();
  }

  continueAfterAssessment(): Promise<void> {
    if (this.status !== 'awaiting_assessment') return Promise.resolve();
    return this.advance();
  }

  jumpTo(stepIndex: number): Promise<void> {
    return this.goTo(Math.max(0, Math.min(stepIndex, this.steps.length - 1)));
  }

  // ---- internals ---------------------------------------------------------------------------
  private itemStart(i: number): number {
    const key = this.steps[i]?.itemKey;
    let j = i;
    while (j > 0 && this.steps[j - 1]?.itemKey === key) j--;
    return j;
  }

  private findNext(pred: (s: PlaybackStep, cur: PlaybackStep) => boolean): number | null {
    const cur = this.steps[this.index];
    if (!cur) return null;
    for (let i = this.index + 1; i < this.steps.length; i++) if (pred(this.steps[i] as PlaybackStep, cur)) return i;
    return null;
  }

  private cancelPending() {
    this.generation++;
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }

  private async goTo(i: number): Promise<void> {
    this.cancelPending();
    const step = this.steps[i];
    if (!step) {
      this.status = this.steps.length === 0 ? 'idle' : 'finished';
      this.emit();
      return;
    }
    const gen = this.generation;
    this.index = i;
    this.error = null;
    this.pausedFrom = null;
    this.status = 'loading';
    this.emit();
    try {
      const url = await this.resolveUrl(step);
      if (gen !== this.generation) return;
      await this.backend.load(url);
      if (gen !== this.generation) return;
      this.backend.setRate(this.rate);
      this.status = 'playing';
      this.emit();
      await this.backend.play();
    } catch (e) {
      if (gen === this.generation) this.fail(e);
    }
  }

  private fail(e: unknown) {
    const step = this.steps[this.index];
    const where = step ? formatRef(step.item.ref) : 'this ayah';
    const reason = e instanceof Error ? e.message : String(e);
    this.cancelPending();
    this.backend.stop();
    this.status = 'error';
    this.error = { message: `Audio for ${where} could not be played: ${reason}`, globalIndex: step?.item.globalIndex ?? 0, reason, offline: e instanceof AudioUnavailableError };
    this.emit();
  }

  private handleEnded() {
    if (this.status !== 'playing') return;
    const step = this.steps[this.index];
    if (!step) return;
    this.completed++;
    for (const l of this.completedListeners) l(step);
    if (this.assessmentPause && step.isLastRepetition && step.role === 'mistake') {
      this.status = 'awaiting_assessment';
      this.emit();
      return;
    }
    if (this.index >= this.steps.length - 1) {
      void this.finish();
      return;
    }
    if (step.pauseAfterMs > 0) {
      this.status = 'gap';
      this.emit();
      const gen = ++this.generation;
      this.timer = this.timers.set(() => {
        this.timer = null;
        if (gen === this.generation) void this.advance();
      }, step.pauseAfterMs);
      return;
    }
    void this.advance();
  }

  private advance(): Promise<void> {
    if (this.index >= this.steps.length - 1) return this.finish();
    return this.goTo(this.index + 1);
  }

  private finish(): Promise<void> {
    this.cancelPending();
    this.backend.stop();
    this.status = 'finished';
    this.emit();
    for (const l of this.finishedListeners) l();
    return Promise.resolve();
  }
}
