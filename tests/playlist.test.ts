import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RepeatConfig } from '../src/core/model.ts';
import { buildMistakePlaylist, buildPortionPlaylist, playlistAyahCount } from '../src/core/playlist/playlist.ts';
import { concatSequences, estimateDurationMs, expandSequence, playsPerAyah, RepeatConfigError } from '../src/core/playlist/sequence.ts';
import { DivisionIndex } from '../src/core/quran/divisions.ts';
import { fromIndex, toIndex } from '../src/core/quran/refs.ts';
import { scopeIntervals } from '../src/core/quran/scope.ts';
import { syntheticDivisions } from './fixtures/synthetic.ts';
import { setup, word } from './helpers.ts';

const index = new DivisionIndex(syntheticDivisions());
const hizb5 = scopeIntervals({ type: 'division', kind: 'hizb', number: 5 }, index);
const cfg = (o: Partial<RepeatConfig> = {}): RepeatConfig => ({ ayahRepeat: 5, groupRepeat: 1, playlistRepeat: 1, repeatContext: false, pauseBetweenRepetitionsMs: 2000, pauseBetweenAyatMs: 3000, playbackRate: 1, ...o });
const key = (i: number) => {
  const r = fromIndex(i);
  return `${r.surah}:${r.ayah}`;
};

async function scenario() {
  const ctx = setup();
  const m = ctx.mistakes;
  // Marked in a deliberately scrambled order.
  await m.markAyah({ surah: 3, ayah: 7 }, { category: 'similar_ayah' });
  await m.markWord({ surah: 2, ayah: 255 }, word(5), { category: 'forgotten' });
  await m.markWord({ surah: 2, ayah: 255 }, word(2), { category: 'incorrect_word' });
  await m.markAyah({ surah: 18, ayah: 28 }, { category: 'forgotten' }); // outside Hizb 5
  await m.markAyah({ surah: 2, ayah: 260 }, { category: 'hesitation' });
  const resolved = await m.markAyah({ surah: 2, ayah: 270 }, { category: 'other' });
  await m.resolve(resolved.mistake.id);
  return { ...ctx, list: await m.list() };
}

describe('mistake playlist generation', () => {
  it('includes only unresolved mistakes inside the scope, in Quran order, one entry per ayah', async () => {
    const { list } = await scenario();
    const p = buildMistakePlaylist(list, hizb5);
    const items = p.groups.flatMap((g) => g.items);
    assert.deepEqual(items.map((i) => key(i.globalIndex)), ['2:255', '2:260', '3:7']);
    assert.equal(p.excludedOutOfScope, 1);
    assert.equal(p.mistakeCount, 4);
    assert.deepEqual(p.mistakeAyahIndexes, [262, 267, toIndex({ surah: 3, ayah: 7 })]);
  });

  it('groups multiple marked words of one ayah into a single item by default', async () => {
    const { list } = await scenario();
    const item = buildMistakePlaylist(list, hizb5).groups[0]?.items[0];
    assert.equal(item?.mistakeIds.length, 2);
    assert.deepEqual(item?.words.map((w) => w.position), [2, 5]);
    assert.deepEqual([...(item?.categories ?? [])].sort(), ['forgotten', 'incorrect_word']);
  });

  it('offers word-specific practice: one item per marked word', async () => {
    const { list } = await scenario();
    const p = buildMistakePlaylist(list, hizb5, { wordPractice: 'per_word' });
    const first = p.groups[0]?.items ?? [];
    assert.deepEqual(first.map((i) => i.focusWord?.position), [2, 5]);
  });

  it('adds neighbouring ayat only when requested, merging overlapping windows', async () => {
    const { list } = await scenario();
    assert.equal(buildMistakePlaylist(list, hizb5).contextAyahCount, 0);
    const p = buildMistakePlaylist(list, hizb5, { contextBefore: 1, contextAfter: 1 });
    const g = p.groups.map((x) => x.items.map((i) => `${key(i.globalIndex)}${i.role === 'context' ? '*' : ''}`));
    assert.deepEqual(g, [['2:254*', '2:255', '2:256*'], ['2:259*', '2:260', '2:261*'], ['3:6*', '3:7', '3:8*']]);
    const wide = buildMistakePlaylist(list, hizb5, { contextBefore: 3, contextAfter: 3 });
    assert.equal(wide.groups.length, 2, '2:255 and 2:260 windows overlap and merge');
  });

  it('keeps context within the surah unless allowed', async () => {
    const { mistakes } = setup();
    await mistakes.markAyah({ surah: 3, ayah: 1 }, { category: 'other' });
    const list = await mistakes.list();
    const p = buildMistakePlaylist(list, [{ start: 1, end: 6236 }], { contextBefore: 1 });
    assert.deepEqual(p.groups[0]?.items.map((i) => key(i.globalIndex)), ['3:1']);
    const across = buildMistakePlaylist(list, [{ start: 1, end: 6236 }], { contextBefore: 1, contextAcrossSurahs: true });
    assert.deepEqual(across.groups[0]?.items.map((i) => key(i.globalIndex)), ['2:286', '3:1']);
  });

  it('filters by category and can include resolved mistakes explicitly', async () => {
    const { list } = await scenario();
    assert.deepEqual(buildMistakePlaylist(list, hizb5, { categories: ['hesitation'] }).mistakeAyahIndexes, [267]);
    const withResolved = buildMistakePlaylist(list, hizb5, { statuses: ['resolved'] });
    assert.deepEqual(withResolved.mistakeAyahIndexes, [toIndex({ surah: 2, ayah: 270 })]);
  });

  it('handles an empty playlist', () => {
    const p = buildMistakePlaylist([], hizb5);
    assert.equal(p.groups.length, 0);
    assert.equal(playlistAyahCount(p), 0);
    assert.deepEqual(expandSequence(p, cfg()), []);
  });

  it('builds a full-portion playlist flagging ayat with mistakes', async () => {
    const { list } = await scenario();
    const p = buildPortionPlaylist(list, hizb5);
    assert.equal(playlistAyahCount(p), hizb5[0] ? hizb5[0].end - hizb5[0].start + 1 : 0);
    assert.deepEqual(p.mistakeAyahIndexes, [262, 267, toIndex({ surah: 3, ayah: 7 })]);
  });
});

