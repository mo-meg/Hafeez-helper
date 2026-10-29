import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyOutcome, shouldSuggestResolve } from '../src/core/review/policy.ts';
import { computeIntervalDays, effectiveDueDate, isDue } from '../src/core/review/scheduler.ts';
import { computeQuality } from '../src/core/review/scoring.ts';
import { toIndex } from '../src/core/quran/refs.ts';
import { setup } from './helpers.ts';

const base = { status: 'new' as const, successStreak: 0, lapseCount: 0, reopenCount: 0, lastStreakSessionId: null };

describe('review policy', () => {
  it('maps outcomes to statuses deterministically and never to "resolved"', () => {
    assert.equal(applyOutcome(base, 'mistake_again', 's').status, 'needs_practice');
    assert.equal(applyOutcome(base, 'needed_prompt', 's').status, 'needs_practice');
    assert.equal(applyOutcome(base, 'correct_difficult', 's').status, 'under_review');
    assert.equal(applyOutcome(base, 'correct_easy', 's').status, 'under_review');
    assert.equal(applyOutcome({ ...base, successStreak: 1, lastStreakSessionId: 'a' }, 'correct_easy', 'b').status, 'improved');
  });
  it('counts the success streak at most once per session', () => {
    const r = applyOutcome({ ...base, successStreak: 1, lastStreakSessionId: 's1' }, 'correct_easy', 's1');
    assert.equal(r.successStreak, 1);
    assert.equal(r.streakCounted, false);
  });
  it('a mistake on a resolved item reopens it', () => {
    const r = applyOutcome({ ...base, status: 'resolved' }, 'mistake_again', 's');
    assert.equal(r.status, 'reopened');
    assert.equal(r.reopenCount, 1);
    assert.equal(r.lapseCount, 1);
  });
  it('suggests (but does not perform) resolution after a streak', () => {
    assert.equal(shouldSuggestResolve('improved', 3), true);
    assert.equal(shouldSuggestResolve('improved', 2), false);
  });
});

describe('review scheduler', () => {
  const at = new Date('2026-03-10T00:00:00Z');
  const input = { outcome: 'correct_easy' as const, successStreak: 1, lapseCount: 0, severity: 1 as const, category: 'other' as const, difficulty: 'normal' as const, previousIntervalDays: 1, lastReviewedAt: '2026-03-09T00:00:00Z', reviewedAt: at };
  it('grows the interval with successive successes', () => {
    const days = [1, 2, 3, 4, 5].map((s) => computeIntervalDays({ ...input, successStreak: s }));
    assert.deepEqual(days, [2, 4, 7, 14, 30]);
  });
  it('resets after a repeated mistake', () => {
    assert.equal(computeIntervalDays({ ...input, outcome: 'mistake_again', successStreak: 0, lapseCount: 1 }), 1);
  });
  it('reviews severe, frequently repeated and similar-ayah mistakes more often', () => {
    const normal = computeIntervalDays({ ...input, successStreak: 4 });
    assert.ok(computeIntervalDays({ ...input, successStreak: 4, severity: 3 }) < normal);
    assert.ok(computeIntervalDays({ ...input, successStreak: 4, lapseCount: 3 }) < normal);
    assert.ok(computeIntervalDays({ ...input, successStreak: 4, category: 'similar_ayah' }) < normal);
    assert.ok(computeIntervalDays({ ...input, successStreak: 4, difficulty: 'harder' }) < normal);
    assert.ok(computeIntervalDays({ ...input, successStreak: 4, difficulty: 'easier' }) > normal);
  });
  it('rewards a successful recall after a longer gap (capped)', () => {
    const onTime = computeIntervalDays({ ...input, successStreak: 3, previousIntervalDays: 4, lastReviewedAt: '2026-03-06T00:00:00Z' });
    const late = computeIntervalDays({ ...input, successStreak: 3, previousIntervalDays: 4, lastReviewedAt: '2026-02-20T00:00:00Z' });
    assert.equal(onTime, 7);
    assert.equal(late, Math.round(7 * 1.5));
  });
  it('a manual override takes precedence for the due date; resolved mistakes are never due', async () => {
    const { mistakes, clock } = setup();
    const { mistake } = await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other' });
    assert.equal(isDue(mistake, clock.now()), true, 'new mistakes are due immediately');
    const o = await mistakes.overrideSchedule(mistake.id, '2026-05-01T00:00:00.000Z');
    assert.equal(effectiveDueDate(o)?.toISOString(), '2026-05-01T00:00:00.000Z');
    assert.equal(isDue(o, clock.now()), false);
    const r = await mistakes.resolve(mistake.id);
    assert.equal(effectiveDueDate(r), null);
  });
});

