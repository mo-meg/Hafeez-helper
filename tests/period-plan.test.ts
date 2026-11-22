import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RepeatConfig } from '../src/core/model.ts';
import { PlanService } from '../src/core/plan/planService.ts';
import { expandTemplate, makePeriodPlan, periodDates, periodProgress, type WeekTemplate } from '../src/core/plan/periodPlan.ts';
import { DivisionIndex } from '../src/core/quran/divisions.ts';
import { divisionRangeScope, divisionSpan, scopeAyahCount, scopeIntervals, type RevisionScope } from '../src/core/quran/scope.ts';
import { DEFAULT_PREFERENCES, normalizePreferences } from '../src/core/settings/preferences.ts';
import { syntheticDivisions } from './fixtures/synthetic.ts';
import { setup, word } from './helpers.ts';

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

  it('tracks each day in two steps: mistakes, then recitation; catch-up, manual marks', async () => {
    // Mon Hizb 2–3, Tue Hizb 4, Wed Hizb 5, Thu Hizb 6, Fri rest, Sat Hizb 1–6, Sun rest.
    const { plans, store, clock, mistakes } = setup('2026-03-02T09:00:00');
    const plan = makePeriodPlan('week', '2026-03-02');
    const template: WeekTemplate = [divisionRangeScope('hizb', 2, 3, index), hizb(4), hizb(5), hizb(6), null, divisionRangeScope('hizb', 1, 6, index), null];
    await plans.applySchedule(expandTemplate(plan, template));
    assert.equal((await store.plans.getAll()).length, 5, 'rest days have no revision plan');
    const progress = async () => periodProgress({ plan, dailyPlans: await store.plans.getAll(), sessions: await store.sessions.getAll(), reviews: await store.reviews.getAll(), mistakes: await store.mistakes.getAll(), index, now: clock.now() });

    // Monday: no mistakes in Hizb 2–3 (step 1 has nothing to do); listen to all of it.
    const mon = await plans.startSession({ planId: null, mode: 'full', scope: template[0] as RevisionScope, reciterId: 'r', repeat, mistakeAyahIndexes: [], plannedSteps: 0 });
    for (const g of ayatOf(template[0] as RevisionScope)) await plans.recordPlayback(mon.id, g);
    // Wednesday: a mistake in Hizb 5 (2:255), half of Hizb 5 listened to.
    clock.set('2026-03-04T10:00:00');
    await mistakes.markWord({ surah: 2, ayah: 255 }, word(1), { category: 'forgotten' });
    const wed = await plans.startSession({ planId: null, mode: 'full', scope: hizb(5), reciterId: 'r', repeat, mistakeAyahIndexes: [], plannedSteps: 0 });
    const h5 = ayatOf(hizb(5));
    for (const g of h5.slice(0, h5.length / 2)) await plans.recordPlayback(wed.id, g);

    let p = await progress();
    assert.deepEqual(p.days.map((d) => d.status), ['done', 'missed', 'today', 'upcoming', 'rest', 'upcoming', 'rest']);
    assert.equal(p.days[0]?.check.nothingToCheck, true);
    assert.equal(p.days[0]?.check.fraction, 1);
    assert.deepEqual([p.today?.check.covered, p.today?.check.total], [0, 1]);
    assert.equal(p.today?.recite.fraction, 0.5);
    assert.deepEqual([p.revisionDays, p.doneDays, p.missedDays, p.daysLeft, p.next?.date], [5, 1, 1, 5, '2026-03-05']);
    // Saturday counts only what was revised from Saturday on, even though Hizb 2–3 was heard on Monday.
    assert.equal(p.days[5]?.recite.covered, 0);
    // Listening in full does not revise the mistakes; Monday's mistake-free day does not gain the new one.
    assert.equal(p.days[0]?.check.total, 0);

    // Step 1 by a test answer, step 2 by "I recited it" (e.g. read from the mushaf).
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'correct_easy', { sessionId: 't1', repetitions: 1 });
    await plans.markDay(PlanService.planId('2026-03-04', 'revision'), 'recited', true);
    p = await progress();
    assert.deepEqual([p.today?.check.fraction, p.today?.recite.fraction, p.today?.recite.marked, p.today?.status], [1, 1, true, 'done']);

    // Catching up Tuesday's Hizb 4 by listening on Wednesday completes Tuesday.
    for (const g of ayatOf(hizb(4))) await plans.recordPlayback(wed.id, g);
    p = await progress();
    assert.equal(p.days[1]?.status, 'done');
    assert.equal(p.missedDays, 0);

    // "Mark the whole day as done", then undo.
    const thu = PlanService.planId('2026-03-05', 'revision');
    clock.set('2026-03-05T20:00:00');
    await plans.markDay(thu, 'done', true);
    p = await progress();
    assert.deepEqual([p.today?.status, p.today?.check.fraction, p.today?.recite.fraction], ['done', 1, 1]);
    await plans.markDay(thu, 'done', false);
    assert.equal((await progress()).today?.status, 'today');
    // Changing a day's portion clears its manual marks; keeping it keeps them.
    await plans.applySchedule([{ date: '2026-03-04', scope: hizb(5) }]);
    assert.ok((await plans.getPlan('2026-03-04'))?.markedRecitedAt);
    await plans.applySchedule([{ date: '2026-03-04', scope: hizb(7) }]);
    assert.equal((await plans.getPlan('2026-03-04'))?.markedRecitedAt, undefined);
    // Step 1 average: only days with mistakes to revise (now just Saturday's Hizb 1–6, not yet done);
    // step 2 average: all 5 revision days.
    p = await progress();
    assert.equal(p.checkFraction, 0);
    assert.ok(p.reciteFraction > 0 && p.reciteFraction < 1);

    clock.set('2026-03-09T09:00:00');
    const over = await progress();
    assert.equal(over.finished, true);
    assert.equal(over.today, null);
  });

  it('writing a mistake ayah from memory revises it for the day but never touches the mistake', async () => {
    const { plans, store, clock, mistakes } = setup('2026-03-02T09:00:00');
    const plan = makePeriodPlan('week', '2026-03-02');
    await plans.applySchedule([{ date: '2026-03-02', scope: hizb(5) }]);
    const { mistake: m } = await mistakes.markWord({ surah: 2, ayah: 255 }, word(1), { category: 'forgotten' });
    const g = m.globalIndex;
    const progress = async () => periodProgress({ plan, dailyPlans: await store.plans.getAll(), sessions: await store.sessions.getAll(), reviews: await store.reviews.getAll(), mistakes: await store.mistakes.getAll(), index, now: clock.now() });
    assert.deepEqual([(await progress()).today?.check.covered, (await progress()).today?.check.total], [0, 1]);
    const s = await plans.startSession({ planId: null, mode: 'write', scope: hizb(5), reciterId: 'r', repeat, mistakeAyahIndexes: [g], plannedSteps: 1 });
    const after = await plans.recordWritten(s.id, g);
    assert.equal((await plans.recordWritten(s.id, g)).completedSteps, 1, 'writing the same ayah twice counts once');
    assert.deepEqual(after.playedAyahIndexes, [g]);
    assert.equal((await progress()).today?.check.fraction, 1);
    assert.equal((await progress()).today?.recite.covered, 0, 'writing is not listening to the portion');
    const stored = (await store.mistakes.getAll()).find((x) => x.id === m.id);
    assert.equal(stored?.status, m.status, 'status unchanged');
    assert.equal((await store.reviews.getAll()).length, 0, 'no review recorded');
  });

  it('ignores demo records', () => {
    const plan = makePeriodPlan('week', '2026-03-02');
    const dp = { id: 'p', date: '2026-03-02', kind: 'revision' as const, scope: hizb(1), status: 'pending' as const, sessionIds: [], createdAt: '', updatedAt: '', completedAt: null };
    const g = ayatOf(hizb(1))[0] as number;
    const m = { id: 'm', globalIndex: g, status: 'new', createdAt: '2026-03-01T10:00:00', resolvedAt: null } as never;
    const review = { globalIndex: g, at: '2026-03-02T10:00:00' } as never;
    const now = new Date('2026-03-02T12:00:00');
    const run = (mistakes: never[], reviews: never[]) => periodProgress({ plan, dailyPlans: [dp], sessions: [], reviews, mistakes, index, now }).days[0]?.check;
    assert.deepEqual([run([m], [review])?.covered, run([m], [review])?.total], [1, 1]);
    assert.equal(run([m], [{ ...(review as object), demo: true } as never])?.covered, 0);
    assert.equal(run([{ ...(m as object), demo: true } as never], [])?.nothingToCheck, true);
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
