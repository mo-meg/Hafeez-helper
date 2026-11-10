import type { HypWord } from './align.ts';
import { Chunker, MODEL_RATE, type AudioChunk, type ChunkerConfig } from './audio.ts';
import type { AsrEngine, AsrResult } from './engine.ts';
import { normWord } from './normalize.ts';
import type { RecitationTracker, TrackerSnapshot } from './tracker.ts';

export type RecitationStatus = 'idle' | 'loading' | 'listening' | 'stopping' | 'stopped' | 'error';
export type RecitationErrorKind = 'model' | 'engine' | 'microphone';

export interface RecitationState {
  readonly status: RecitationStatus;
  readonly error: { readonly kind: RecitationErrorKind; readonly detail: string } | null;
  /** True while the input is silent (for the "waiting for recitation" hint). */
  readonly silent: boolean;
  readonly backlog: number;
  /** Paused by the user: audio is ignored, the session continues on resume. */
  readonly paused: boolean;
  /** Latest model transcript (display only — never Quran text). */
  readonly heard: string;
  /** Duration of the latest recognition call in ms. */
  readonly latencyMs: number | null;
  readonly tracker: TrackerSnapshot;
}

export interface WindowConfig {
  /** Already-committed audio kept before new audio as acoustic context for the model. */
  readonly leftContextMs: number;
  /** Longest window; beyond it everything recognised is committed. */
  readonly maxWindowMs: number;
}

/**
 * Measured with the real model (scripts/recitation-audio-check.ts): FastConformer is far less
 * accurate on isolated 2–4 s pieces than with context, so recent audio is re-recognised in a
 * sliding window and only words that are stable (not at the live edge) are committed.
 */
export const DEFAULT_WINDOW: WindowConfig = { leftContextMs: 4000, maxWindowMs: 16000 };

