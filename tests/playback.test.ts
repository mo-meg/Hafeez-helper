import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AudioUnavailableError, PlaybackController, type AudioBackend, type TimerApi } from '../src/core/audio/playbackController.ts';
import { BUILTIN_RECITERS, resolveAudioUrl, TemplateError, validateTemplate } from '../src/core/audio/reciters.ts';
import type { RepeatConfig } from '../src/core/model.ts';
import { buildMistakePlaylist } from '../src/core/playlist/playlist.ts';
import { expandSequence, type PlaybackStep } from '../src/core/playlist/sequence.ts';
import { setup } from './helpers.ts';

/** Mock audio backend: records loads/plays; the test triggers "ended". */
class FakeBackend implements AudioBackend {
  loads: string[] = [];
  plays = 0;
  failUrls = new Set<string>();
  rate = 1;
  private ended: () => void = () => {};
  private errored: (e: Error) => void = () => {};
  async load(url: string) {
    this.loads.push(url);
    if (this.failUrls.has(url)) throw new Error('HTTP 404');
  }
  async play() {
    this.plays++;
  }
  pause() {}
  stop() {}
  setRate(r: number) {
    this.rate = r;
  }
  onEnded(cb: () => void) {
    this.ended = cb;
  }
  onError(cb: (e: Error) => void) {
    this.errored = cb;
  }
  end() {
    this.ended();
  }
  error(msg: string) {
    this.errored(new Error(msg));
  }
}

class FakeTimers implements TimerApi {
  pending: Array<{ fn: () => void; ms: number; id: number }> = [];
  private n = 0;
  set(fn: () => void, ms: number) {
    const id = ++this.n;
    this.pending.push({ fn, ms, id });
    return id;
  }
  clear(h: unknown) {
    this.pending = this.pending.filter((p) => p.id !== h);
  }
  flush() {
    const p = this.pending.shift();
    p?.fn();
    return p?.ms;
  }
}

const tick = () => new Promise((r) => setImmediate(r));
const cfg = (o: Partial<RepeatConfig> = {}): RepeatConfig => ({ ayahRepeat: 3, groupRepeat: 1, playlistRepeat: 1, repeatContext: false, pauseBetweenRepetitionsMs: 1000, pauseBetweenAyatMs: 2000, playbackRate: 1, ...o });
const TEMPLATE = 'https://audio.test/{surah3}{ayah3}.mp3';

async function steps(c: RepeatConfig, context = 0): Promise<PlaybackStep[]> {
  const { mistakes } = setup();
  await mistakes.markAyah({ surah: 2, ayah: 260 }, { category: 'other' });
  await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other' });
  return expandSequence(buildMistakePlaylist(await mistakes.list(), [{ start: 1, end: 6236 }], { contextBefore: context }), c);
}

function make(s: PlaybackStep[]) {
  const backend = new FakeBackend();
  const timers = new FakeTimers();
  const player = new PlaybackController({ backend, timers, resolveUrl: async (st) => resolveAudioUrl(TEMPLATE, st.item.ref) });
  player.setSteps(s);
  return { backend, timers, player };
}

/** Plays through, ending each audio and flushing each pause. */
async function runToEnd(backend: FakeBackend, timers: FakeTimers, player: PlaybackController) {
  for (let guard = 0; guard < 1000 && player.state.status !== 'finished'; guard++) {
    await tick();
    if (player.state.status === 'playing') backend.end();
    else if (player.state.status === 'gap') timers.flush();
    else if (player.state.status === 'awaiting_assessment') await player.continueAfterAssessment();
  }
}

