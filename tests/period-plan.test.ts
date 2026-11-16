import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RepeatConfig } from '../src/core/model.ts';
import { expandTemplate, makePeriodPlan, periodDates, periodProgress, type WeekTemplate } from '../src/core/plan/periodPlan.ts';
import { DivisionIndex } from '../src/core/quran/divisions.ts';
import { divisionRangeScope, divisionSpan, scopeAyahCount, scopeIntervals, type RevisionScope } from '../src/core/quran/scope.ts';
import { DEFAULT_PREFERENCES, normalizePreferences } from '../src/core/settings/preferences.ts';
import { syntheticDivisions } from './fixtures/synthetic.ts';
import { setup } from './helpers.ts';

const index = new DivisionIndex(syntheticDivisions());
const repeat: RepeatConfig = { ayahRepeat: 1, groupRepeat: 1, playlistRepeat: 1, repeatContext: false, pauseBetweenRepetitionsMs: 0, pauseBetweenAyatMs: 0, playbackRate: 1 };
const hizb = (n: number): RevisionScope => ({ type: 'division', kind: 'hizb', number: n });
const ayatOf = (s: RevisionScope) => scopeIntervals(s, index).flatMap((iv) => Array.from({ length: iv.end - iv.start + 1 }, (_, i) => iv.start + i));

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

describe('week / month revision plan', () => {
  it('a week is 7 days; a month ends the day before the same date next month', () => {
    assert.deepEqual(makePeriodPlan('week', '2026-01-31'), { period: 'week', start: '2026-01-31', end: '2026-02-06' });
    assert.equal(makePeriodPlan('month', '2026-03-05').end, '2026-04-04');
    assert.equal(periodDates(makePeriodPlan('month', '2026-02-01')).length, 28);
  });

  it('repeats the weekly pattern over a month', () => {
    const template: WeekTemplate = [hizb(1), null, null, null, null, null, null];
    const days = expandTemplate(makePeriodPlan('month', '2026-03-02'), template);
    assert.deepEqual(days.filter((d) => d.scope).map((d) => d.date), ['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23', '2026-03-30']);
  });

  it('tracks each day: done, missed, caught up, today, upcoming, rest', async () => {
    // Mon Hizb 2–3, Tue Hizb 4, Wed Hizb 5, Thu Hizb 6, Fri rest, Sat Hizb 1–6, Sun rest.
    const { plans, store, clock } = setup('2026-03-02T09:00:00');
    const plan = makePeriodPlan('week', '2026-03-02');
    const template: WeekTemplate = [divisionRangeScope('hizb', 2, 3, index), hizb(4), hizb(5), hizb(6), null, divisionRangeScope('hizb', 1, 6, index), null];
    await plans.applySchedule(expandTemplate(plan, template));
    assert.equal((await store.plans.getAll()).length, 5, 'rest days have no revision plan');

    // Monday: listen to all of Hizb 2–3.
    const mon = await plans.startSession({ planId: null, mode: 'full', scope: template[0] as RevisionScope, reciterId: 'r', repeat, mistakeAyahIndexes: [], plannedSteps: 0 });
    for (const g of ayatOf(template[0] as RevisionScope)) await plans.recordPlayback(mon.id, g);
    // Tuesday: nothing. Wednesday: half of Hizb 5 so far.
    clock.set('2026-03-04T10:00:00');
    const wed = await plans.startSession({ planId: null, mode: 'full', scope: hizb(5), reciterId: 'r', repeat, mistakeAyahIndexes: [], plannedSteps: 0 });
    const h5 = ayatOf(hizb(5));
    for (const g of h5.slice(0, h5.length / 2)) await plans.recordPlayback(wed.id, g);

    const p = periodProgress(plan, await store.plans.getAll(), await store.sessions.getAll(), [], index, clock.now());
    assert.deepEqual(p.days.map((d) => d.status), ['done', 'missed', 'today', 'upcoming', 'rest', 'upcoming', 'rest']);
    assert.equal(p.today?.fraction, 0.5);
    assert.equal(p.revisionDays, 5);
    assert.equal(p.doneDays, 1);
    assert.equal(p.missedDays, 1);
    assert.equal(p.next?.date, '2026-03-05');
    assert.equal(p.daysLeft, 5);
    // Saturday counts only what was revised from Saturday on, even though Hizb 2–3 was heard on Monday.
    assert.equal(p.days[5]?.coveredAyat, 0);

    // Catching up Tuesday's Hizb 4 on Wednesday completes Tuesday.
    for (const g of ayatOf(hizb(4))) await plans.recordPlayback(wed.id, g);
    const q = periodProgress(plan, await store.plans.getAll(), await store.sessions.getAll(), [], index, clock.now());
    assert.equal(q.days[1]?.status, 'done');
    assert.equal(q.missedDays, 0);

    const over = periodProgress(plan, await store.plans.getAll(), await store.sessions.getAll(), [], index, new Date('2026-03-09T09:00:00'));
    assert.equal(over.finished, true);
    assert.equal(over.today, null);
  });

  it('counts recall answers and ignores demo records', () => {
    const plan = makePeriodPlan('week', '2026-03-02');
    const dp = { id: 'p', date: '2026-03-02', kind: 'revision' as const, scope: hizb(1), status: 'pending' as const, sessionIds: [], createdAt: '', updatedAt: '', completedAt: null };
    const g = ayatOf(hizb(1))[0] as number;
    const review = { id: 'r', mistakeId: 'm', sessionId: null, globalIndex: g, surah: 1, ayah: 1, at: '2026-03-02T10:00:00', outcome: 'correct_easy', assisted: false, repetitions: 1, durationMs: null, prevStatus: 'new', nextStatus: 'new' } as never;
    const now = new Date('2026-03-02T12:00:00');
    assert.equal(periodProgress(plan, [dp], [], [review], index, now).days[0]?.coveredAyat, 1);
    assert.equal(periodProgress(plan, [dp], [], [{ ...(review as object), demo: true } as never], index, now).days[0]?.coveredAyat, 0);
  });

  it('is stored in preferences, unset by default; bad data falls back to unset', () => {
    assert.equal(DEFAULT_PREFERENCES.periodPlan, null);
    assert.equal(normalizePreferences({}).periodPlan, null);
    const good = makePeriodPlan('month', '2026-03-01');
    assert.deepEqual(normalizePreferences({ periodPlan: good }).periodPlan, good);
    assert.equal(normalizePreferences({ periodPlan: { period: 'year' } }).periodPlan, null);
    assert.equal(normalizePreferences({ periodPlan: { period: 'week', start: '2026-03-08', end: '2026-03-01' } }).periodPlan, null);
  });
});