describe('repetition sequence', () => {
  it('"5" means five total plays of each marked ayah', async () => {
    const { list } = await scenario();
    const steps = expandSequence(buildMistakePlaylist(list, hizb5), cfg({ ayahRepeat: 5 }));
    assert.equal(steps.length, 15);
    assert.deepEqual([...playsPerAyah(steps).values()], [5, 5, 5]);
    assert.deepEqual(steps.slice(0, 6).map((s) => `${key(s.item.globalIndex)}#${s.repetition}/${s.repetitions}`), ['2:255#1/5', '2:255#2/5', '2:255#3/5', '2:255#4/5', '2:255#5/5', '2:260#1/5']);
  });

  it('honours group and playlist repetition exactly, context played once unless configured', async () => {
    const { list } = await scenario();
    const p = buildMistakePlaylist(list, hizb5, { contextBefore: 1, contextAfter: 1 });
    const steps = expandSequence(p, cfg({ ayahRepeat: 3, groupRepeat: 2, playlistRepeat: 2 }));
    const plays = playsPerAyah(steps);
    assert.equal(plays.get(262), 3 * 2 * 2);
    assert.equal(plays.get(261), 1 * 2 * 2);
    const both = playsPerAyah(expandSequence(p, cfg({ ayahRepeat: 3, groupRepeat: 2, playlistRepeat: 2, repeatContext: true })));
    assert.equal(both.get(261), 12);
    // Group pass order: [2:254, 2:255×3, 2:256] twice, then the next group.
    assert.deepEqual(steps.slice(0, 10).map((s) => key(s.item.globalIndex)), ['2:254', '2:255', '2:255', '2:255', '2:256', '2:254', '2:255', '2:255', '2:255', '2:256']);
  });

  it('applies the right pause after each step', async () => {
    const { list } = await scenario();
    const steps = expandSequence(buildMistakePlaylist(list, hizb5), cfg({ ayahRepeat: 2 }));
    assert.deepEqual(steps.map((s) => s.pauseAfterMs), [2000, 3000, 2000, 3000, 2000, 0]);
  });

  it('rejects ambiguous or invalid configuration', () => {
    const p = buildMistakePlaylist([], hizb5);
    assert.throws(() => expandSequence(p, cfg({ ayahRepeat: 0 })), RepeatConfigError);
    assert.throws(() => expandSequence(p, cfg({ ayahRepeat: 2.5 })), RepeatConfigError);
    assert.throws(() => expandSequence(p, cfg({ playbackRate: 3 })), RepeatConfigError);
  });

  it('combined revision: mistakes first, then the portion', async () => {
    const { list } = await scenario();
    const quarter = scopeIntervals({ type: 'range', start: { surah: 2, ayah: 253 }, end: { surah: 2, ayah: 256 } }, index);
    const a = expandSequence(buildMistakePlaylist(list, quarter), cfg({ ayahRepeat: 2 }));
    const b = expandSequence(buildPortionPlaylist(list, quarter), cfg({ ayahRepeat: 1 }));
    const all = concatSequences([{ steps: a, config: cfg() }, { steps: b, config: cfg() }]);
    assert.deepEqual(all.map((s) => `${s.phase}:${key(s.item.globalIndex)}`), ['mistakes:2:255', 'mistakes:2:255', 'portion:2:253', 'portion:2:254', 'portion:2:255', 'portion:2:256']);
    assert.deepEqual(all.map((s) => s.stepIndex), [0, 1, 2, 3, 4, 5]);
    assert.equal(all[1]?.pauseAfterMs, 3000);
    assert.equal(all.at(-1)?.pauseAfterMs, 0);
  });

  it('estimates duration and labels nothing as exact', async () => {
    const { list } = await scenario();
    const steps = expandSequence(buildMistakePlaylist(list, hizb5), cfg({ ayahRepeat: 1, pauseBetweenAyatMs: 1000 }));
    assert.equal(estimateDurationMs(steps, 1, null), 3 * 12_000 + 2 * 1000);
    assert.equal(estimateDurationMs(steps, 2, () => 8), 3 * 3000 + 2 * 1000);
  });
});
