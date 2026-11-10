import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { search } from '../src/core/recitation/align.ts';
import { Chunker, downsample, MODEL_RATE } from '../src/core/recitation/audio.ts';
import { RecitationController, toHypWords, type RecitationState } from '../src/core/recitation/controller.ts';
import { encodeWav, isLocalEndpoint, type AsrEngine, type AsrResult } from '../src/core/recitation/engine.ts';
import { RecitationMistakeBridge } from '../src/core/recitation/mistakeBridge.ts';
import { normWord, similarity } from '../src/core/recitation/normalize.ts';
import { RecitationTracker, stripPreamble, type RecognisedChunk } from '../src/core/recitation/tracker.ts';
import { toIndex } from '../src/core/quran/refs.ts';
import type { HypWord } from '../src/core/recitation/align.ts';
import { setup } from './helpers.ts';
import { ayahWords, flatWords, junk, recitationCorpus } from './fixtures/recitation.ts';

let clock = 0;
function chunk(words: HypWord[], opts: { silenceBeforeMs?: number; durMs?: number } = {}): RecognisedChunk {
  const startMs = clock + (opts.silenceBeforeMs ?? 300);
  clock = startMs + (opts.durMs ?? words.length * 600);
  return { words, startMs, endMs: clock, silenceBeforeMs: opts.silenceBeforeMs ?? 300 };
}
function tracker() {
  clock = 0;
  return new RecitationTracker(recitationCorpus().corpus);
}
const flatOf = (surah: number, ayah: number, position = 1) => recitationCorpus().corpus.ayahStart(toIndex({ surah, ayah })) + position - 1;

describe('normalisation (comparison only)', () => {
  it('treats Uthmani and plain spellings as near-identical', () => {
    assert.equal(normWord('ٱلرَّحْمَٰنِ'), 'الرحمن');
    assert.ok(similarity(normWord('ٱلصَّلَوٰةَ'), normWord('الصلاة')) >= 0.84);
    assert.ok(similarity('كتب', 'فرح') < 0.6);
  });
});

describe('preamble', () => {
  it('ignores the isti\'adha and a basmala said before the passage', () => {
    const w = (t: string) => t.split(' ').map((raw) => ({ raw, norm: normWord(raw) }));
    assert.deepEqual(stripPreamble(w('أعوذ بالله من الشيطان الرجيم كل الطعام')).map((x) => x.norm), ['كل', 'الطعام']);
    assert.deepEqual(stripPreamble(w('أعوذ بالله')).length, 0, 'partial isti\'adha is held back');
    assert.deepEqual(stripPreamble(w('بسم الله الرحمن الرحيم الم')).map((x) => x.norm), ['الم']);
    assert.equal(stripPreamble(w('بسم الله الرحمن الرحيم')).length, 4, 'basmala alone is kept (Al-Fatihah 1:1)');
  });
});

describe('stage A: global passage identification', () => {
  it('identifies surah, ayah and word without any pre-selection', () => {
    const t = tracker();
    t.push(chunk(ayahWords({ surah: 18, ayah: 10 })));
    const s = t.snapshot();
    assert.equal(s.mode, 'focused');
    assert.deepEqual(s.location?.ref, { surah: 18, ayah: 11 });
    assert.equal(s.location?.position, 1);
    assert.ok(s.location?.page !== null);
  });

  it('starts mid-ayah and tolerates a noisy word', () => {
    const t = tracker();
    const w = flatWords(flatOf(2, 100, 3), 7);
    w[3] = junk(1)[0] as HypWord;
    t.push(chunk(w));
    assert.equal(t.snapshot().mode, 'focused');
    assert.equal(t.cursor, flatOf(2, 100, 3) + 7);
  });

  it('does not lock on too few words', () => {
    const t = tracker();
    t.push(chunk(flatWords(flatOf(5, 3), 2)));
    assert.equal(t.snapshot().mode, 'searching');
  });

  it('stays ambiguous for a passage that occurs twice, then resolves with following words', () => {
    const { corpus } = recitationCorpus();
    const dup = ayahWords({ surah: 3, ayah: 5 });
    assert.equal(search(corpus, dup).confident, false);
    const t = tracker();
    t.push(chunk(dup));
    assert.equal(t.snapshot().mode, 'searching');
    t.push(chunk(ayahWords({ surah: 40, ayah: 6 })));
    assert.equal(t.snapshot().mode, 'focused');
    assert.deepEqual(t.snapshot().location?.ref, { surah: 40, ayah: 7 });
  });
});

