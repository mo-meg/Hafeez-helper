import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { suggestedCategory } from '../src/core/model.ts';
import { computeIntervalDays } from '../src/core/review/scheduler.ts';
import { DivisionIndex } from '../src/core/quran/divisions.ts';
import { toIndex } from '../src/core/quran/refs.ts';
import { scopeIntervals } from '../src/core/quran/scope.ts';
import { allowedOutcomes, buildTestCards, hint, initialReveal, isWordVisible, nextSegment, revealSegment, totalSteps } from '../src/core/test/testBuilder.ts';
import { syntheticDivisions } from './fixtures/synthetic.ts';
import { setup, word } from './helpers.ts';

const index = new DivisionIndex(syntheticDivisions());
const hizb5 = scopeIntervals({ type: 'division', kind: 'hizb', number: 5 }, index);

describe('automatic "linking ayat" type', () => {
  it('is suggested only for the first word of an ayah', () => {
    assert.equal(suggestedCategory(1), 'ayah_transition');
    assert.equal(suggestedCategory(2), null);
    assert.equal(suggestedCategory(null), null);
  });
  it('is reviewed more often, like similar-ayah confusions', () => {
    const base = { outcome: 'correct_easy' as const, successStreak: 4, lapseCount: 0, severity: 1 as const, difficulty: 'normal' as const, previousIntervalDays: 7, lastReviewedAt: null, reviewedAt: new Date() };
    assert.ok(computeIntervalDays({ ...base, category: 'ayah_transition' }) < computeIntervalDays({ ...base, category: 'forgotten' }));
  });
});