describe('memorization quality score', () => {
  it('is null without mistakes (nothing is fabricated)', () => {
    assert.equal(computeQuality([], [], new Date()).score, null);
  });

  it('is unaffected by audio playback — only explicit recall outcomes count', async () => {
    const { mistakes, plans, store, clock } = setup();
    await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other' });
    const before = computeQuality(await store.mistakes.getAll(), await store.reviews.getAll(), clock.now()).score;
    const s = await plans.startSession({ planId: null, mode: 'mistakes', scope: { type: 'all' }, reciterId: 'x', repeat: { ayahRepeat: 5, groupRepeat: 1, playlistRepeat: 1, repeatContext: false, pauseBetweenRepetitionsMs: 0, pauseBetweenAyatMs: 0, playbackRate: 1 }, mistakeAyahIndexes: [262], plannedSteps: 50 });
    for (let i = 0; i < 50; i++) await plans.recordPlayback(s.id, 262);
    await plans.completeSession(s.id);
    const after = computeQuality(await store.mistakes.getAll(), await store.reviews.getAll(), clock.now()).score;
    assert.equal(before, 25);
    assert.equal(after, before);
  });

  it('review outcomes move the score in the expected direction', async () => {
    const { mistakes, store, clock } = setup();
    await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other' });
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'correct_easy', { sessionId: 's1', repetitions: 1 });
    const good = computeQuality(await store.mistakes.getAll(), await store.reviews.getAll(), clock.now());
    assert.equal(good.score, 100);
    clock.advanceDays(1);
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'mistake_again', { sessionId: 's2', repetitions: 1 });
    const worse = computeQuality(await store.mistakes.getAll(), await store.reviews.getAll(), clock.now());
    assert.ok((worse.score ?? 0) < 100);
    assert.equal(worse.outcomeCounts.mistake_again, 1);
  });

  it('counts only the last outcome per session (cannot be inflated by repeating within a sitting)', async () => {
    const { mistakes, store, clock } = setup();
    await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other' });
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'mistake_again', { sessionId: 'a', repetitions: 1 });
    for (let i = 0; i < 5; i++) {
      clock.advanceMs(60_000);
      await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'needed_prompt', { sessionId: 'b', repetitions: 1 });
    }
    const q = computeQuality(await store.mistakes.getAll(), await store.reviews.getAll(), clock.now());
    assert.equal(q.perAyah[0]?.countedOutcomes, 2);
  });

  it('applies a staleness penalty when the last success is old', async () => {
    const { mistakes, store, clock } = setup();
    await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other' });
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'correct_easy', { sessionId: 's', repetitions: 1 });
    const fresh = computeQuality(await store.mistakes.getAll(), await store.reviews.getAll(), clock.now()).score;
    clock.advanceDays(44);
    const old = computeQuality(await store.mistakes.getAll(), await store.reviews.getAll(), clock.now());
    assert.equal(fresh, 100);
    assert.equal(old.score, 85);
    assert.equal(old.staleAyahCount, 1);
  });

  it('reflects reopened mistakes and is reproducible for past dates', async () => {
    const { mistakes, store, clock } = setup();
    const { mistake } = await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other' });
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'correct_easy', { sessionId: 's1', repetitions: 1 });
    await mistakes.resolve(mistake.id);
    const t1 = clock.now();
    const resolvedScore = computeQuality(await store.mistakes.getAll(), await store.reviews.getAll(), t1).score;
    clock.advanceDays(2);
    await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'forgotten' }); // reopens
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'mistake_again', { sessionId: 's2', repetitions: 1 });
    const reopened = computeQuality(await store.mistakes.getAll(), await store.reviews.getAll(), clock.now());
    assert.equal(resolvedScore, 100);
    assert.ok((reopened.score ?? 100) < 50);
    // Scope filtering by interval.
    const outside = computeQuality(await store.mistakes.getAll(), await store.reviews.getAll(), clock.now(), [{ start: 1, end: toIndex({ surah: 2, ayah: 254 }) }]);
    assert.equal(outside.score, null);
  });
});
