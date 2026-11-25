import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { search } from '../src/core/recitation/align.ts';
import { downsample, MODEL_RATE } from '../src/core/recitation/audio.ts';
import { RecitationController, type RecitationState } from '../src/core/recitation/controller.ts';
import { UnitSegmenter, type HeardUnit } from '../src/core/recitation/segment.ts';
import { mapForms, type RecitationCorpus } from '../src/core/recitation/corpus.ts';
import { unitKey, wordForms, type AyahUnits, type EngineTake, type HeardUpdate, type RecitationEngine, type TakeEndReason } from '../src/core/recitation/engine.ts';
import { buildUnitCorpus } from '../src/core/recitation/unitCorpus.ts';
import { fastestContext, toUpdate } from '../src/browser/tajweedEngine.ts';
import { RecitationMistakeBridge } from '../src/core/recitation/mistakeBridge.ts';
import { normWord, similarity } from '../src/core/recitation/normalize.ts';
import { RecitationTracker, stripPreamble, trackerConfigFor, type RecognisedChunk } from '../src/core/recitation/tracker.ts';
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
    const C = { istiadha: ['اعوذ', 'بالله', 'من', 'الشيطان', 'الرجيم'], basmala: ['بسم', 'الله', 'الرحمن', 'الرحيم'] };
    assert.deepEqual(stripPreamble(w('أعوذ بالله من الشيطان الرجيم كل الطعام'), C).map((x) => x.norm), ['كل', 'الطعام']);
    assert.deepEqual(stripPreamble(w('أعوذ بالله'), C).length, 0, 'partial isti\'adha is held back');
    assert.deepEqual(stripPreamble(w('بسم الله الرحمن الرحيم الم'), C).map((x) => x.norm), ['الم']);
    assert.equal(stripPreamble(w('بسم الله الرحمن الرحيم'), C).length, 4, 'basmala alone is kept (Al-Fatihah 1:1)');
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
    assert.equal(t.snapshot().status.get(base + 7), 'correct', 'unsure words show as correct (no "checking" state)');
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

  it('never marks repetition', () => {
    const t = tracker();
    const base = flatOf(30, 10);
    t.push(chunk(flatWords(base, 6)));
    t.push(chunk(flatWords(base + 4, 5))); // goes back two words and continues
    const s = t.snapshot();
    assert.equal(s.status.get(base + 4), 'correct');
    assert.equal(s.status.get(base + 8), 'correct');
    assert.equal(s.findings.length, 0);
  });

  it('lets the reciter self-correct inside the window', () => {
    const t = tracker();
    const base = flatOf(12, 40);
    t.push(chunk(flatWords(base, 6)));
    const wrong = flatWords(base + 6, 2);
    wrong[1] = { norm: 'ڤڤڤ', raw: 'x' };
    t.push(chunk(wrong, { durMs: 600 }));
    assert.equal(t.snapshot().status.get(base + 7), 'correct');
    t.push(chunk(flatWords(base + 6, 5), { durMs: 600 }));
    const s = t.snapshot();
    assert.equal(s.status.get(base + 7), 'correct');
    assert.equal(s.selfCorrections, 1);
    assert.equal(s.findings.filter((f) => f.kind === 'incorrect').length, 0);
  });

  it('never reports low-confidence words as mistakes (shown as correct)', () => {
    const t = tracker();
    const base = flatOf(7, 50);
    t.push(chunk(flatWords(base, 6)));
    const w = flatWords(base + 6, 4);
    w[1] = { norm: 'ڤڤڤ', raw: 'x', confidence: 0.2 };
    t.push(chunk(w));
    t.push(chunk(flatWords(base + 10, 4)));
    t.finish();
    const s = t.snapshot();
    assert.equal(s.status.get(base + 7), 'correct');
    assert.equal(s.findings.length, 0);
  });

  it('records a long mid-ayah pause as hesitation but not a pause between ayat', () => {
    const t = tracker();
    const base = flatOf(15, 20);
    t.push(chunk(flatWords(base, 4)));
    t.push(chunk(flatWords(base + 4, 2), { silenceBeforeMs: 7000 }));
    assert.deepEqual(t.snapshot().findings.map((f) => [f.kind, f.flat]), [['hesitation', base + 4]]);
    const t2 = tracker();
    const a = ayahWords({ surah: 15, ayah: 20 });
    t2.push(chunk(a));
    t2.push(chunk(ayahWords({ surah: 15, ayah: 21 }), { silenceBeforeMs: 8000 }));
    assert.equal(t2.snapshot().findings.length, 0);
  });

  it('memorization ignores a changed letter or vowel; + vowels reports it', () => {
    const base = flatOf(11, 30);
    const run = (level: 'memorization' | 'vowels') => {
      clock = 0;
      const t = new RecitationTracker(recitationCorpus().corpus, trackerConfigFor(level));
      t.push(chunk(flatWords(base, 6)));
      const w = flatWords(base + 6, 3);
      const n = w[1]?.norm ?? '';
      w[1] = { norm: `${n.slice(0, -1)}${n.endsWith('ب') ? 'ت' : 'ب'}`, raw: 'x' }; // last letter changed
      t.push(chunk(w));
      t.push(chunk(flatWords(base + 9, 4)));
      t.finish();
      return t.snapshot();
    };
    const memo = run('memorization');
    assert.equal(memo.findings.length, 0);
    assert.equal(memo.status.get(base + 7), 'correct');
    const vowels = run('vowels');
    assert.deepEqual(vowels.findings.map((f) => [f.kind, f.flat]), [['incorrect', base + 7]]);
  });

  it('memorization still reports a clearly different word', () => {
    clock = 0;
    const t = new RecitationTracker(recitationCorpus().corpus, trackerConfigFor('memorization'));
    const base = flatOf(13, 12);
    t.push(chunk(flatWords(base, 6)));
    const w = flatWords(base + 6, 3);
    w[1] = { norm: 'ڤڤڤڤ', raw: 'x' };
    t.push(chunk(w));
    t.push(chunk(flatWords(base + 9, 4)));
    assert.deepEqual(t.snapshot().findings.map((f) => [f.kind, f.flat]), [['incorrect', base + 7]]);
  });

  it('takes a place found by the segmenter (anchor) without searching again', () => {
    const t = tracker();
    const base = flatOf(16, 40);
    t.push({ ...chunk(flatWords(base, 1)), anchor: base });
    assert.equal(t.mode, 'focused');
    assert.equal(t.cursor, base + 1);
    assert.equal(t.snapshot().status.get(base), 'correct');
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
  it('downsamples 48 kHz to 16 kHz', () => {
    assert.equal(downsample(new Float32Array(48000), 48000).length, 16000);
    assert.throws(() => downsample(new Float32Array(10), 8000));
  });
});