describe('stage B: focused tracking', () => {
  it('switches to focused mode and follows word by word across a page boundary', () => {
    const { corpus } = recitationCorpus();
    const start = flatOf(2, 40);
    const page = corpus.pageAt(start) as number;
    const [, pageEnd] = corpus.pageSpan(page, page);
    const t = tracker();
    t.push(chunk(flatWords(pageEnd - 12, 6)));
    assert.equal(t.mode, 'focused');
    for (let k = pageEnd - 6; k < pageEnd + 12; k += 3) t.push(chunk(flatWords(k, 3)));
    const s = t.snapshot();
    assert.equal(s.mode, 'focused');
    assert.equal(s.location?.page, page + 1);
    assert.equal(s.findings.length, 0);
    for (let k = pageEnd - 12; k < pageEnd + 12; k++) assert.equal(s.status.get(k), 'correct', `word ${k}`);
  });

  it('confirms a substitution only after the confirmation window', () => {
    const t = tracker();
    const base = flatOf(10, 20);
    t.push(chunk(flatWords(base, 6)));
    const next = flatWords(base + 6, 3);
    next[1] = { norm: 'ڤڤڤ', raw: 'x' };
    t.push(chunk(next, { durMs: 800 }));
    assert.equal(t.snapshot().status.get(base + 7), 'pending');
    assert.equal(t.snapshot().findings.length, 0);
    t.push(chunk(flatWords(base + 9, 4)));
    const s = t.snapshot();
    assert.equal(s.status.get(base + 7), 'incorrect');
    assert.deepEqual(s.findings.map((f) => f.kind), ['incorrect']);
    assert.equal(s.findings[0]?.tokenText, recitationCorpus().corpus.words[base + 7]?.text, 'snapshot is the canonical token');
  });

  it('detects an omitted word', () => {
    const t = tracker();
    const base = flatOf(20, 30);
    t.push(chunk(flatWords(base, 6)));
    t.push(chunk([...flatWords(base + 6, 2), ...flatWords(base + 9, 3)]));
    t.push(chunk(flatWords(base + 12, 4)));
    const s = t.snapshot();
    assert.equal(s.status.get(base + 8), 'skipped');
    assert.deepEqual(s.findings.map((f) => [f.kind, f.flat]), [['skipped', base + 8]]);
  });

  it('detects repetition without counting it as a mistake', () => {
    const t = tracker();
    const base = flatOf(30, 10);
    t.push(chunk(flatWords(base, 6)));
    t.push(chunk(flatWords(base + 4, 5))); // goes back two words and continues
    const s = t.snapshot();
    assert.equal(s.status.get(base + 4), 'repeated');
    assert.equal(s.status.get(base + 8), 'correct');
    assert.deepEqual(s.findings.map((f) => f.kind), ['repeated', 'repeated']);
  });

  it('lets the reciter self-correct inside the window', () => {
    const t = tracker();
    const base = flatOf(12, 40);
    t.push(chunk(flatWords(base, 6)));
    const wrong = flatWords(base + 6, 2);
    wrong[1] = { norm: 'ڤڤڤ', raw: 'x' };
    t.push(chunk(wrong, { durMs: 600 }));
    assert.equal(t.snapshot().status.get(base + 7), 'pending');
    t.push(chunk(flatWords(base + 6, 5), { durMs: 600 }));
    const s = t.snapshot();
    assert.equal(s.status.get(base + 7), 'correct');
    assert.equal(s.selfCorrections, 1);
    assert.equal(s.findings.filter((f) => f.kind === 'incorrect').length, 0);
  });

  it('treats low-confidence and near-match words as uncertain, never as mistakes', () => {
    const t = tracker();
    const base = flatOf(7, 50);
    t.push(chunk(flatWords(base, 6)));
    const w = flatWords(base + 6, 4);
    w[1] = { norm: 'ڤڤڤ', raw: 'x', confidence: 0.2 };
    t.push(chunk(w));
    t.push(chunk(flatWords(base + 10, 4)));
    t.finish();
    const s = t.snapshot();
    assert.equal(s.status.get(base + 7), 'uncertain');
    assert.equal(s.findings.length, 0);
  });

  it('records a long mid-ayah pause as hesitation but not a pause between ayat', () => {
    const t = tracker();
    const base = flatOf(15, 20);
    t.push(chunk(flatWords(base, 4)));
    t.push(chunk(flatWords(base + 4, 2), { silenceBeforeMs: 5000 }));
    assert.deepEqual(t.snapshot().findings.map((f) => [f.kind, f.flat]), [['hesitation', base + 4]]);
    const t2 = tracker();
    const a = ayahWords({ surah: 15, ayah: 20 });
    t2.push(chunk(a));
    t2.push(chunk(ayahWords({ surah: 15, ayah: 21 }), { silenceBeforeMs: 6000 }));
    assert.equal(t2.snapshot().findings.length, 0);
  });

  it('falls back to broader matching when recognition becomes unreliable, then re-locks', () => {
    const t = tracker();
    const base = flatOf(25, 10);
    t.push(chunk(flatWords(base, 6)));
    t.push(chunk(junk(4, 'a')));
    assert.equal(t.mode, 'focused');
    t.push(chunk(junk(4, 'b')));
    assert.equal(t.mode, 'searching');
    const s = t.snapshot();
    for (let k = base + 6; k < base + 14; k++) assert.equal(s.status.get(k), undefined, 'nothing highlighted from junk');
    t.push(chunk(flatWords(base + 6, 6)));
    assert.equal(t.mode, 'focused');
    assert.equal(t.cursor, base + 12);
  });
});

