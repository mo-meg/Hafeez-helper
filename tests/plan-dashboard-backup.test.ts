import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregateDashboard } from '../src/core/dashboard/aggregate.ts';
import { removeDemoData, seedDemoData } from '../src/core/demo.ts';
import type { RepeatConfig } from '../src/core/model.ts';
import { PlanError, PlanService } from '../src/core/plan/planService.ts';
import { DivisionIndex } from '../src/core/quran/divisions.ts';
import { normalizePreferences, DEFAULT_PREFERENCES } from '../src/core/settings/preferences.ts';
import { BackupError, exportBackup, parseBackup, restoreBackup, wipePersonalData } from '../src/core/storage/backup.ts';
import { createMemoryStore } from '../src/core/storage/memoryStore.ts';
import { sequentialIds } from '../src/core/util/ids.ts';
import { syntheticDivisions } from './fixtures/synthetic.ts';
import { setup, word } from './helpers.ts';

const repeat: RepeatConfig = { ayahRepeat: 3, groupRepeat: 1, playlistRepeat: 1, repeatContext: false, pauseBetweenRepetitionsMs: 0, pauseBetweenAyatMs: 0, playbackRate: 1 };
const index = new DivisionIndex(syntheticDivisions());

async function all(store: ReturnType<typeof setup>['store']) {
  return { mistakes: await store.mistakes.getAll(), reviews: await store.reviews.getAll(), sessions: await store.sessions.getAll(), plans: await store.plans.getAll() };
}

describe('daily plans and sessions', () => {
  it('keeps one plan per date and kind; changing the scope resets progress', async () => {
    const { plans, store } = setup();
    const d = plans.today();
    await plans.setPlan(d, { type: 'division', kind: 'hizb', number: 5 });
    const s = await plans.startSession({ planId: PlanService.planId(d, 'revision'), mode: 'mistakes', scope: { type: 'division', kind: 'hizb', number: 5 }, reciterId: 'r', repeat, mistakeAyahIndexes: [], plannedSteps: 0 });
    assert.equal((await plans.getPlan(d))?.status, 'in_progress');
    await plans.setPlan(d, { type: 'division', kind: 'hizb', number: 5 });
    assert.deepEqual((await plans.getPlan(d))?.sessionIds, [s.id], 'same scope keeps progress');
    await plans.setPlan(d, { type: 'division', kind: 'hizb', number: 6 });
    assert.equal((await plans.getPlan(d))?.status, 'pending');
    assert.equal((await store.plans.getAll()).length, 1);
    await assert.rejects(plans.setPlan('2026-3-1', { type: 'all' }), PlanError);
  });

  it('completing a session completes the plan but does NOT resolve mistakes', async () => {
    const { plans, mistakes, store } = setup();
    const d = plans.today();
    await mistakes.markWord({ surah: 2, ayah: 255 }, word(1), { category: 'forgotten' });
    await plans.setPlan(d, { type: 'division', kind: 'hizb', number: 5 });
    const s = await plans.startSession({ planId: PlanService.planId(d, 'revision'), mode: 'mistakes', scope: { type: 'division', kind: 'hizb', number: 5 }, reciterId: 'r', repeat, mistakeAyahIndexes: [262], plannedSteps: 3 });
    for (let i = 0; i < 3; i++) await plans.recordPlayback(s.id, 262);
    const done = await plans.completeSession(s.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.playedAyahIndexes, [262]);
    assert.equal(done.completedSteps, 3);
    assert.equal((await plans.getPlan(d))?.status, 'completed');
    assert.ok((await store.mistakes.getAll()).every((m) => m.status === 'new'));
    assert.equal((await plans.lastCompletedFor({ type: 'division', kind: 'hizb', number: 5 }))?.id, s.id);
  });

  it('suggests the next division for tomorrow', () => {
    assert.deepEqual(PlanService.nextScope({ type: 'division', kind: 'hizb', number: 5 }, index), { type: 'division', kind: 'hizb', number: 6 });
    assert.deepEqual(PlanService.nextScope({ type: 'division', kind: 'hizb', number: 60 }, index), { type: 'division', kind: 'hizb', number: 1 });
    assert.equal(PlanService.nextScope({ type: 'all' }, index), null);
  });
});

