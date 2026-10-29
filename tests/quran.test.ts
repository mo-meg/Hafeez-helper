import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VERIFIED_JUZ_STARTS } from '../src/core/quran/anchors.ts';
import { ANCHOR_ONLY_DATASET, DivisionIndex, DivisionUnavailableError, type DivisionDataset } from '../src/core/quran/divisions.ts';
import { validateDivisionDataset } from '../src/core/quran/divisionValidation.ts';
import { compareRefs, formatRef, fromIndex, isValidRef, nextRef, parseRef, prevRef, sortByQuranOrder, toIndex } from '../src/core/quran/refs.ts';
import { describeScope, scopeAyahCount, scopeContains, scopeIntervals } from '../src/core/quran/scope.ts';
import { SURAHS, TOTAL_AYAT } from '../src/core/quran/surahs.ts';
import { syntheticDivisions } from './fixtures/synthetic.ts';

describe('surah metadata', () => {
  it('has 114 surahs totalling 6236 ayat (Hafs/Kufan count)', () => {
    assert.equal(SURAHS.length, 114);
    assert.equal(SURAHS.reduce((n, s) => n + s.ayahCount, 0), TOTAL_AYAT);
    assert.equal(SURAHS[1]?.ayahCount, 286);
    assert.equal(SURAHS[113]?.ayahCount, 6);
  });
});

describe('ayah references and canonical order', () => {
  it('maps references to global indexes and back for every ayah', () => {
    for (let i = 1; i <= TOTAL_AYAT; i++) assert.equal(toIndex(fromIndex(i)), i);
  });
  it('knows well-known global numbers', () => {
    assert.equal(toIndex({ surah: 1, ayah: 1 }), 1);
    assert.equal(toIndex({ surah: 2, ayah: 1 }), 8);
    assert.equal(toIndex({ surah: 2, ayah: 255 }), 262); // Ayat al-Kursi
    assert.equal(toIndex({ surah: 114, ayah: 6 }), 6236);
  });
  it('rejects invalid references', () => {
    assert.equal(isValidRef({ surah: 1, ayah: 8 }), false);
    assert.equal(isValidRef({ surah: 115, ayah: 1 }), false);
    assert.equal(isValidRef({ surah: 2, ayah: 0 }), false);
    assert.throws(() => toIndex({ surah: 9, ayah: 130 }), RangeError);
    assert.throws(() => fromIndex(6237), RangeError);
  });
  it('navigates across surah boundaries', () => {
    assert.deepEqual(nextRef({ surah: 1, ayah: 7 }), { surah: 2, ayah: 1 });
    assert.deepEqual(prevRef({ surah: 2, ayah: 1 }), { surah: 1, ayah: 7 });
    assert.deepEqual(nextRef({ surah: 2, ayah: 286 }), { surah: 3, ayah: 1 });
    assert.equal(nextRef({ surah: 114, ayah: 6 }), null);
    assert.equal(prevRef({ surah: 1, ayah: 1 }), null);
  });
  it('sorts in canonical Quran order, not lexical order', () => {
    const refs = [{ surah: 10, ayah: 1 }, { surah: 2, ayah: 30 }, { surah: 2, ayah: 4 }, { surah: 1, ayah: 7 }];
    assert.deepEqual(sortByQuranOrder(refs, (r) => r), [{ surah: 1, ayah: 7 }, { surah: 2, ayah: 4 }, { surah: 2, ayah: 30 }, { surah: 10, ayah: 1 }]);
    assert.ok(compareRefs({ surah: 2, ayah: 10 }, { surah: 2, ayah: 9 }) > 0);
  });
  it('parses user-typed references', () => {
    assert.deepEqual(parseRef(' 2:255 '), { surah: 2, ayah: 255 });
    assert.deepEqual(parseRef('3.7'), { surah: 3, ayah: 7 });
    assert.equal(parseRef('2:287'), null);
    assert.equal(parseRef('abc'), null);
    assert.equal(formatRef({ surah: 2, ayah: 255 }), 'Al-Baqarah 2:255');
  });
});

describe('verified division anchors', () => {
  const idx = new DivisionIndex(ANCHOR_ONLY_DATASET);
  it('provides juz boundaries from verified anchors', () => {
    assert.equal(idx.count('juz'), 30);
    // Juz 3: 2:253 – 3:92 (sources: learnreligions, quran411; ends one ayah before Juz 4 at 3:93)
    const j3 = idx.range('juz', 3);
    assert.deepEqual([j3.start, j3.end], [{ surah: 2, ayah: 253 }, { surah: 3, ayah: 92 }]);
    const j30 = idx.range('juz', 30);
    assert.deepEqual([j30.start, j30.end], [{ surah: 78, ayah: 1 }, { surah: 114, ayah: 6 }]);
  });
  it('reports hizb/quarter as unavailable instead of guessing', () => {
    assert.throws(() => idx.range('hizb', 5), DivisionUnavailableError);
    assert.equal(idx.locate({ surah: 2, ayah: 255 }).hizb, null);
    assert.equal(idx.locate({ surah: 2, ayah: 255 }).juz, 3);
  });
  it('the anchor-only dataset itself validates', () => {
    assert.equal(validateDivisionDataset(ANCHOR_ONLY_DATASET).ok, true);
  });
});

