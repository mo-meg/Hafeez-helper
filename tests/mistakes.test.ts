import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterMistakes } from '../src/core/mistakes/filters.ts';
import { MistakeError } from '../src/core/mistakes/mistakeService.ts';
import { DivisionIndex } from '../src/core/quran/divisions.ts';
import { scopeIntervals } from '../src/core/quran/scope.ts';
import { syntheticDivisions } from './fixtures/synthetic.ts';
import { setup, word } from './helpers.ts';

describe('marking mistakes', () => {
  it('marks a word with its exact reference and a token snapshot', async () => {
    const { mistakes } = setup();
    const { mistake, action } = await mistakes.markWord({ surah: 2, ayah: 255 }, word(3), { category: 'forgotten', note: ' tricky ' });
    assert.equal(action, 'created');
    assert.equal(mistake.globalIndex, 262);
    assert.deepEqual(mistake.word, { position: 3, tokenText: 'كلمة' });
    assert.equal(mistake.edition, 'synthetic-fixture');
    assert.equal(mistake.status, 'new');
    assert.equal(mistake.note, 'tricky');
  });

  it('marks an entire ayah without a word reference', async () => {
    const { mistakes } = setup();
    const { mistake } = await mistakes.markAyah({ surah: 3, ayah: 7 }, { category: 'similar_ayah' });
    assert.equal(mistake.word, null);
    assert.equal(mistake.edition, null);
  });

  it('rejects invalid references and word positions', async () => {
    const { mistakes } = setup();
    await assert.rejects(mistakes.markAyah({ surah: 2, ayah: 300 }, { category: 'other' }), RangeError);
    await assert.rejects(async () => mistakes.markWord({ surah: 2, ayah: 1 }, word(0), { category: 'other' }), MistakeError);
  });

  it('does not create duplicates when the same target is marked again; records a recurrence instead', async () => {
    const { mistakes, store, clock } = setup();
    const a = await mistakes.markWord({ surah: 2, ayah: 255 }, word(3), { category: 'forgotten' });
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'correct_easy', { sessionId: 's1', repetitions: 1 });
    clock.advanceDays(1);
    const b = await mistakes.markWord({ surah: 2, ayah: 255 }, word(3), { category: 'hesitation' });
    assert.equal(b.action, 'recurred');
    assert.equal(b.mistake.id, a.mistake.id);
    assert.equal(b.mistake.lapseCount, 1);
    assert.equal(b.mistake.status, 'needs_practice');
    assert.equal(b.mistake.category, 'hesitation');
    assert.equal((await store.mistakes.getAll()).length, 1);
    // A different word of the same ayah is a separate record.
    await mistakes.markWord({ surah: 2, ayah: 255 }, word(4), { category: 'forgotten' });
    assert.equal((await store.mistakes.getAll()).length, 2);
  });

  it('edits notes without changing status or creating records', async () => {
    const { mistakes } = setup();
    const { mistake } = await mistakes.markAyah({ surah: 2, ayah: 260 }, { category: 'other', note: 'a' });
    const u = await mistakes.update(mistake.id, { note: 'better note', confidence: 4 });
    assert.equal(u.note, 'better note');
    assert.equal(u.confidence, 4);
    assert.equal(u.status, 'new');
    await assert.rejects(mistakes.update(mistake.id, { confidence: 9 }), MistakeError);
  });

  it('resolves and reopens while preserving history', async () => {
    const { mistakes, clock } = setup();
    const { mistake } = await mistakes.markAyah({ surah: 2, ayah: 260 }, { category: 'other' });
    await mistakes.recordAyahReview({ surah: 2, ayah: 260 }, 'correct_easy', { sessionId: 's1', repetitions: 3 });
    clock.advanceDays(1);
    const r = await mistakes.resolve(mistake.id);
    assert.equal(r.status, 'resolved');
    assert.ok(r.resolvedAt);
    clock.advanceDays(1);
    const o = await mistakes.reopen(mistake.id);
    assert.equal(o.status, 'reopened');
    assert.equal(o.resolvedAt, null);
    assert.equal(o.reopenCount, 1);
    const h = await mistakes.history(mistake.id);
    assert.deepEqual(h.events.map((e) => e.type), ['marked', 'status_changed', 'resolved', 'reopened']);
    assert.equal(h.reviews.length, 1, 'review events are preserved');
  });

  it('re-marking a resolved mistake reopens the same record', async () => {
    const { mistakes } = setup();
    const { mistake } = await mistakes.markAyah({ surah: 2, ayah: 270 }, { category: 'other' });
    await mistakes.resolve(mistake.id);
    const again = await mistakes.markAyah({ surah: 2, ayah: 270 }, { category: 'forgotten' });
    assert.equal(again.action, 'reopened');
    assert.equal(again.mistake.status, 'reopened');
    assert.equal(again.mistake.reopenCount, 1);
  });

  it('enforces valid status transitions', async () => {
    const { mistakes } = setup();
    const { mistake } = await mistakes.markAyah({ surah: 2, ayah: 270 }, { category: 'other' });
    await assert.rejects(mistakes.setStatus(mistake.id, 'reopened'), /Only a resolved/);
    assert.equal((await mistakes.setStatus(mistake.id, 'needs_practice')).status, 'needs_practice');
    await assert.rejects(mistakes.setStatus(mistake.id, 'new'), MistakeError);
  });

  it('applies one recall outcome to all marked words of the ayah', async () => {
    const { mistakes } = setup();
    await mistakes.markWord({ surah: 2, ayah: 255 }, word(1), { category: 'forgotten' });
    await mistakes.markWord({ surah: 2, ayah: 255 }, word(5), { category: 'incorrect_word' });
    const events = await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'needed_prompt', { sessionId: 's1', repetitions: 5 });
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.at === events[0]?.at && e.assisted && e.nextStatus === 'needs_practice'));
  });

  it('never resolves a mistake automatically, however many successes', async () => {
    const { mistakes, clock } = setup();
    const { mistake } = await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other' });
    for (let i = 0; i < 10; i++) {
      clock.advanceDays(3);
      await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'correct_easy', { sessionId: `s${i}`, repetitions: 1 });
    }
    const m = await mistakes.get(mistake.id);
    assert.equal(m.status, 'improved');
    assert.equal(m.successStreak, 10);
  });

  it('lets the user override the schedule; a later review clears the override', async () => {
    const { mistakes } = setup();
    const { mistake } = await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other' });
    const o = await mistakes.overrideSchedule(mistake.id, '2026-04-01T00:00:00.000Z', 'harder');
    assert.equal(o.schedule.manualNextReviewAt, '2026-04-01T00:00:00.000Z');
    assert.equal(o.schedule.difficultyOverride, 'harder');
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'correct_easy', { sessionId: 's', repetitions: 1 });
    const after = await mistakes.get(mistake.id);
    assert.equal(after.schedule.manualNextReviewAt, null);
    assert.equal(after.schedule.difficultyOverride, 'harder');
  });

  it('deletes permanently only on explicit request, including related events', async () => {
    const { mistakes, store } = setup();
    const { mistake } = await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other' });
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'correct_easy', { sessionId: 's', repetitions: 1 });
    await mistakes.deletePermanently(mistake.id);
    assert.equal((await store.mistakes.getAll()).length, 0);
    assert.equal((await store.reviews.getAll()).length, 0);
    assert.equal((await store.mistakeEvents.getAll()).length, 0);
  });
});

