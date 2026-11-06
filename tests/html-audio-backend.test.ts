import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

/** Minimal stand-in for HTMLAudioElement: each play() follows the next scripted behaviour. */
class FakeAudioElement extends EventTarget {
  src = '';
  readyState = 0;
  currentTime = 0;
  duration = 10;
  playbackRate = 1;
  preload = '';
  error: { code: number } | null = null;
  loads = 0;
  playCalls = 0;
  /** 'ok' resolves, 'hang' never settles (until a reload aborts it). */
  script: Array<'ok' | 'hang'> = [];
  private abortPending: ((e: Error) => void) | null = null;
  load() {
    this.loads++;
    this.abortPending?.(new Error('AbortError: interrupted by a new load request'));
    this.abortPending = null;
    this.readyState = 0;
    this.playbackRate = 1; // like the spec: load() resets to defaultPlaybackRate
    setImmediate(() => {
      this.readyState = 4;
      this.dispatchEvent(new Event('canplay'));
    });
  }
  play(): Promise<void> {
    this.playCalls++;
    const b = this.script.shift() ?? 'ok';
    if (b === 'ok') return Promise.resolve();
    return new Promise((_, reject) => {
      this.abortPending = reject;
    });
  }
  pause() {}
}

let el: FakeAudioElement;
const g = globalThis as unknown as { Audio?: unknown; document?: unknown };

beforeEach(() => {
  g.Audio = class {
    constructor() {
      el = new FakeAudioElement();
      return el;
    }
  };
});
afterEach(() => {
  delete g.Audio;
  delete g.document;
});

async function backend() {
  const { HtmlAudioBackend } = await import('../src/browser/htmlAudioBackend.ts');
  return new HtmlAudioBackend(1000, 20);
}

describe('HtmlAudioBackend with the screen off (Android stall)', () => {
  it('a repeated file is rewound while visible but loaded afresh while the page is hidden', async () => {
    const b = await backend();
    await b.load('https://a.test/002057.mp3');
    assert.equal(el.loads, 1);
    await b.load('https://a.test/002057.mp3');
    assert.equal(el.loads, 1, 'visible: instant rewind, no reload');
    g.document = { visibilityState: 'hidden' };
    await b.load('https://a.test/002057.mp3');
    assert.equal(el.loads, 2, 'hidden: fresh load');
  });

  it('when play() hangs, reloads the same file at the same position and rate and plays again', async () => {
    const b = await backend();
    el.src = 'https://a.test/002057.mp3';
    await b.load(el.src).catch(() => {});
    b.setRate(1.25);
    el.currentTime = 3;
    el.script = ['hang', 'ok'];
    await b.play();
    assert.equal(el.playCalls, 2);
    assert.equal(el.loads, 2);
    assert.equal(el.currentTime, 3);
    assert.equal(el.playbackRate, 1.25);
  });

  it('if it hangs again, rejects (player shows an error with Retry) instead of hanging forever', async () => {
    const b = await backend();
    el.src = 'https://a.test/002057.mp3';
    el.script = ['hang', 'hang'];
    await assert.rejects(b.play(), /did not start/);
  });

  it('pausing while a start is pending cancels the recovery quietly', async () => {
    const b = await backend();
    el.src = 'https://a.test/002057.mp3';
    el.script = ['hang'];
    const p = b.play();
    b.pause();
    await p;
    assert.equal(el.loads, 0);
  });
});