describe('audio input', () => {
  const tone = (ms: number, amp: number) => Float32Array.from({ length: (MODEL_RATE * ms) / 1000 }, (_, i) => amp * Math.sin(i / 3));

  it('downsamples 48 kHz to 16 kHz', () => {
    assert.equal(downsample(new Float32Array(48000), 48000).length, 16000);
    assert.throws(() => downsample(new Float32Array(10), 8000));
  });

  it('chunks speech at pauses, drops silence and never duplicates samples', () => {
    const c = new Chunker();
    const out = [...c.push(tone(1000, 0)), ...c.push(tone(1500, 0.3)), ...c.push(tone(800, 0)), ...c.push(tone(1200, 0.3)), ...c.flush()];
    assert.equal(out.length, 2);
    assert.ok((out[0]?.silenceBeforeMs ?? 0) >= 900);
    const total = out.reduce((n, ch) => n + ch.pcm.length, 0);
    assert.ok(total <= MODEL_RATE * 2.8);
    assert.ok((out[1]?.startMs ?? 0) >= (out[0]?.endMs ?? 0));
  });

  it('cuts long continuous recitation at the max chunk length', () => {
    const c = new Chunker({ maxChunkMs: 2000 });
    const out = c.push(tone(5000, 0.3));
    assert.ok(out.length >= 2);
    assert.ok(out.every((ch) => ch.endMs - ch.startMs <= 2000));
  });

  it('closes an utterance with a final chunk even when silence follows a length cut', () => {
    const c = new Chunker({ maxChunkMs: 2000 });
    // fading speech: the quietest frame (where the length cut happens) is the very last one
    const fading = Float32Array.from({ length: MODEL_RATE * 2 }, (_, i) => (0.3 - (0.2 * i) / (MODEL_RATE * 2)) * Math.sin(i / 3));
    const out = [...c.push(fading), ...c.push(tone(1000, 0))];
    assert.deepEqual(out.map((ch) => ch.final), [false, true]);
    assert.equal(out[1]?.pcm.length, 0);
  });

  it('keeps soft speech after a reverberant quiet passage (noise floor is capped)', () => {
    const c = new Chunker();
    const out = [...c.push(tone(3000, 0.04)), ...c.push(tone(2000, 0.035)), ...c.flush()];
    assert.ok(out.reduce((n, ch) => n + ch.pcm.length, 0) >= MODEL_RATE * 4.5);
  });

  it('encodes WAV and only accepts loopback endpoints', () => {
    const wav = encodeWav(new Float32Array(160));
    assert.equal(wav.length, 44 + 320);
    assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
    assert.ok(isLocalEndpoint('http://127.0.0.1:8765/transcribe'));
    assert.ok(isLocalEndpoint('http://localhost:8765'));
    assert.ok(!isLocalEndpoint('https://api.example.com/asr'));
  });

  it('uses model word timestamps only when provided', () => {
    const withTs = toHypWords({ text: 'a b', words: [{ word: 'كتب', start: 0.5, end: 0.9 }] }, 1000);
    assert.equal(withTs[0]?.startMs, 1500);
    const plain = toHypWords({ text: 'كتب قلم' }, 1000);
    assert.equal(plain.length, 2);
    assert.equal(plain[0]?.startMs, undefined);
  });
});