describe('hizb, quarter and eighth navigation (index logic)', () => {
  const ds = syntheticDivisions({ withEighths: true });
  const idx = new DivisionIndex(ds);
  it('Hizb 5 spans 2:253 – 3:14 (verified: Wikipedia Juz\' table)', () => {
    const h5 = idx.range('hizb', 5);
    assert.deepEqual(h5.start, { surah: 2, ayah: 253 });
    assert.deepEqual(h5.end, { surah: 3, ayah: 14 });
  });
  it('Hizb boundaries cross surah boundaries correctly (Hizb 8 ends at 4:23)', () => {
    assert.deepEqual(idx.range('hizb', 8).end, { surah: 4, ayah: 23 });
    assert.deepEqual(idx.range('hizb', 1).start, { surah: 1, ayah: 1 });
  });
  it('quarters tile each hizb exactly, in order, without gaps or overlaps', () => {
    for (let h = 1; h <= 60; h++) {
      const hizb = idx.range('hizb', h);
      const qs = idx.children(hizb, 'quarter');
      assert.equal(qs.length, 4, `hizb ${h}`);
      assert.equal(qs[0]?.startIndex, hizb.startIndex);
      assert.equal(qs[3]?.endIndex, hizb.endIndex);
      for (let i = 1; i < 4; i++) assert.equal(qs[i]?.startIndex, (qs[i - 1]?.endIndex ?? 0) + 1);
    }
  });
  it('eighths tile each quarter exactly', () => {
    for (let q = 1; q <= 240; q++) {
      const quarter = idx.range('quarter', q);
      const es = idx.children(quarter, 'eighth');
      assert.equal(es.length, 2, `quarter ${q}`);
      assert.equal(es[0]?.startIndex, quarter.startIndex);
      assert.equal(es[1]?.endIndex, quarter.endIndex);
    }
  });
  it('locates an ayah in every division system', () => {
    const loc = idx.locate({ surah: 2, ayah: 253 });
    assert.equal(loc.juz, 3);
    assert.equal(loc.hizb, 5);
    assert.equal(loc.quarter, 17);
    assert.equal(loc.quarterInHizb, 1);
    assert.equal(loc.eighthInHizb, 1);
    assert.equal(idx.locate({ surah: 3, ayah: 14 }).hizb, 5);
    assert.equal(idx.locate({ surah: 3, ayah: 15 }).hizb, 6);
  });
  it('rejects division numbers out of range', () => {
    assert.throws(() => idx.range('hizb', 61), RangeError);
    assert.throws(() => idx.range('quarter', 0), RangeError);
  });
});

describe('division dataset validation', () => {
  const good = syntheticDivisions();
  it('accepts a structurally valid dataset that matches the anchors', () => {
    assert.deepEqual(validateDivisionDataset(good).errors, []);
  });
  it('rejects the Juz 4 = 3:92 convention for this edition', () => {
    const juz = VERIFIED_JUZ_STARTS.map((p) => [...p] as [number, number]);
    juz[3] = [3, 92];
    const res = validateDivisionDataset({ ...good, juzStarts: juz, quarterStarts: undefined } as DivisionDataset);
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /Juz 4/);
  });
  it('rejects quarters that disagree with a verified hizb anchor', () => {
    const qs = (good.quarterStarts ?? []).map((p) => [...p] as [number, number]);
    qs[16] = [2, 252]; // Hizb 5 must start at 2:253
    const res = validateDivisionDataset({ ...good, quarterStarts: qs });
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /Hizb 5/);
  });
  it('rejects wrong counts and non-increasing lists', () => {
    assert.equal(validateDivisionDataset({ ...good, quarterStarts: good.quarterStarts?.slice(1) }).ok, false);
    const qs = (good.quarterStarts ?? []).map((p) => [...p] as [number, number]);
    qs[100] = qs[99] as [number, number];
    assert.equal(validateDivisionDataset({ ...good, quarterStarts: qs }).ok, false);
  });
  it('rejects eighths whose odd entries do not coincide with quarter starts', () => {
    const withE = syntheticDivisions({ withEighths: true });
    const es = (withE.eighthStarts ?? []).map((p) => [...p] as [number, number]);
    es[2] = es[3] as [number, number];
    es[3] = [es[3]?.[0] ?? 2, (es[3]?.[1] ?? 1) + 1];
    const res = validateDivisionDataset({ ...withE, eighthStarts: es });
    assert.equal(res.ok, false);
  });
});

describe('revision scopes', () => {
  const idx = new DivisionIndex(syntheticDivisions());
  it('resolves a hizb scope to its verified interval', () => {
    const iv = scopeIntervals({ type: 'division', kind: 'hizb', number: 5 }, idx);
    assert.deepEqual(iv, [{ start: toIndex({ surah: 2, ayah: 253 }), end: toIndex({ surah: 3, ayah: 14 }) }]);
    assert.equal(describeScope({ type: 'division', kind: 'quarter', number: 18 }, idx), 'Quarter 18 (Hizb 5, 2/4)');
  });
  it('merges selected surahs and supports reversed ranges', () => {
    const iv = scopeIntervals({ type: 'surahs', surahs: [3, 2, 3] }, idx);
    assert.equal(iv.length, 1);
    assert.equal(scopeAyahCount(iv), 486);
    const r = scopeIntervals({ type: 'range', start: { surah: 2, ayah: 10 }, end: { surah: 2, ayah: 5 } }, idx);
    assert.equal(scopeAyahCount(r), 6);
    assert.equal(scopeContains(r, toIndex({ surah: 2, ayah: 7 })), true);
  });
});