/** Converts an engine result into tracker words; timestamps only when the engine gave them. */
export function toHypWords(r: AsrResult, chunkStartMs: number): HypWord[] {
  if (r.words && r.words.length) {
    return r.words
      .map((w) => ({
        norm: normWord(w.word),
        raw: w.word,
        startMs: chunkStartMs + w.start * 1000,
        endMs: chunkStartMs + w.end * 1000,
        ...(w.confidence !== undefined ? { confidence: w.confidence } : {}),
      }))
      .filter((w) => w.norm.length > 0);
  }
  return r.text.split(/\s+/u).map((raw) => ({ norm: normWord(raw), raw })).filter((w) => w.norm.length > 0);
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

const msToSamples = (ms: number) => Math.round((ms * MODEL_RATE) / 1000);

/**
 * Glue between audio input, one engine and the tracker.
 *
 * Audio arrives as VAD chunks (≤ 2 s steps inside continuous speech). Each step re-recognises a
 * window = up to 3 s of already-committed context + all uncommitted audio. With word timestamps,
 * a word is committed once its midpoint lies after the previous commit point and it ends before
 * the live edge, so every spoken word reaches the tracker exactly once (decided by time, never
 * by text). At a pause (final chunk) everything is committed and the window restarts.
 * Without timestamps each chunk is recognised once and committed whole.
 * When recognition falls behind, queued steps are folded into one window (nothing dropped).
 */
export class RecitationController {
  private readonly engine: AsrEngine;
  readonly tracker: RecitationTracker;
  private readonly chunker: Chunker;
  private readonly onUpdate: (s: RecitationState) => void;
  private readonly win: WindowConfig;
  private queue: AudioChunk[] = [];
  private running: Promise<void> | null = null;
  private failures = 0;
  private status: RecitationStatus = 'idle';
  private error: RecitationState['error'] = null;
  private silent = true;
  // sliding window
  private winPcm: Float32Array = new Float32Array(0);
  private winStartMs = 0;
  private commitMs = 0;
  private lastCommitted: HypWord | null = null;
  /** Committed (timed) words still inside the window, used to cut the context at word gaps. */
  private context: HypWord[] = [];
  /** Uncommitted words of the previous recognition (for local agreement). */
  private prevFresh: HypWord[] = [];
  private timedEngine = false;
  private paused = false;
  private heard = '';
  private latencyMs: number | null = null;
  /** Last committed words (kept across utterances) to recognise the same audio reported twice. */
  private tail: HypWord[] = [];
  private utteranceSilenceMs = 0;
  private utteranceOpen = false;
  /** Recent speech audio (session time) for second looks at suspected mistakes. */
  private recentAudio: AudioChunk[] = [];

  constructor(deps: { engine: AsrEngine; tracker: RecitationTracker; onUpdate: (s: RecitationState) => void; chunker?: Partial<ChunkerConfig>; window?: Partial<WindowConfig> }) {
    this.engine = deps.engine;
    this.tracker = deps.tracker;
    this.tracker.verifier = true;
    this.onUpdate = deps.onUpdate;
    this.chunker = new Chunker({ maxChunkMs: 2000, ...deps.chunker });
    this.win = { ...DEFAULT_WINDOW, ...deps.window };
  }

  state(): RecitationState {
    return { status: this.status, error: this.error, silent: this.silent, backlog: this.queue.length, paused: this.paused, heard: this.heard, latencyMs: this.latencyMs, tracker: this.tracker.snapshot() };
  }

  /** Pauses listening; buffered speech is closed as an utterance so nothing is half-recognised. */
  pause(): void {
    if (this.status !== 'listening' || this.paused) return;
    this.paused = true;
    const rest = this.chunker.flush();
    if (rest.length) this.enqueue(rest, true);
    this.emit();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.emit();
  }

  async start(): Promise<boolean> {
    this.set('loading');
    try {
      await this.engine.load();
    } catch (e) {
      this.fail('model', e);
      return false;
    }
    this.set('listening');
    return true;
  }

  /** Feeds 16 kHz mono samples. */
  feed(pcm16k: Float32Array): void {
    if (this.status !== 'listening' || this.paused) return;
    const chunks = this.chunker.push(pcm16k);
    const wasSilent = this.silent;
    this.silent = chunks.length === 0 && this.silent;
    if (chunks.length) this.enqueue(chunks);
    else if (wasSilent !== this.silent) this.emit();
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
    const rest = this.chunker.flush();
    if (rest.length) this.enqueue(rest, true);
    else if (this.utteranceOpen) this.enqueue([{ pcm: new Float32Array(0), startMs: this.winStartMs + (this.winPcm.length * 1000) / MODEL_RATE, endMs: this.winStartMs + (this.winPcm.length * 1000) / MODEL_RATE, silenceBeforeMs: 0, final: true }], true);
    await this.idle();
    await this.verifySuspects(Infinity).catch(() => {});
    this.tracker.finish();
    if ((this.status as RecitationStatus) === 'stopping') this.set('stopped');
    else this.emit();
  }

  /**
   * Re-recognises ~8 s of speech around each suspected mistake (5 s before, 3 s after) and lets
   * the tracker compare again. Runs once per suspect, as soon as the audio after it is available.
   */
  private async verifySuspects(availableMs: number): Promise<void> {
    for (const sp of this.tracker.suspects()) {
      if (sp.atMs + 3000 > availableMs) continue;
      const pcm = this.extract(sp.atMs - 5000, sp.atMs + 3000);
      if (!pcm.length) {
        this.tracker.verify(sp.flat, []);
        continue;
      }
      const r = await this.engine.transcribe(pcm);
      this.tracker.verify(sp.flat, toHypWords({ text: r.text }, 0));
    }
  }

  private extract(fromMs: number, toMs: number): Float32Array {
    const parts: Float32Array[] = [];
    for (const c of this.recentAudio) {
      if (c.endMs <= fromMs || c.startMs >= toMs) continue;
      const a = Math.max(0, msToSamples(fromMs - c.startMs));
      const b = Math.min(c.pcm.length, msToSamples(toMs - c.startMs));
      if (b > a) parts.push(c.pcm.subarray(a, b));
    }
    return parts.reduce((acc, p) => concat(acc, p), new Float32Array(0));
  }

  /** Resolves when every queued chunk has been recognised (used by tests and offline checks). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private enqueue(chunks: AudioChunk[], force = false): void {
    if (!chunks.length) return;
    this.silent = false;
    this.queue.push(...chunks);
    if (!this.running && (this.status === 'listening' || force)) this.running = this.drain();
    this.emit();
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      // Fold every queued step of the same utterance into the window (catch up after a backlog).
      let final = false;
      do {
        const c = this.queue.shift() as AudioChunk;
        this.append(c);
        final = c.final;
      } while (!final && this.queue.length);
      try {
        await this.recognise(final);
        await this.verifySuspects(this.recentAudio[this.recentAudio.length - 1]?.endMs ?? 0);
        this.failures = 0;
      } catch (e) {
        this.failures++;
        if (final) this.resetWindow();
        if (this.failures >= 3) {
          this.queue = [];
          this.running = null;
          this.tracker.finish();
          this.fail('engine', e);
          return;
        }
      }
      this.emit();
    }
    this.running = null;
  }

  private append(c: AudioChunk): void {
    if (c.pcm.length) {
      this.recentAudio.push(c);
      while (this.recentAudio.length && (this.recentAudio[0]?.endMs as number) < c.endMs - 60000) this.recentAudio.shift();
    }
    if (!this.utteranceOpen) {
      this.winPcm = c.pcm;
      this.winStartMs = c.startMs;
      this.commitMs = c.startMs;
      this.utteranceSilenceMs = c.silenceBeforeMs;
      this.lastCommitted = null;
      this.context = [];
      this.prevFresh = [];
      this.utteranceOpen = true;
    } else {
      this.winPcm = concat(this.winPcm, c.pcm);
    }
  }

  private resetWindow(): void {
    this.utteranceOpen = false;
    this.winPcm = new Float32Array(0);
  }

  private async recognise(final: boolean): Promise<void> {
    const endMs = this.winStartMs + (this.winPcm.length * 1000) / MODEL_RATE;
    if (!this.winPcm.length) {
      if (final) this.resetWindow();
      return;
    }
    const t0 = Date.now();
    const r = await this.engine.transcribe(this.winPcm);
    this.latencyMs = Date.now() - t0;
    if (r.text.trim()) this.heard = r.text.trim();
    const words = toHypWords(r, this.winStartMs);
    // An empty pass from an engine that gives timestamps must not discard the window (measured:
    // the model occasionally returns nothing for a window it recognised one step earlier).
    if (words.length > 0 && words.every((w) => w.startMs !== undefined)) this.timedEngine = true;
    const timed = words.length > 0 ? words.every((w) => w.startMs !== undefined && w.endMs !== undefined) : this.timedEngine;
    let commit: HypWord[];
    if (!timed) {
      commit = words; // no timestamps: this audio is recognised once, never again
      this.winStartMs = endMs;
      this.winPcm = new Float32Array(0);
      this.commitMs = endMs;
    } else {
      const fresh = words.filter((w) => ((w.startMs as number) + (w.endMs as number)) / 2 > this.commitMs);
      // A short word right at the commit point may be reported again with shifted timestamps.
      const lc = this.lastCommitted;
      if (lc && fresh[0] && fresh[0].norm === lc.norm && (fresh[0].startMs as number) < (lc.endMs as number) + 200) fresh.shift();
      const forceAll = final || endMs - this.winStartMs >= this.win.maxWindowMs;
      // Local agreement: commit only what two consecutive recognitions of the growing window agree on (measured: single passes flicker near the live edge and can produce
      // fragments such as «ي» of يَنقَلِبۡ or a hallucinated word with wrong timestamps).
      let n = 0;
      if (forceAll) {
        // Measured: a pass occasionally returns nothing (or far less) for audio the previous pass
        // recognised well; then the previous pass's words are used instead of being lost.
        const prev = this.prevFresh.filter((w) => ((w.startMs as number) + (w.endMs as number)) / 2 > this.commitMs);
        if (fresh.length < prev.length * 0.5) fresh.splice(0, fresh.length, ...prev);
        n = fresh.length;
      } else {
        // A word is stable when the previous pass had the same word at about the same time. Commit
        // up to the last stable word; a flickering word between stable ones (e.g. «من» merged by
        // idgham into لَّدُنكَ) must not block everything after it.
        const stable = (w: HypWord) => (w.norm.length > 1) && this.prevFresh.some((q) => q.norm === w.norm && Math.abs((q.startMs as number) - (w.startMs as number)) <= 320);
        for (let i = fresh.length - 1; i >= 0; i--) {
          if (stable(fresh[i] as HypWord)) {
            n = i + 1;
            break;
          }
        }
      }
      // Timestamps of the same audio shift between passes; a word already committed at about the
      // same time is the same word again, not a repetition (measured on a real recording).
      const seen = (w: HypWord) => this.tail.some((q) => q.norm === w.norm && Math.abs((q.startMs as number) - (w.startMs as number)) < 1200);
      commit = fresh.slice(0, n).filter((w) => !seen(w));
      this.prevFresh = fresh.slice(n);
      const last = fresh[n - 1];
      if (last) {
        this.commitMs = Math.max(this.commitMs, last.endMs as number);
        this.lastCommitted = last;
      }
      this.tail = [...this.tail, ...commit].slice(-12);
      // Trim the window to left context + uncommitted audio, cutting only in a gap between words
      // (measured: a window starting inside a word makes the model drop or garble words).
      this.context.push(...commit);
      const nextStart = fresh[commit.length]?.startMs;
      let keepFrom = this.winStartMs;
      const k = this.context.findIndex((w) => (w.startMs as number) >= this.commitMs - this.win.leftContextMs);
      if (k > 0) {
        const prev = this.context[k - 1] as HypWord;
        keepFrom = ((prev.endMs as number) + (this.context[k]?.startMs as number)) / 2;
        this.context = this.context.slice(k);
      } else if (k < 0 && this.context.length) {
        const prev = this.context[this.context.length - 1] as HypWord;
        keepFrom = nextStart !== undefined ? ((prev.endMs as number) + nextStart) / 2 : (prev.endMs as number);
        this.context = [];
      }
      const drop = msToSamples(keepFrom - this.winStartMs);
      if (drop > 0) {
        this.winPcm = this.winPcm.slice(drop);
        this.winStartMs += (drop * 1000) / MODEL_RATE;
      }
    }
    if (commit.length || final) {
      const startMs = commit[0]?.startMs ?? this.commitMs;
      this.tracker.push({ words: commit, startMs, endMs: Math.max(endMs, startMs), silenceBeforeMs: this.utteranceSilenceMs });
      if (commit.length) this.utteranceSilenceMs = 0;
    }
    if (final) this.resetWindow();
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