describe('controller with a mocked model', () => {
  const tone = (ms: number, amp: number) => Float32Array.from({ length: (MODEL_RATE * ms) / 1000 }, (_, i) => amp * Math.sin(i / 3));
  function mock(script: Array<AsrResult | Error>, load?: Error): AsrEngine & { calls: number } {
    return {
      name: 'mock',
      calls: 0,
      async load() {
        if (load) throw load;
      },
      async transcribe() {
        const r = script[this.calls++ % script.length] as AsrResult | Error;
        if (r instanceof Error) throw r;
        return r;
      },
    };
  }
  const text = (words: HypWord[]) => ({ text: words.map((w) => w.raw).join(' ') });
  const base = () => flatOf(9, 30);

  it('recognises recorded speech chunks and keeps results after a microphone failure', async () => {
    const engine = mock([text(flatWords(base(), 6)), text(flatWords(base() + 6, 4))]);
    const states: RecitationState[] = [];
    const c = new RecitationController({ engine, tracker: tracker(), onUpdate: (s) => states.push(s) });
    assert.equal(await c.start(), true);
    c.feed(tone(1200, 0.3));
    c.feed(tone(600, 0));
    c.feed(tone(1200, 0.3));
    await c.interrupt(new Error('device unplugged'));
    const s = c.state();
    assert.equal(s.status, 'error');
    assert.equal(s.error?.kind, 'microphone');
    assert.equal(s.tracker.cursor, base() + 10);
    assert.ok(states.some((x) => x.status === 'listening'));
  });

  it('reports model loading errors', async () => {
    const c = new RecitationController({ engine: mock([], new Error('server not running')), tracker: tracker(), onUpdate: () => {} });
    assert.equal(await c.start(), false);
    assert.deepEqual(c.state().error, { kind: 'model', detail: 'server not running' });
  });

  it('survives a transient engine error and stops after repeated failures', async () => {
    const ok = mock([new Error('blip'), text(flatWords(base(), 6))]);
    const c = new RecitationController({ engine: ok, tracker: tracker(), onUpdate: () => {} });
    await c.start();
    for (let i = 0; i < 2; i++) {
      c.feed(tone(1200, 0.3));
      c.feed(tone(600, 0));
    }
    await c.stop();
    assert.equal(c.state().status, 'stopped');
    assert.equal(c.state().tracker.mode, 'focused');
    const bad = new RecitationController({ engine: mock([new Error('crash')]), tracker: tracker(), onUpdate: () => {} });
    await bad.start();
    for (let i = 0; i < 4; i++) {
      bad.feed(tone(1200, 0.3));
      bad.feed(tone(600, 0));
    }
    await bad.stop();
    assert.equal(bad.state().error?.kind, 'engine');
  });

  it('pause ignores audio, resume continues, and the last transcript is exposed for display', async () => {
    const engine = mock([text(flatWords(base(), 6))]);
    const c = new RecitationController({ engine, tracker: tracker(), onUpdate: () => {} });
    await c.start();
    c.feed(tone(1200, 0.3));
    c.pause();
    await c.idle();
    const calls = engine.calls;
    c.feed(tone(3000, 0.3));
    await c.idle();
    assert.equal(engine.calls, calls, 'no recognition while paused');
    assert.equal(c.state().paused, true);
    c.resume();
    assert.equal(c.state().paused, false);
    assert.ok(c.state().heard.length > 0);
    assert.ok((c.state().latencyMs ?? -1) >= 0);
    await c.stop();
  });

  it('silence produces no recognition calls', async () => {
    const engine = mock([text([])]);
    const c = new RecitationController({ engine, tracker: tracker(), onUpdate: () => {} });
    await c.start();
    c.feed(tone(3000, 0.001));
    await c.stop();
    assert.equal(engine.calls, 0);
    assert.equal(c.state().silent, true);
  });
});

describe('saving findings as mistakes', () => {
  it('uses the existing mistake service without duplicate records', async () => {
    const { mistakes } = setup();
    const t = tracker();
    const b = flatOf(10, 20);
    t.push(chunk(flatWords(b, 6)));
    const w = flatWords(b + 6, 3);
    w[1] = { norm: 'ڤڤڤ', raw: 'x' };
    t.push(chunk(w));
    t.push(chunk(flatWords(b + 9, 4)));
    t.push(chunk(flatWords(b + 9, 4))); // same audio recognised again
    t.finish();
    const findings = t.snapshot().findings.filter((f) => f.kind === 'incorrect');
    assert.equal(findings.length, 1);
    const bridge = new RecitationMistakeBridge(mistakes, 'synthetic-recitation', 'rec-1');
    const first = await bridge.save(findings);
    const again = await bridge.save(findings);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.action, 'created');
    assert.equal(first[0]?.mistake.category, 'incorrect_word');
    assert.equal(again.length, 0);
    const next = await new RecitationMistakeBridge(mistakes, 'synthetic-recitation', 'rec-2').save(findings);
    assert.equal(next[0]?.action, 'recurred', 'a later session records a recurrence, not a duplicate');
    assert.equal((await mistakes.list()).length, 1);
  });
});