// ---------------------------------------------------------------- the model's sound units
// Fake units for the synthetic text: one unit per letter (code point − 0x600), word bar = 1.
const BAR = 1;
const SEPS = new Set([0, BAR]);
const unitsOfWord = (plain: string) => [...plain].map((c) => (c.codePointAt(0) as number) - 0x600);
function fakeAyahUnits(surah: number, ayah: number): AyahUnits {
  const words = recitationCorpus().text.ayah({ surah, ayah }).tokens.filter((t) => t.position !== null).map((t) => normWord(t.text));
  const units: number[] = [];
  const idx: number[] = [];
  words.forEach((w, k) => {
    if (k) {
      units.push(BAR);
      idx.push(k);
    }
    for (const u of unitsOfWord(w)) {
      units.push(u);
      idx.push(k + 1);
    }
  });
  return { units, words: idx, wordCount: words.length };
}

interface FakeTake extends EngineTake {
  pushed: number;
  finished: boolean;
  update(u: Partial<HeardUpdate> & { units: HeardUnit[] }): void;
  end(reason: TakeEndReason, e?: unknown): void;
}
function fakeEngine(opts: { loadError?: Error } = {}): RecitationEngine & { takes: FakeTake[] } {
  const takes: FakeTake[] = [];
  return {
    name: 'fake',
    separators: SEPS,
    takes,
    async load(onProgress) {
      onProgress?.({ bytesDone: 10, bytesTotal: 20 });
      if (opts.loadError) throw opts.loadError;
    },
    async ayahUnits(s, a) {
      return fakeAyahUnits(s, a);
    },
    start(onUpdate, onEnd) {
      let last: HeardUpdate = { units: [], settledUnits: 0, final: false, text: '', speech: false };
      const tk: FakeTake = {
        pushed: 0,
        finished: false,
        push(pcm) {
          tk.pushed += pcm.length;
        },
        async finish() {
          tk.finished = true;
          onUpdate({ ...last, final: true });
        },
        async cancel() {},
        update(u) {
          last = { settledUnits: u.units.length, final: false, text: u.units.map((x) => x.name).join(' '), speech: true, ...u };
          onUpdate(last);
        },
        end: (reason, e) => onEnd(reason, e),
      };
      takes.push(tk);
      return tk;
    },
  };
}