describe('playback controller', () => {
  it('plays each ayah exactly the configured number of times, in Quran order', async () => {
    const s = await steps(cfg({ ayahRepeat: 5 }));
    const { backend, timers, player } = make(s);
    const completed: string[] = [];
    player.onStepCompleted((st) => completed.push(`${st.item.ref.surah}:${st.item.ref.ayah}`));
    await player.start();
    await runToEnd(backend, timers, player);
    assert.equal(player.state.status, 'finished');
    assert.deepEqual(completed, ['2:255', '2:255', '2:255', '2:255', '2:255', '2:260', '2:260', '2:260', '2:260', '2:260']);
    assert.equal(backend.loads.filter((u) => u.endsWith('002255.mp3')).length, 5);
    assert.equal(player.state.completedSteps, 10);
  });

  it('waits the configured pause between repetitions and between ayat', async () => {
    const { backend, timers, player } = make(await steps(cfg({ ayahRepeat: 2 })));
    await player.start();
    await tick();
    backend.end();
    assert.equal(player.state.status, 'gap');
    assert.equal(timers.pending[0]?.ms, 1000);
    timers.flush();
    await tick();
    backend.end();
    assert.equal(timers.pending[0]?.ms, 2000);
  });

  it('shows the current repetition (e.g. 3/5) and reference', async () => {
    const { backend, timers, player } = make(await steps(cfg({ ayahRepeat: 5 })));
    await player.start();
    for (let i = 0; i < 2; i++) {
      await tick();
      backend.end();
      timers.flush();
    }
    await tick();
    const cur = player.state.current;
    assert.equal(`${cur?.repetition}/${cur?.repetitions}`, '3/5');
    assert.deepEqual(cur?.item.ref, { surah: 2, ayah: 255 });
  });

  it('stops in an explicit error state when audio is missing — never skips silently', async () => {
    const { backend, player } = make(await steps(cfg({ ayahRepeat: 1 })));
    backend.failUrls.add('https://audio.test/002255.mp3');
    await player.start();
    await tick();
    assert.equal(player.state.status, 'error');
    assert.match(player.state.error?.message ?? '', /Al-Baqarah 2:255.*HTTP 404/);
    // Retry still fails; explicit skip moves on and is recorded.
    await player.retry();
    assert.equal(player.state.status, 'error');
    await player.skipFailed();
    await tick();
    assert.equal(player.state.status, 'playing');
    assert.deepEqual(player.state.current?.item.ref, { surah: 2, ayah: 260 });
    assert.deepEqual(player.state.skippedAyat, [262]);
  });

  it('surfaces URL resolution failures (e.g. not downloaded for offline use)', async () => {
    const backend = new FakeBackend();
    const player = new PlaybackController({ backend, timers: new FakeTimers(), resolveUrl: async () => { throw new AudioUnavailableError('offline and not downloaded'); } });
    player.setSteps(await steps(cfg()));
    await player.start();
    assert.equal(player.state.status, 'error');
    assert.match(player.state.error?.message ?? '', /offline and not downloaded/);
  });

  it('handles errors raised during playback (network interruption)', async () => {
    const { backend, player } = make(await steps(cfg()));
    await player.start();
    await tick();
    backend.error('network interrupted');
    assert.equal(player.state.status, 'error');
    await player.retry();
    await tick();
    assert.equal(player.state.status, 'playing');
  });

  it('supports next, previous, restart ayah, next mistake, restart playlist and stop', async () => {
    const { backend, timers, player } = make(await steps(cfg({ ayahRepeat: 3 }), 1));
    // Items: 2:254*, 2:255, ... 2:259*, 2:260 (context marked *)
    await player.start();
    await tick();
    assert.deepEqual(player.state.current?.item.ref, { surah: 2, ayah: 254 });
    await player.nextMistake();
    assert.deepEqual(player.state.current?.item.ref, { surah: 2, ayah: 255 });
    backend.end();
    timers.flush();
    await tick();
    assert.equal(player.state.current?.repetition, 2);
    await player.restartAyah();
    assert.equal(player.state.current?.repetition, 1);
    await player.next();
    assert.deepEqual(player.state.current?.item.ref, { surah: 2, ayah: 259 });
    await player.prev();
    assert.deepEqual(player.state.current?.item.ref, { surah: 2, ayah: 255 });
    await player.restartPlaylist();
    assert.equal(player.state.index, 0);
    player.stop();
    assert.equal(player.state.status, 'idle');
  });

  it('pauses and resumes during audio and during a gap', async () => {
    const { backend, timers, player } = make(await steps(cfg({ ayahRepeat: 2 })));
    await player.start();
    await tick();
    player.pause();
    assert.equal(player.state.status, 'paused');
    await player.play();
    assert.equal(player.state.status, 'playing');
    backend.end();
    assert.equal(player.state.status, 'gap');
    player.pause();
    assert.equal(timers.pending.length, 0, 'pause cancels the gap timer');
    await player.play();
    await tick();
    assert.equal(player.state.current?.repetition, 2);
  });

  it('can pause after each marked ayah for a recall assessment', async () => {
    const { backend, player } = make(await steps(cfg({ ayahRepeat: 1 })));
    player.setPauseForAssessment(true);
    await player.start();
    await tick();
    backend.end();
    assert.equal(player.state.status, 'awaiting_assessment');
    await player.continueAfterAssessment();
    await tick();
    assert.deepEqual(player.state.current?.item.ref, { surah: 2, ayah: 260 });
  });

  it('ignores a stale load when the user navigates quickly', async () => {
    let release: () => void = () => {};
    const backend = new FakeBackend();
    const player = new PlaybackController({
      backend,
      timers: new FakeTimers(),
      resolveUrl: (st) => (st.stepIndex === 0 ? new Promise((r) => { release = () => r('https://slow/1.mp3'); }) : Promise.resolve(resolveAudioUrl(TEMPLATE, st.item.ref))),
    });
    player.setSteps(await steps(cfg({ ayahRepeat: 1 })));
    void player.start();
    await player.next();
    release();
    await tick();
    assert.ok(!backend.loads.includes('https://slow/1.mp3'));
    assert.deepEqual(player.state.current?.item.ref, { surah: 2, ayah: 260 });
  });

  it('applies the playback rate', async () => {
    const { backend, player } = make(await steps(cfg()));
    player.setRate(0.75);
    await player.start();
    assert.equal(backend.rate, 0.75);
  });
});

describe('reciter URL templates', () => {
  it('resolves zero-padded and global placeholders', () => {
    assert.equal(resolveAudioUrl('https://everyayah.com/data/Husary_128kbps/{surah3}{ayah3}.mp3', { surah: 2, ayah: 5 }), 'https://everyayah.com/data/Husary_128kbps/002005.mp3');
    assert.equal(resolveAudioUrl('https://cdn.example/{global}.mp3', { surah: 2, ayah: 255 }), 'https://cdn.example/262.mp3');
  });
  it('validates custom templates', () => {
    assert.throws(() => validateTemplate('not a url'), TemplateError);
    assert.throws(() => validateTemplate('https://x.test/{surah}.mp3'), /identify the ayah/);
    assert.throws(() => validateTemplate('ftp://x.test/{global}.mp3'), TemplateError);
    assert.doesNotThrow(() => validateTemplate('https://x.test/{surah}/{ayah}.mp3'));
  });
  it('every built-in reciter has a valid template and attribution', () => {
    for (const r of BUILTIN_RECITERS) {
      assert.doesNotThrow(() => validateTemplate(r.urlTemplate), r.id);
      assert.ok(r.attribution.length > 20);
    }
    assert.equal(BUILTIN_RECITERS.filter((r) => r.name.includes('Husary')).length >= 1, true);
  });
});
