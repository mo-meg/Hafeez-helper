import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampSpeed, minutesLeft, nextPortion, portionQuery, pxPerSecond, SPEED_DEFAULT, SPEED_MAX, SPEED_MIN } from '../src/core/reading/autoScroll.ts';
import { getLocale, setLocale, t, tn } from '../src/ui/i18n/index.ts';

const counts = { juz: 30, hizb: 60, quarter: 240, eighth: 0, page: 604 } as const;
const count = (k: keyof typeof counts) => counts[k];

describe('auto scroll speed', () => {
  it('clamps levels to the supported range and defaults invalid input', () => {
    assert.equal(clampSpeed(0), SPEED_MIN);
    assert.equal(clampSpeed(99), SPEED_MAX);
    assert.equal(clampSpeed(12.4), 12);
    assert.equal(clampSpeed('fast'), SPEED_DEFAULT);
    assert.equal(clampSpeed(Number.NaN), SPEED_DEFAULT);
  });

  it('grows linearly with the level and with the Quran font scale', () => {
    assert.equal(pxPerSecond(10), 2 * pxPerSecond(5));
    assert.equal(pxPerSecond(10, 1.5), 1.5 * pxPerSecond(10));
    assert.equal(pxPerSecond(10, 0), pxPerSecond(10), 'invalid scale falls back to 1');
    assert.equal(pxPerSecond(500), pxPerSecond(SPEED_MAX));
  });

  it('rounds the remaining time up to whole minutes', () => {
    assert.equal(minutesLeft(0, 20), 0);
    assert.equal(minutesLeft(1, 20), 1);
    assert.equal(minutesLeft(20 * 60, 20), 1);
    assert.equal(minutesLeft(20 * 60 + 1, 20), 2);
    assert.equal(minutesLeft(1000, 0), 0);
  });
});

describe('auto scroll: next portion at the end', () => {
  it('moves to the next surah, and stops after An-Nas', () => {
    assert.deepEqual(nextPortion({ division: null, surah: 2 }, count), { kind: 'surah', number: 3 });
    assert.equal(nextPortion({ division: null, surah: 114 }, count), null);
  });

  it('moves to the next division of the same kind, and stops after the last one', () => {
    assert.deepEqual(nextPortion({ division: { kind: 'hizb', number: 5 }, surah: null }, count), { kind: 'hizb', number: 6 });
    assert.equal(nextPortion({ division: { kind: 'juz', number: 30 }, surah: null }, count), null);
    assert.equal(portionQuery({ kind: 'quarter', number: 7 }), 'quarter=7');
  });
});

describe('auto scroll bar text', () => {
  it('reads "26 minutes | 15" in English and uses Arabic plural forms', () => {
    const prev = getLocale();
    try {
      setLocale('en');
      assert.equal(t('auto.status', { time: tn('auto.minutes', 26), speed: 15 }), '26 minutes | 15');
      assert.equal(tn('auto.minutes', 1), '1 minute');
      setLocale('ar');
      assert.equal(tn('auto.minutes', 2), 'دقيقتان');
      assert.ok(tn('auto.minutes', 5).includes('دقائق'));
    } finally {
      setLocale(prev);
    }
  });
});
