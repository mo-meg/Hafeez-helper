import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BUILTIN_RECITERS, ISTIADHA_GENERAL_URL, istiadhaUrls } from '../src/core/audio/reciters.ts';
import { DEFAULT_PREFERENCES, normalizePreferences } from '../src/core/settings/preferences.ts';
import { CUE_RATE, encodeWav, synthCue, SYNTH_CUES } from '../src/browser/cueSynth.ts';

describe('cue sound preferences', () => {
  it("defaults: Isti'adha before a new mistake, knock before the marked ayah", () => {
    assert.equal(DEFAULT_PREFERENCES.cueGroupSound, 'istiadha');
    assert.equal(DEFAULT_PREFERENCES.cueMistakeSound, 'knock');
  });

  it('migrates the earlier on/off ticks: off stays off, on gets the new defaults', () => {
    const off = normalizePreferences({ ...DEFAULT_PREFERENCES, cueGroupSound: undefined, cueMistakeSound: undefined, cueGroupTick: false, cueMistakeTick: false });
    assert.equal(off.cueGroupSound, 'none');
    assert.equal(off.cueMistakeSound, 'none');
    assert.ok(!('cueGroupTick' in off));
    const on = normalizePreferences({ ...DEFAULT_PREFERENCES, cueGroupSound: undefined, cueMistakeSound: undefined, cueGroupTick: true, cueMistakeTick: true });
    assert.equal(on.cueGroupSound, 'istiadha');
    assert.equal(on.cueMistakeSound, 'knock');
  });

  it("rejects the Isti'adha before the marked ayah and unknown sounds", () => {
    assert.equal(normalizePreferences({ ...DEFAULT_PREFERENCES, cueMistakeSound: 'istiadha' }).cueMistakeSound, 'knock');
    assert.equal(normalizePreferences({ ...DEFAULT_PREFERENCES, cueGroupSound: 'bell' }).cueGroupSound, 'istiadha');
  });
});

describe("Isti'adha sources", () => {
  it("EveryAyah reciters try their own folder first, then the general file", () => {
    const husary = BUILTIN_RECITERS.find((r) => r.id === 'husary-murattal-everyayah');
    assert.ok(husary);
    assert.deepEqual(istiadhaUrls(husary.urlTemplate), ['https://everyayah.com/data/Husary_128kbps/audhubillah.mp3', ISTIADHA_GENERAL_URL]);
  });

  it('other hosts and custom templates use the general file only', () => {
    assert.deepEqual(istiadhaUrls('https://cdn.islamic.network/quran/audio/128/ar.husary/{global}.mp3'), [ISTIADHA_GENERAL_URL]);
    assert.deepEqual(istiadhaUrls('https://example.org/{surah}/{ayah}.mp3'), [ISTIADHA_GENERAL_URL]);
  });
});

describe('synthesized cue sounds', () => {
  for (const kind of SYNTH_CUES) {
    it(`${kind}: audible, finite, starts with a silent lead-in and is long enough not to be clipped`, () => {
      const s = synthCue(kind);
      assert.ok(s.every((v) => Number.isFinite(v) && Math.abs(v) <= 1));
      const lead = Math.round(CUE_RATE * 0.045);
      assert.ok(s.slice(0, lead).every((v) => v === 0), 'silent lead-in');
      assert.ok(s.length / CUE_RATE >= 0.3, 'at least 300 ms');
      const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      assert.ok(peak >= 0.5, `peak ${peak}`);
    });
  }

  it('knock and tick are two separate hits', () => {
    for (const kind of ['knock', 'tick'] as const) {
      const s = synthCue(kind);
      const bin = Math.round(CUE_RATE * 0.02);
      const loud: boolean[] = [];
      for (let i = 0; i < s.length; i += bin) loud.push(s.slice(i, i + bin).some((v) => Math.abs(v) > 0.3));
      const onsets = loud.filter((v, i) => v && !loud[i - 1]).length;
      assert.equal(onsets, 2, `${kind} onsets`);
    }
  });

  it('encodes a valid 16-bit mono WAV', () => {
    const w = encodeWav(synthCue('clap'));
    const v = new DataView(w.buffer);
    assert.equal(String.fromCharCode(...w.slice(0, 4)), 'RIFF');
    assert.equal(String.fromCharCode(...w.slice(8, 12)), 'WAVE');
    assert.equal(v.getUint16(22, true), 1);
    assert.equal(v.getUint32(24, true), CUE_RATE);
    assert.equal(v.getUint32(40, true), w.length - 44);
  });
});
