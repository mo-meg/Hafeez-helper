import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AudioUnavailableError, CUE_TIMING, PlaybackController, type AudioBackend, type CuePlayer, type TimerApi } from '../src/core/audio/playbackController.ts';
import { BUILTIN_RECITERS, resolveAudioUrl, TemplateError, validateTemplate } from '../src/core/audio/reciters.ts';
import type { RepeatConfig } from '../src/core/model.ts';
import { buildMistakePlaylist } from '../src/core/playlist/playlist.ts';
import { expandSequence, type CueKind, type CueOptions, type PlaybackStep } from '../src/core/playlist/sequence.ts';
import { setup } from './helpers.ts';

/** Mock audio backend: records loads/plays; the test triggers "ended". */
class FakeBackend implements AudioBackend {
  loads: string[] = [];
  plays = 0;
  failUrls = new Set<string>();
  /** URLs whose load never settles (stalled network). */
  hangUrls = new Set<string>();
  rate = 1;
  private ended: () => void = () => {};
  private errored: (e: Error) => void = () => {};
  async load(url: string) {
    this.loads.push(url);
    if (this.hangUrls.has(url)) await new Promise(() => {});
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

async function steps(c: RepeatConfig, context = 0, cues?: CueOptions): Promise<PlaybackStep[]> {
  const { mistakes } = setup();
  await mistakes.markAyah({ surah: 2, ayah: 260 }, { category: 'other' });
  await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other' });
  return expandSequence(buildMistakePlaylist(await mistakes.list(), [{ start: 1, end: 6236 }], { contextBefore: context }), c, 'mistakes', cues);
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

/** Backend that plays pauses as silence (like the browser one); the test ends each silence. */
class SilenceBackend extends FakeBackend {
  silences: number[] = [];
  private finishSilence: (() => void) | null = null;
  silence(ms: number) {
    this.silences.push(ms);
    return new Promise<void>((resolve) => {
      this.finishSilence = resolve;
    });
  }
  override stop() {
    this.endSilence();
  }
  override async load(url: string) {
    this.endSilence();
    return super.load(url);
  }
  endSilence() {
    const f = this.finishSilence;
    this.finishSilence = null;
    f?.();
  }
}

describe('playback with the screen off (pauses played as silence)', () => {
  it('plays each pause as silence through the backend instead of a timer, then continues', async () => {
    const backend = new SilenceBackend();
    const timers = new FakeTimers();
    const player = new PlaybackController({ backend, timers, resolveUrl: async (st) => resolveAudioUrl(TEMPLATE, st.item.ref) });
    player.setSteps(await steps(cfg({ ayahRepeat: 2 })));
    await player.start();
    await tick();
    backend.end();
    assert.equal(player.state.status, 'gap');
    assert.deepEqual(backend.silences, [1000]);
    // Only the safety guard is pending — progress does not depend on a timer firing.
    assert.equal(timers.pending.length, 1);
    assert.equal(timers.pending[0]?.ms, 5000);
    backend.endSilence();
    await tick();
    await tick();
    assert.equal(player.state.status, 'playing');
    assert.equal(player.state.current?.repetition, 2);
    assert.equal(timers.pending.length, 0);
    backend.end();
    assert.deepEqual(backend.silences, [1000, 2000]);
  });

  it('pausing during a silent pause stops it; resuming moves on to the next step', async () => {
    const backend = new SilenceBackend();
    const timers = new FakeTimers();
    const player = new PlaybackController({ backend, timers, resolveUrl: async (st) => resolveAudioUrl(TEMPLATE, st.item.ref) });
    player.setSteps(await steps(cfg({ ayahRepeat: 2 })));
    await player.start();
    await tick();
    backend.end();
    player.pause();
    await tick();
    assert.equal(player.state.status, 'paused');
    assert.equal(player.state.current?.repetition, 1);
    await player.play();
    await tick();
    assert.equal(player.state.status, 'playing');
    assert.equal(player.state.current?.repetition, 2);
  });

  it('a silence whose end never arrives is ended by the guard timer', async () => {
    const backend = new SilenceBackend();
    const timers = new FakeTimers();
    const player = new PlaybackController({ backend, timers, resolveUrl: async (st) => resolveAudioUrl(TEMPLATE, st.item.ref) });
    player.setSteps(await steps(cfg({ ayahRepeat: 2 })));
    await player.start();
    await tick();
    backend.end();
    timers.flush();
    await tick();
    await tick();
    assert.equal(player.state.status, 'playing');
    assert.equal(player.state.current?.repetition, 2);
  });
});

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

class FakeCues implements CuePlayer {
  map: Record<CueKind, string[]> = {
    group: ['cue://istiadha-reciter', 'cue://istiadha-general', 'cue://knock'],
    mistake: ['cue://clap'],
  };
  sources(k: CueKind) {
    return Promise.resolve(this.map[k]);
  }
}

function makeWithCues(s: PlaybackStep[]) {
  const backend = new FakeBackend();
  const timers = new FakeTimers();
  const cues = new FakeCues();
  const player = new PlaybackController({ backend, timers, cues, resolveUrl: async (st) => resolveAudioUrl(TEMPLATE, st.item.ref) });
  player.setSteps(s);
  return { backend, timers, cues, player };
}

const ayah = (n: number) => `https://audio.test/002${String(n).padStart(3, '0')}.mp3`;

describe('playback controller — orientation cues', () => {
  const both = { group: true, mistake: true };

  it('plays each cue through the recitation player, waits for its real end, then the ayah', async () => {
    const { backend, timers, player } = makeWithCues(await steps(cfg({ ayahRepeat: 1 }), 1, both));
    void player.start();
    assert.equal(player.state.status, 'cue');
    // Group cue (before the preceding ayah 2:254): lead silence → Isti'adha → its end → tail silence.
    assert.equal(timers.flush(), CUE_TIMING.group.leadMs);
    await tick();
    assert.deepEqual(backend.loads, ['cue://istiadha-reciter']);
    assert.equal(backend.rate, 1, 'cues play at normal speed');
    assert.equal(player.state.status, 'cue', 'still in the cue while it sounds');
    backend.end();
    await tick();
    assert.equal(timers.pending.length, 1);
    assert.equal(timers.flush(), CUE_TIMING.group.tailMs);
    await tick();
    assert.equal(player.state.status, 'playing');
    assert.deepEqual(backend.loads.slice(1), [ayah(254)]);
    // Preceding ayah ends → normal pause → mistake cue → marked ayah.
    backend.end();
    assert.equal(timers.flush(), 2000);
    await tick();
    assert.equal(player.state.status, 'cue');
    assert.equal(timers.flush(), CUE_TIMING.mistake.leadMs);
    await tick();
    assert.equal(backend.loads.at(-1), 'cue://clap');
    backend.end();
    await tick();
    assert.equal(timers.flush(), CUE_TIMING.mistake.tailMs);
    await tick();
    assert.equal(player.state.status, 'playing');
    assert.equal(backend.loads.at(-1), ayah(255));
  });

  it("falls back: reciter's Isti'adha missing → general file; stalled load → next after the timeout", async () => {
    const { backend, timers, player } = makeWithCues(await steps(cfg({ ayahRepeat: 1 }), 1, { group: true, mistake: false }));
    backend.failUrls.add('cue://istiadha-reciter');
    backend.hangUrls.add('cue://istiadha-general');
    void player.start();
    timers.flush(); // lead
    await tick();
    assert.deepEqual(backend.loads, ['cue://istiadha-reciter', 'cue://istiadha-general']);
    assert.equal(timers.flush(), CUE_TIMING.loadTimeoutMs);
    await tick();
    assert.deepEqual(backend.loads.at(-1), 'cue://knock');
    backend.end();
    await tick();
    timers.flush(); // tail
    await tick();
    assert.equal(player.state.status, 'playing');
    assert.equal(player.state.error, null);
  });

  it('when no cue file can be played the cue is skipped and the session continues', async () => {
    const { backend, timers, player } = makeWithCues(await steps(cfg({ ayahRepeat: 1 }), 0, { group: true, mistake: false }));
    for (const u of ['cue://istiadha-reciter', 'cue://istiadha-general', 'cue://knock']) backend.failUrls.add(u);
    void player.start();
    timers.flush(); // lead
    await tick();
    timers.flush(); // tail
    await tick();
    assert.equal(player.state.status, 'playing');
    assert.equal(backend.loads.at(-1), ayah(255));
  });

  it('a cue that never reports its end is cut after the safety limit', async () => {
    const { backend, timers, player } = makeWithCues(await steps(cfg({ ayahRepeat: 1 }), 0, { group: false, mistake: true }));
    void player.start();
    timers.flush(); // lead
    await tick();
    assert.equal(backend.loads.at(-1), 'cue://clap');
    assert.equal(timers.flush(), CUE_TIMING.maxPlayMs);
    await tick();
    timers.flush(); // tail
    await tick();
    assert.equal(player.state.status, 'playing');
  });

  it('no cue on plain repetitions; pausing during a cue stops it and resuming replays it', async () => {
    const { backend, timers, player } = makeWithCues(await steps(cfg({ ayahRepeat: 2 }), 0, { group: false, mistake: true }));
    void player.start();
    timers.flush();
    await tick();
    player.pause();
    assert.equal(player.state.status, 'paused');
    assert.equal(timers.pending.length, 0);
    void player.play();
    assert.equal(player.state.status, 'cue');
    timers.flush();
    await tick();
    assert.deepEqual(backend.loads, ['cue://clap', 'cue://clap']);
    backend.end();
    await tick();
    timers.flush();
    await tick();
    assert.equal(player.state.status, 'playing');
    backend.end();
    timers.flush(); // repetition pause
    await tick();
    assert.equal(player.state.status, 'playing', 'second repetition starts without a cue');
    assert.equal(backend.loads.filter((u) => u.startsWith('cue://')).length, 2);
  });

  it('retry after an audio error does not replay the cue', async () => {
    const { backend, timers, player } = makeWithCues(await steps(cfg({ ayahRepeat: 1 }), 0, { group: false, mistake: true }));
    backend.failUrls.add(ayah(255));
    void player.start();
    timers.flush();
    await tick();
    backend.end();
    await tick();
    timers.flush();
    await tick();
    assert.equal(player.state.status, 'error');
    const before = backend.loads.length;
    backend.failUrls.clear();
    await player.retry();
    assert.equal(player.state.status, 'playing');
    assert.deepEqual(backend.loads.slice(before), [ayah(255)]);
  });

  it('without a cue player, cue-marked steps play immediately (no silent delay)', async () => {
    const { timers, player } = make(await steps(cfg({ ayahRepeat: 1 }), 0, both));
    await player.start();
    await tick();
    assert.equal(player.state.status, 'playing');
    assert.equal(timers.pending.length, 0);
  });
});
