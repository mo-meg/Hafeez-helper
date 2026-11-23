import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DivisionIndex } from '../src/core/quran/divisions.ts';
import { divisionRangeScope, divisionSpan, scopeAyahCount, scopeIntervals, type RevisionScope } from '../src/core/quran/scope.ts';
import { DEFAULT_PREFERENCES, normalizePreferences } from '../src/core/settings/preferences.ts';
import { syntheticDivisions } from './fixtures/synthetic.ts';

// The week/month Period Plan was replaced by the Wird Planner (tests/wird.test.ts). Its preference
// is still read once to migrate an unfinished plan.
const index = new DivisionIndex(syntheticDivisions());
const hizb = (n: number): RevisionScope => ({ type: 'division', kind: 'hizb', number: n });

describe('division spans', () => {
  it('turns Hizb 2 to 3 into an ayah range and recognizes it again', () => {
    const s = divisionRangeScope('hizb', 2, 3, index);
    assert.equal(s.type, 'range');
    assert.deepEqual(divisionSpan(s, index), { kind: 'hizb', from: 2, to: 3 });
    assert.equal(scopeAyahCount(scopeIntervals(s, index)), scopeAyahCount(scopeIntervals(hizb(2), index)) + scopeAyahCount(scopeIntervals(hizb(3), index)));
    assert.deepEqual(divisionRangeScope('hizb', 4, 4, index), hizb(4), 'a single division stays a division');
    assert.equal(divisionSpan({ type: 'range', start: { surah: 2, ayah: 3 }, end: { surah: 2, ayah: 9 } }, index), null);
  });
});


describe('legacy period plan preference', () => {
  it('is unset by default; bad data falls back to unset', () => {
    assert.equal(DEFAULT_PREFERENCES.periodPlan, null);
    assert.equal(normalizePreferences({}).periodPlan, null);
    const good = { period: 'month' as const, start: '2026-03-01', end: '2026-03-31' };
    assert.deepEqual(normalizePreferences({ periodPlan: good }).periodPlan, good);
    assert.equal(normalizePreferences({ periodPlan: { period: 'year' } }).periodPlan, null);
    assert.equal(normalizePreferences({ periodPlan: { period: 'week', start: '2026-03-08', end: '2026-03-01' } }).periodPlan, null);
  });
});