let unitCorpusCache: RecitationCorpus | null = null;
async function unitCorpus(): Promise<RecitationCorpus> {
  const { text, index } = recitationCorpus();
  unitCorpusCache ??= await buildUnitCorpus(text, index, fakeEngine());
  return unitCorpusCache;
}
/** What a perfect model hears for canonical words [from, from+count): one flat unit stream, no word bars (as measured), 100 ms per unit. */
function heard(from: number, count: number, atMs = 0): HeardUnit[] {
  const ids = recitationCorpus().corpus.words.slice(from, from + count).flatMap((w) => unitsOfWord(w.plain));
  return ids.map((id, k) => ({ id, name: `u${id}`, startMs: atMs + k * 100, endMs: atMs + k * 100 + 80, confidence: 0.9 }));
}
const unitsPer = 4; // synthetic words have 4 letters
const silence = (ms: number) => new Float32Array((MODEL_RATE * ms) / 1000);

describe('sound-unit comparison text (model reference table)', () => {
  it('splits an ayah\'s expected units into words and keeps the canonical words', async () => {
    const forms = wordForms({ units: [5, 6, BAR, 7, BAR, 8, 9], words: [1, 1, 1, 2, 2, 3, 3], wordCount: 3 }, SEPS);
    assert.deepEqual(forms, [unitKey([5, 6]), unitKey([7]), unitKey([8, 9])]);
    const uc = await unitCorpus();
    const ac = recitationCorpus().corpus;
    assert.equal(uc.kind, 'units');
    assert.equal(uc.size, ac.size);
    assert.equal(uc.words[100]?.text, ac.words[100]?.text);
    assert.equal(uc.words[100]?.norm, unitKey(unitsOfWord(ac.words[100]?.plain ?? '')));
    assert.deepEqual(uc.mismatchedAyat, []);
  });

  it('spreads forms when the model counts words differently', () => {
    assert.deepEqual(mapForms(['a', 'b', 'c'], 2), ['ab', 'c']);
    assert.deepEqual(mapForms(['a'], 3), ['a', 'a', 'a']);
    assert.deepEqual(mapForms(['a', 'b'], 2), ['a', 'b']);
  });

  it('finds a passage from sound units without any selection', async () => {
    const uc = await unitCorpus();
    const t = new RecitationTracker(uc);
    const from = flatOf(18, 10);
    // a little noise first (e.g. a breath heard as sounds), then 8 words without any word bar
    const noise: HeardUnit[] = [3, 4].map((id) => ({ id, name: 'n', startMs: 0, endMs: 50, confidence: 0.5 }));
    const r = new UnitSegmenter(uc).segment([...noise, ...heard(from, 8, 200)], null, true);
    assert.equal(r.words.length, 8, 'cut at the canonical word boundaries');
    assert.deepEqual(r.words.map((w) => w.norm), uc.words.slice(from, from + 8).map((w) => w.norm));
    t.push({ words: r.words, startMs: 0, endMs: 5000, silenceBeforeMs: 0 });
    assert.equal(t.snapshot().mode, 'focused');
    assert.equal(t.cursor, from + 8);
  });

  it('locks on after two words at the start of an ayah (fast first output)', async () => {
    const uc = await unitCorpus();
    const from = flatOf(18, 10);
    const r = new UnitSegmenter(uc).segment(heard(from, 2), null, false);
    assert.equal(r.anchor, from, 'found among the ayah openings');
    assert.deepEqual(r.words.map((w) => w.norm), [uc.words[from]?.norm], 'the last word may still grow');
    const t = new RecitationTracker(uc);
    t.push({ words: r.words, startMs: 0, endMs: 800, silenceBeforeMs: 0, anchor: r.anchor as number });
    assert.equal(t.mode, 'focused');
    assert.equal(t.cursor, from + 1);
  });

  it('skips a lead-in before the ayah opening, and needs more sounds mid-ayah', async () => {
    const uc = await unitCorpus();
    const from = flatOf(22, 7);
    const noise: HeardUnit[] = [3, 4, 3].map((id) => ({ id, name: 'n', startMs: 0, endMs: 50, confidence: 0.5 }));
    const r = new UnitSegmenter(uc).segment([...noise, ...heard(from, 3, 300)], null, false);
    assert.equal(r.anchor, from);
    assert.equal(r.words.length, 2);
    const mid = new UnitSegmenter(uc).segment(heard(from + 2, 2), null, false);
    assert.equal(mid.words.length, 0, 'mid-ayah: the whole-Quran search waits for more sounds');
  });

  it('waits for more sounds when a passage occurs in two places', async () => {
    const uc = await unitCorpus();
    const seg = new UnitSegmenter(uc);
    const twin = flatOf(3, 5);
    assert.equal(seg.segment(heard(twin, 6), null, false).words.length, 0, '3:5 = 40:5 in the fixture');
  });

  it('keeps a wrong word visible to the tracker (substitution inside the word)', async () => {
    const uc = await unitCorpus();
    const from = flatOf(10, 20);
    const units = heard(from, 10).map((u, k) => (k >= 5 * unitsPer && k < 6 * unitsPer ? { ...u, id: 2 } : u));
    const r = new UnitSegmenter(uc).segment(units, null, true);
    const t = new RecitationTracker(uc);
    t.push({ words: r.words, startMs: 0, endMs: 4000, silenceBeforeMs: 0 });
    t.finish();
    assert.deepEqual(t.snapshot().findings.map((f) => [f.kind, f.flat]), [['incorrect', from + 5]]);
  });

  it('uses the shortest-chunk context for fast recitation', () => {
    const ms: Record<string, number> = { short: 160, standard: 320, long: 480 };
    assert.equal(fastestContext({ contexts: ['standard', 'long', 'short'], chunkMs: (c?: string) => ms[c ?? 'standard'] as number }), 'short');
    assert.equal(fastestContext({ contexts: [], chunkMs: () => 320 }), undefined);
  });

  it('maps the SDK decoded layer to a flat unit stream: word bar dropped, settled count kept', () => {
    const tok = (id: number, ms: number) => ({ id, name: String(id), firstMs: ms, peakMs: ms, lastMs: ms, confidence: 0.8 });
    const w1 = [tok(5, 0), tok(6, 40)];
    const w2 = [tok(7, 400)];
    const decoded = {
      text: 'ab c', settled: 3, isFinal: false, frames: [],
      tokens: [...w1, tok(BAR, 200), ...w2],
      words: [{ index: 0, text: 'ab', tokens: w1, firstMs: 0, lastMs: 40, confidence: 0.8 }, { index: 1, text: 'c', tokens: w2, firstMs: 400, lastMs: 400, confidence: 0.8 }],
    };
    const u = toUpdate(decoded, true, SEPS);
    assert.deepEqual(u.units.map((x) => x.id), [5, 6, 7]);
    assert.equal(u.settledUnits, 2);
    assert.equal(u.units[1]?.endMs, 80);
  });
});