describe('filtering mistakes', () => {
  it('filters by scope, hizb, surah, category, status, date and confidence', async () => {
    const { mistakes, clock } = setup('2026-03-01T10:00:00.000Z');
    const index = new DivisionIndex(syntheticDivisions());
    await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'forgotten', confidence: 2 });
    clock.advanceDays(2);
    await mistakes.markAyah({ surah: 3, ayah: 7 }, { category: 'similar_ayah', confidence: 4 });
    await mistakes.markAyah({ surah: 18, ayah: 28 }, { category: 'forgotten' });
    const all = await mistakes.list();
    const hizb5 = scopeIntervals({ type: 'division', kind: 'hizb', number: 5 }, index);
    assert.deepEqual(filterMistakes(all, { scope: hizb5 }, index).map((m) => `${m.surah}:${m.ayah}`), ['2:255', '3:7']);
    assert.equal(filterMistakes(all, { hizbs: [5] }, index).length, 2);
    assert.equal(filterMistakes(all, { surahs: [18] }, index).length, 1);
    assert.equal(filterMistakes(all, { categories: ['forgotten'] }, index).length, 2);
    assert.equal(filterMistakes(all, { statuses: ['resolved'] }, index).length, 0);
    assert.equal(filterMistakes(all, { createdFrom: '2026-03-02' }, index).length, 2);
    assert.equal(filterMistakes(all, { minConfidence: 3 }, index).length, 1);
  });
});