describe('dashboard aggregation', () => {
  it('shows zeros and nulls for a new user — no fabricated metrics', () => {
    const d = aggregateDashboard({ mistakes: [], reviews: [], sessions: [], plans: [], index, now: new Date('2026-03-01T12:00:00Z') });
    assert.equal(d.totalMistakes, 0);
    assert.equal(d.overall.score, null);
    assert.equal(d.streakDays, 0);
    assert.ok(d.trend.every((t) => t.reviews === 0 && t.accuracy === null && t.score === null));
  });

  it('reflects actual review history, streaks, reappearance and divisions', async () => {
    const { mistakes, clock, store } = setup('2026-03-01T09:00:00');
    const a = await mistakes.markWord({ surah: 2, ayah: 255 }, word(1), { category: 'forgotten' });
    await mistakes.markWord({ surah: 2, ayah: 255 }, word(2), { category: 'forgotten' });
    await mistakes.markAyah({ surah: 3, ayah: 7 }, { category: 'similar_ayah' });
    await mistakes.markAyah({ surah: 18, ayah: 28 }, { category: 'tajweed' });
    for (let day = 0; day < 3; day++) {
      await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, day === 1 ? 'mistake_again' : 'correct_easy', { sessionId: `s${day}`, repetitions: 3 });
      clock.advanceDays(1);
    }
    clock.advanceDays(-1);
    await mistakes.resolve(a.mistake.id);
    const d = aggregateDashboard({ ...(await all(store)), index, now: clock.now() });
    assert.equal(d.ayatWithMistakes, 3);
    assert.equal(d.totalMistakes, 4);
    assert.equal(d.resolved, 1);
    assert.equal(d.unresolved, 3);
    assert.equal(d.reappeared, 2, 'both words of 2:255 lapsed once');
    assert.equal(d.streakDays, 3);
    assert.equal(d.ayatReviewedToday, 1);
    assert.equal(d.recallsToday, 1, 'two words reviewed together are one recall');
    const last3 = d.trend.slice(-3);
    assert.deepEqual(last3.map((t) => t.accuracy), [1, 0, 1]);
    assert.equal(d.byDivision.hizb?.find((h) => h.key === 5)?.mistakes, 3);
    assert.equal(d.categories.find((c) => c.category === 'forgotten')?.total, 2);
    assert.equal(d.mostPractice[0]?.globalIndex, 262);
    assert.ok(d.due.length >= 2);
    assert.equal(d.hasDemoData, false);
  });
});

describe('backup and restore', () => {
  it('round-trips all personal data and preferences', async () => {
    const { mistakes, plans, store, clock } = setup();
    await mistakes.markWord({ surah: 2, ayah: 255 }, word(3), { category: 'forgotten', note: 'private note' });
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'correct_easy', { sessionId: 's1', repetitions: 2 });
    await plans.setPlan(plans.today(), { type: 'division', kind: 'hizb', number: 5 });
    await store.settings.set('preferences', { ...DEFAULT_PREFERENCES, fontScale: 1.6 });
    await store.quranData.set('text', { huge: true });
    const backup = JSON.parse(JSON.stringify(await exportBackup(store, clock.now())));
    assert.equal(JSON.stringify(backup).includes('huge'), false, 'Quran data is not part of personal backups');

    const target = createMemoryStore();
    const res = await restoreBackup(target, parseBackup(backup), 'replace');
    assert.deepEqual(res.summary, { mistakes: 1, reviews: 1, plans: 1, sessions: 0 });
    assert.equal((await target.mistakes.getAll())[0]?.note, 'private note');
    assert.equal(res.preferences?.fontScale, 1.6);
  });

  it('rejects invalid, inconsistent, orphaned and future-version backups', async () => {
    const { mistakes, store, clock } = setup();
    await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other' });
    await mistakes.recordAyahReview({ surah: 2, ayah: 255 }, 'correct_easy', { sessionId: 's', repetitions: 1 });
    const good = JSON.parse(JSON.stringify(await exportBackup(store, clock.now())));
    assert.throws(() => parseBackup({ app: 'other' }), BackupError);
    assert.throws(() => parseBackup({ ...good, schemaVersion: 99 }), /newer version/);
    const bad = structuredClone(good);
    bad.data.mistakes[0].globalIndex = 1;
    assert.throws(() => parseBackup(bad), BackupError);
    const orphan = structuredClone(good);
    orphan.data.mistakes = [];
    assert.throws(() => parseBackup(orphan), /does not exist/);
  });

  it('merge keeps the more recently updated mistake', async () => {
    const { mistakes, store, clock } = setup();
    const { mistake } = await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other', note: 'old' });
    const backup = parseBackup(JSON.parse(JSON.stringify(await exportBackup(store, clock.now()))));
    clock.advanceDays(1);
    await mistakes.update(mistake.id, { note: 'newer local edit' });
    await restoreBackup(store, backup, 'merge');
    assert.equal((await store.mistakes.get(mistake.id))?.note, 'newer local edit');
  });

  it('wipes personal data on request', async () => {
    const { mistakes, store } = setup();
    await mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'other' });
    await wipePersonalData(store);
    assert.equal((await store.mistakes.getAll()).length, 0);
    assert.equal((await store.mistakeEvents.getAll()).length, 0);
  });
});

describe('demo data', () => {
  it('is flagged, visible as demo in the dashboard, and fully removable', async () => {
    const { store, clock } = setup();
    const n = await seedDemoData(store, clock, sequentialIds());
    assert.equal(n, 7);
    const d = aggregateDashboard({ ...(await all(store)), index, now: clock.now() });
    assert.equal(d.hasDemoData, true);
    assert.ok((await store.mistakes.getAll()).every((m) => m.demo && m.word === null));
    await removeDemoData(store);
    assert.equal((await store.mistakes.getAll()).length, 0);
    assert.equal((await store.reviews.getAll()).length, 0);
  });
});

describe('preferences', () => {
  it('fills defaults and repairs invalid fields without losing valid ones', () => {
    assert.deepEqual(normalizePreferences(undefined), DEFAULT_PREFERENCES);
    const p = normalizePreferences({ fontScale: 99, theme: 'dark', repeat: { ayahRepeat: 7 } });
    assert.equal(p.fontScale, DEFAULT_PREFERENCES.fontScale);
    assert.equal(p.theme, 'dark');
    assert.equal(p.repeat.ayahRepeat, 7);
    assert.equal(p.repeat.groupRepeat, 1);
  });
});