describe('controller with a fake streaming model', () => {
  const base = () => flatOf(9, 30);

  it('hands settled words to the tracker once and the last word at the end of the take', async () => {
    const engine = fakeEngine();
    const states: RecitationState[] = [];
    const c = new RecitationController({ engine, tracker: new RecitationTracker(await unitCorpus()), onUpdate: (s) => states.push(s) });
    assert.equal(await c.start(), true);
    assert.ok(states.some((s) => s.progress?.bytesTotal === 20), 'download progress is reported');
    c.feed(silence(1000));
    const tk = engine.takes[0] as FakeTake;
    assert.equal(tk.pushed, MODEL_RATE);
    tk.update({ units: heard(base(), 6) });
    assert.equal(c.state().tracker.cursor, base() + 5, 'the last word can still grow');
    tk.update({ units: heard(base(), 10), settledUnits: 6 * unitsPer });
    assert.ok((c.state().tracker.cursor ?? 0) <= base() + 6, 'unsettled words are not handed over');
    assert.equal(c.state().silent, false);
    assert.ok(c.state().heard.length > 0);
    await c.stop();
    assert.equal(tk.finished, true);
    assert.equal(c.state().status, 'stopped');
    assert.equal(c.state().tracker.cursor, base() + 10);
    assert.equal(c.state().tracker.findings.length, 0, 'nothing counted twice');
  });

  it('reports model loading errors', async () => {
    const c = new RecitationController({ engine: fakeEngine({ loadError: new Error('needs_connection') }), tracker: new RecitationTracker(await unitCorpus()), onUpdate: () => {} });
    assert.equal(await c.start(), false);
    assert.deepEqual(c.state().error, { kind: 'model', detail: 'needs_connection' });
  });

  it('continues in a new take when the engine ends one, and stops on an engine error', async () => {
    const engine = fakeEngine();
    const c = new RecitationController({ engine, tracker: new RecitationTracker(await unitCorpus()), onUpdate: () => {} });
    await c.start();
    c.feed(silence(2000));
    (engine.takes[0] as FakeTake).update({ units: heard(base(), 6) });
    (engine.takes[0] as FakeTake).end('ended');
    assert.equal(engine.takes.length, 2);
    (engine.takes[1] as FakeTake).update({ units: heard(base() + 6, 4) });
    assert.equal(c.state().tracker.cursor, base() + 9);
    (engine.takes[1] as FakeTake).end('error', new Error('engine_failed'));
    assert.equal(c.state().error?.kind, 'engine');
    c.feed(silence(500));
    assert.equal((engine.takes[1] as FakeTake).pushed, 0, 'no audio after the failure');
  });

  it('keeps results after a microphone failure', async () => {
    const engine = fakeEngine();
    const c = new RecitationController({ engine, tracker: new RecitationTracker(await unitCorpus()), onUpdate: () => {} });
    await c.start();
    (engine.takes[0] as FakeTake).update({ units: heard(base(), 6) });
    await c.interrupt(new Error('device unplugged'));
    assert.equal(c.state().error?.kind, 'microphone');
    assert.equal(c.state().tracker.cursor, base() + 6);
  });

  it('pause closes the take and ignores audio; resume opens a new take', async () => {
    const engine = fakeEngine();
    const c = new RecitationController({ engine, tracker: new RecitationTracker(await unitCorpus()), onUpdate: () => {} });
    await c.start();
    c.pause();
    await c.idle();
    assert.equal((engine.takes[0] as FakeTake).finished, true);
    c.feed(silence(3000));
    assert.equal((engine.takes[0] as FakeTake).pushed, 0);
    assert.equal(c.state().paused, true);
    c.resume();
    assert.equal(engine.takes.length, 2);
    c.feed(silence(100));
    assert.equal((engine.takes[1] as FakeTake).pushed, MODEL_RATE / 10);
    await c.stop();
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
