import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldNotify, buildIcs } from '../src/browser/reminders.ts';
import { DivisionIndex } from '../src/core/quran/divisions.ts';
import { buildSession, type SessionConfig } from '../src/core/session/sessionBuilder.ts';
import { DEFAULT_REPEAT } from '../src/core/settings/preferences.ts';
import { syntheticDivisions } from './fixtures/synthetic.ts';
import { setup } from './helpers.ts';

const index = new DivisionIndex(syntheticDivisions());
const base: SessionConfig = {
  mode: 'mistakes',
  scope: { type: 'range', start: { surah: 2, ayah: 253 }, end: { surah: 2, ayah: 257 } },
  planId: null,
  label: 'test',
  options: {},
  repeat: { ...DEFAULT_REPEAT, ayahRepeat: 2 },
  portionAyahRepeat: 1,
  reciterId: 'r',
};

describe('session builder', () => {
  it('builds mistakes, full and combined sessions from the same scope', async () => {
    const { mistakes } = setup();
    await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other' });
    await mistakes.markAyah({ surah: 2, ayah: 260 }, { category: 'other' }); // 2:260 outside the range
    const list = await mistakes.list();
    const m = buildSession(base, list, index);
    assert.equal(m.steps.length, 2);
    assert.deepEqual(m.mistakeAyahIndexes, [262]);
    const f = buildSession({ ...base, mode: 'full' }, list, index);
    assert.equal(f.steps.length, 5);
    assert.ok(f.steps.every((s) => s.phase === 'portion' && s.repetitions === 1));
    const c = buildSession({ ...base, mode: 'combined' }, list, index);
    assert.deepEqual(c.steps.map((s) => s.phase), ['mistakes', 'mistakes', 'portion', 'portion', 'portion', 'portion', 'portion']);
  });
  it('an empty mistakes session has no steps', () => {
    assert.equal(buildSession(base, [], index).steps.length, 0);
  });
});

describe('reminders', () => {
  const c = { enabled: true, time: '07:30', todayCompleted: false, lastNotifiedDate: null, today: '2026-03-01', now: new Date(2026, 2, 1, 7, 45) };
  it('notifies once per day after the chosen time if revision is not complete', () => {
    assert.equal(shouldNotify(c), true);
    assert.equal(shouldNotify({ ...c, now: new Date(2026, 2, 1, 7, 0) }), false);
    assert.equal(shouldNotify({ ...c, todayCompleted: true }), false);
    assert.equal(shouldNotify({ ...c, lastNotifiedDate: '2026-03-01' }), false);
    assert.equal(shouldNotify({ ...c, enabled: false }), false);
  });
  it('builds a daily recurring calendar event with an alarm', () => {
    const ics = buildIcs('07:30', 'Quran revision', new Date(2026, 2, 1, 6), 'https://example.test/');
    assert.match(ics, /RRULE:FREQ=DAILY/);
    assert.match(ics, /DTSTART:20260301T073000/);
    assert.match(ics, /BEGIN:VALARM/);
  });
});
