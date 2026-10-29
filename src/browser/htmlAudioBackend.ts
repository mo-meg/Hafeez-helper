import type { AudioBackend } from '../core/audio/playbackController.ts';

const MEDIA_ERRORS: Record<number, string> = {
  1: 'loading was aborted',
  2: 'a network error occurred (check your connection)',
  3: 'the audio file could not be decoded',
  4: 'the audio file was not found or its format is not supported',
};

/** AudioBackend over a single HTMLAudioElement. */
export class HtmlAudioBackend implements AudioBackend {
  readonly audio: HTMLAudioElement;
  private ended: () => void = () => {};
  private errored: (e: Error) => void = () => {};
  private loading = false;
  private readonly timeoutMs: number;

  constructor(timeoutMs = 20_000) {
    this.timeoutMs = timeoutMs;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.addEventListener('ended', () => this.ended());
    this.audio.addEventListener('error', () => {
      if (!this.loading) this.errored(new Error(this.describeError()));
    });
  }

  private describeError(): string {
    const code = this.audio.error?.code ?? 0;
    return MEDIA_ERRORS[code] ?? 'unknown audio error';
  }

  load(url: string): Promise<void> {
    if (this.audio.src === url && this.audio.readyState >= 2) {
      this.audio.currentTime = 0;
      return Promise.resolve();
    }
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

  async play() {
    await this.audio.play();
  }
  pause() {
    this.audio.pause();
  }
  stop() {
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