describe('test cards', () => {
  async function scenario() {
    const ctx = setup();
    const m = ctx.mistakes;
    await m.markWord({ surah: 2, ayah: 255 }, word(5), { category: 'forgotten' });
    await m.markWord({ surah: 2, ayah: 255 }, word(3), { category: 'incorrect_word' });
    await m.markWord({ surah: 2, ayah: 260 }, word(1), { category: 'ayah_transition' });
    await m.markAyah({ surah: 2, ayah: 270 }, { category: 'other' });
    await m.markWord({ surah: 2, ayah: 275 }, word(1), { category: 'forgotten' }); // first word, other type
    await m.markWord({ surah: 3, ayah: 7 }, word(2), { category: 'tajweed' });
    await m.markAyah({ surah: 18, ayah: 28 }, { category: 'other' }); // outside Hizb 5
    const resolved = await m.markWord({ surah: 2, ayah: 280 }, word(2), { category: 'forgotten' });
    await m.resolve(resolved.mistake.id);
    return { ...ctx, list: await m.list() };
  }

  it('builds one card per ayah in scope, in Quran order, unresolved only by default', async () => {
    const { list } = await scenario();
    const cards = buildTestCards(list, hizb5);
    assert.deepEqual(cards.map((c) => `${c.ref.surah}:${c.ref.ayah}`), ['2:255', '2:260', '2:270', '2:275', '3:7']);
    assert.equal(buildTestCards(list, hizb5, { includeResolved: true }).length, 6);
  });

  it('within-ayah card hides from the FIRST marked word to the end of the ayah', async () => {
    const { list } = await scenario();
    const c = buildTestCards(list, hizb5)[0];
    assert.equal(c?.kind, 'within');
    assert.equal(c?.hideFrom, 3);
    assert.deepEqual(c?.markedPositions, [3, 5]);
    assert.equal(c?.promptIndex, (c?.globalIndex ?? 0) - 1, 'previous ayah shown on every card');
    assert.equal(c?.mistakeIds.length, 2);
  });

  it('transition, first-word and whole-ayah mistakes show the previous ayah and hide the whole ayah', async () => {
    const { list } = await scenario();
    const cards = buildTestCards(list, hizb5);
    for (const ref of ['2:260', '2:270', '2:275']) {
      const c = cards.find((x) => `${x.ref.surah}:${x.ref.ayah}` === ref);
      assert.equal(c?.kind, 'transition', ref);
      assert.equal(c?.hideFrom, 1, ref);
      assert.equal(c?.promptIndex, (c?.globalIndex ?? 0) - 1, ref);
    }
  });

  it('the previous ayah of a surah\'s first ayah is the last ayah of the previous surah; 1:1 has none', async () => {
    const { mistakes } = setup();
    await mistakes.markWord({ surah: 3, ayah: 1 }, word(1), { category: 'ayah_transition' });
    await mistakes.markAyah({ surah: 1, ayah: 1 }, { category: 'other' });
    const cards = buildTestCards(await mistakes.list(), [{ start: 1, end: 6236 }]);
    assert.equal(cards[0]?.promptIndex, null);
    assert.equal(cards[1]?.promptIndex, toIndex({ surah: 2, ayah: 286 }));
  });

  it('can shuffle deterministically', async () => {
    const { list } = await scenario();
    const a = buildTestCards(list, hizb5, { shuffle: true, seed: 7 }).map((c) => c.globalIndex);
    const b = buildTestCards(list, hizb5, { shuffle: true, seed: 7 }).map((c) => c.globalIndex);
    assert.deepEqual(a, b);
    assert.deepEqual([...a].sort((x, y) => x - y), buildTestCards(list, hizb5).map((c) => c.globalIndex));
  });

  it('several mistakes in one ayah become steps: reveal stops before the next mistake', async () => {
    const { list } = await scenario();
    const card = buildTestCards(list, hizb5)[0]; // 2:255, marks on words 3 and 5
    assert.ok(card);
    assert.deepEqual(card.segments.map((x) => [x.from, x.to, x.mistakeIds.length]), [[3, 4, 1], [5, null, 1]]);
    const words = 6;
    let st = initialReveal(card);
    assert.deepEqual([1, 2, 3, 4, 5].map((p) => isWordVisible(card, st, p)), [true, true, false, false, false]);
    st = revealSegment(card, st, words);
    assert.deepEqual([3, 4, 5, 6].map((p) => isWordVisible(card, st, p)), [true, true, false, false], 'word 5 (next mistake) stays hidden');
    const second = nextSegment(card, st);
    assert.ok(second);
    assert.equal(second.segment, 1);
    assert.equal(second.segmentRevealed, false);
    assert.ok(isWordVisible(card, second, 4) && !isWordVisible(card, second, 5), 'revealed text stays visible');
    const done = revealSegment(card, second, words);
    assert.ok(isWordVisible(card, done, 6));
    assert.equal(nextSegment(card, done), null);
    assert.equal(totalSteps(buildTestCards(list, hizb5)), 6);
  });

  it('a linking-ayat mark plus a later word mark: first step hides the whole ayah, reveal stops before the later mistake', async () => {
    const { mistakes } = setup();
    await mistakes.markWord({ surah: 2, ayah: 260 }, word(1), { category: 'ayah_transition' });
    await mistakes.markWord({ surah: 2, ayah: 260 }, word(4), { category: 'forgotten' });
    const card = buildTestCards(await mistakes.list(), hizb5)[0];
    assert.ok(card);
    assert.equal(card.kind, 'transition');
    assert.deepEqual(card.segments.map((x) => [x.from, x.to]), [[1, 3], [4, null]]);
    const st = revealSegment(card, initialReveal(card), 7);
    assert.deepEqual([1, 3, 4].map((p) => isWordVisible(card, st, p)), [true, true, false]);
  });

  it('hints uncover one word at a time within the step, then only allow "needed a prompt" or "mistake again"', async () => {
    const { list } = await scenario();
    const card = buildTestCards(list, hizb5)[0];
    assert.ok(card);
    let st = initialReveal(card);
    assert.equal(allowedOutcomes(st).length, 4);
    st = hint(card, st, 6);
    assert.deepEqual([3, 4].map((p) => isWordVisible(card, st, p)), [true, false]);
    assert.deepEqual(allowedOutcomes(st), ['needed_prompt', 'mistake_again']);
    for (let i = 0; i < 10; i++) st = hint(card, st, 6);
    assert.equal(st.segmentRevealed, true);
    assert.equal(st.hintsUsed, 2, 'hints stop at the end of the step (word 4)');
    assert.equal(isWordVisible(card, st, 5), false);
    const next = nextSegment(card, st);
    assert.ok(next);
    assert.equal(allowedOutcomes(next).length, 4, 'hints are counted per step');
  });

  it('test answers are recorded; "correct without difficulty" resolves only that mistake', async () => {
    const { mistakes, plans, list, store } = await scenario();
    const cards = buildTestCards(list, hizb5);
    const s = await plans.startSession({ planId: null, mode: 'test', scope: { type: 'division', kind: 'hizb', number: 5 }, reciterId: 'r', repeat: { ayahRepeat: 1, groupRepeat: 1, playlistRepeat: 1, repeatContext: false, pauseBetweenRepetitionsMs: 0, pauseBetweenAyatMs: 0, playbackRate: 1 }, mistakeAyahIndexes: cards.map((c) => c.globalIndex), plannedSteps: totalSteps(cards) });
    const c = cards[0]; // 2:255: steps for word 3 and word 5
    assert.ok(c);
    const [first, second] = c.segments;
    assert.ok(first && second);
    await mistakes.recordAyahReview(c.ref, 'correct_easy', { sessionId: s.id, repetitions: 0, resolveOnEasy: true }, first.mistakeIds);
    await mistakes.recordAyahReview(c.ref, 'correct_difficult', { sessionId: s.id, repetitions: 0, resolveOnEasy: true }, second.mistakeIds);
    await plans.recordTestProgress(s.id, 2);
    await plans.completeSession(s.id);
    assert.equal((await mistakes.get(first.mistakeIds[0] as string)).status, 'resolved');
    assert.ok((await mistakes.get(first.mistakeIds[0] as string)).resolvedAt);
    assert.equal((await mistakes.get(second.mistakeIds[0] as string)).status, 'under_review', 'difficult answers do not resolve');
    const ev = (await store.mistakeEvents.getAll()).find((e) => e.mistakeId === first.mistakeIds[0] && e.type === 'resolved');
    assert.equal(ev?.detail, 'test:correct_easy');
    assert.equal((await store.sessions.get(s.id))?.completedSteps, 2);
  });

  it('an assisted answer or a revision session never resolves; a resolved mistake that fails a test is reopened', async () => {
    const { mistakes } = setup();
    const a = await mistakes.markWord({ surah: 2, ayah: 255 }, word(2), { category: 'forgotten' });
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'correct_easy', { sessionId: 'rev', repetitions: 3 });
    assert.notEqual((await mistakes.get(a.mistake.id)).status, 'resolved', 'revision sessions keep the old rule');
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'correct_easy', { sessionId: 't0', repetitions: 0, assisted: true, resolveOnEasy: true });
    assert.notEqual((await mistakes.get(a.mistake.id)).status, 'resolved', 'hinted answers do not resolve');
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'correct_easy', { sessionId: 't1', repetitions: 0, resolveOnEasy: true });
    assert.equal((await mistakes.get(a.mistake.id)).status, 'resolved');
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'mistake_again', { sessionId: 't2', repetitions: 0, resolveOnEasy: true }, [a.mistake.id]);
    assert.equal((await mistakes.get(a.mistake.id)).status, 'reopened');
  });
});
