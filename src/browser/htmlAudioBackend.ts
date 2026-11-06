import type { AudioBackend } from '../core/audio/playbackController.ts';
import { encodeWav } from './cueSynth.ts';

const SILENCE_RATE = 8000;

/**
 * Near-silent WAV of `ms`: ±1 LSB of 16-bit noise (about -90 dBFS, inaudible), not digital zero,
 * so Bluetooth headsets and power-saving audio paths do not treat it as "stopped".
 */
function silentWav(ms: number): Uint8Array<ArrayBuffer> {
  const n = Math.max(1, Math.round((ms / 1000) * SILENCE_RATE));
  const samples = new Float32Array(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    samples[i] = ((x >>> 31) * 2 - 1) / 0x7fff;
  }
  return encodeWav(samples, SILENCE_RATE);
}

const MEDIA_ERRORS: Record<number, string> = {
  1: 'loading was aborted',
  2: 'a network error occurred (check your connection)',
  3: 'the audio file could not be decoded',
  4: 'the audio file was not found or its format is not supported',
};

/**
 * AudioBackend over a single HTMLAudioElement. Pauses between ayat are played as silence on the
 * same element, so playback continues with the screen off / app in the background.
 */
export class HtmlAudioBackend implements AudioBackend {
  readonly audio: HTMLAudioElement;
  private ended: () => void = () => {};
  private errored: (e: Error) => void = () => {};
  private loading = false;
  private readonly timeoutMs: number;
  /** Resolves the silence that is playing now (null when none). */
  private silenceDone: (() => void) | null = null;
  private readonly silenceUrls = new Map<number, string>();
  /** Bumped by load/pause/stop/play so a stalled-start recovery never acts on a newer command. */
  private playToken = 0;
  private readonly playStartMs: number;

  constructor(timeoutMs = 20_000, playStartMs = 8000) {
    this.timeoutMs = timeoutMs;
    this.playStartMs = playStartMs;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.addEventListener('ended', () => {
      if (this.silenceDone) this.silenceDone();
      else this.ended();
    });
    this.audio.addEventListener('error', () => {
      if (!this.loading && !this.silenceDone) this.errored(new Error(this.describeError()));
    });
  }

  private describeError(): string {
    const code = this.audio.error?.code ?? 0;
    return MEDIA_ERRORS[code] ?? 'unknown audio error';
  }

  private endSilence() {
    this.silenceDone?.();
  }

  private silenceUrl(ms: number): string {
    const key = Math.max(50, Math.round(ms / 50) * 50);
    let u = this.silenceUrls.get(key);
    if (!u) {
      u = URL.createObjectURL(new Blob([silentWav(key)], { type: 'audio/wav' }));
      this.silenceUrls.set(key, u);
    }
    return u;
  }

  silence(ms: number): Promise<void> {
    this.endSilence();
    this.playToken++;
    const audio = this.audio;
    return new Promise<void>((resolve, reject) => {
      const finish = (err?: Error) => {
        if (this.silenceDone !== done) return;
        this.silenceDone = null;
        audio.removeEventListener('error', bad);
        if (err) reject(err);
        else resolve();
      };
      const done = () => finish();
      const bad = () => finish(new Error(this.describeError()));
      this.silenceDone = done;
      audio.addEventListener('error', bad);
      audio.src = this.silenceUrl(ms);
      audio.playbackRate = 1;
      audio.play().catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))));
    });
  }

  private pageHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  load(url: string): Promise<void> {
    this.endSilence();
    this.playToken++;
    // Same file again (repetition with no pause): rewinding is instant — but only while the page
    // is visible. With the screen off, Android Chrome can leave play() on a rewound, ended element
    // pending forever, so the file is loaded afresh instead (from the HTTP cache / offline blob).
    if (this.audio.src === url && this.audio.readyState >= 2 && !this.pageHidden()) {
      this.audio.currentTime = 0;
      return Promise.resolve();
    }
    return this.reload(url);
  }

  private reload(url: string): Promise<void> {
    this.loading = true;
    return new Promise((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        this.audio.removeEventListener('canplay', ok);
        this.audio.removeEventListener('error', bad);
        this.loading = false;
        if (err) reject(err);
        else resolve();
      };
      const ok = () => done();
      const bad = () => done(new Error(this.describeError()));
      const timer = setTimeout(() => done(new Error('loading timed out (slow or no connection)')), this.timeoutMs);
      this.audio.addEventListener('canplay', ok);
      this.audio.addEventListener('error', bad);
      this.audio.src = url;
      this.audio.load();
    });
  }

  /**
   * Starts playback. If play() has not started within playStartMs (seen on Android with the screen
   * off: the promise stays pending, no sound, no error), the same file is reloaded at the same
   * position and played once more; if that also hangs, it rejects so the player shows an error
   * with Retry instead of hanging silently in "playing".
   */
  async play() {
    const token = ++this.playToken;
    if (await this.startWithin(token)) return;
    if (token !== this.playToken) return;
    const src = this.audio.src;
    const at = this.audio.currentTime;
    const rate = this.audio.playbackRate;
    await this.reload(src);
    if (token !== this.playToken) return; // paused / stopped / moved on while reloading
    try {
      if (at > 0.3 && at < (this.audio.duration || Infinity)) this.audio.currentTime = at;
    } catch {
      /* seek not possible: restart the file */
    }
    this.setRate(rate);
    if (await this.startWithin(token)) return;
    if (token !== this.playToken) return;
    throw new Error('playback did not start (the phone may have paused the audio in the background)');
  }

  /** True once play() resolved; false if it was still pending after playStartMs. Rethrows play() errors. */
  private startWithin(token: number): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, this.playStartMs);
      this.audio.play().then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(true);
        },
        (e: unknown) => {
          if (settled) return; // a late rejection after we gave up (e.g. aborted by the reload)
          settled = true;
          clearTimeout(timer);
          // Superseded by pause/stop/another load: not an error for this attempt.
          if (token !== this.playToken) resolve(true);
          else reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  pause() {
    this.playToken++;
    this.audio.pause();
  }
  stop() {
    this.playToken++;
    this.endSilence();
    this.audio.pause();
    try {
      this.audio.currentTime = 0;
    } catch {
      /* not loaded */
    }
  }
  setRate(rate: number) {
    this.audio.playbackRate = rate;
    // Keep recitation pitch natural when slowing down or speeding up.
    (this.audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
  }
  onEnded(cb: () => void) {
    this.ended = cb;
  }
  onError(cb: (e: Error) => void) {
    this.errored = cb;
  }
}
