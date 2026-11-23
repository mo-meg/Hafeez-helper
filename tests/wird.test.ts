import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DivisionIndex } from '../src/core/quran/divisions.ts';
import { createMemoryStore } from '../src/core/storage/memoryStore.ts';
import { exportBackup, parseBackup, restoreBackup } from '../src/core/storage/backup.ts';
import { FixedClock, sequentialIds } from '../src/core/util/ids.ts';
import { autoWeeklyRanges, balancedSizes, checkManual, dailyUnits, manualOk } from '../src/core/wird/distribution.ts';
import { planDay, proposeSpread, type UnitItem } from '../src/core/wird/engine.ts';
import { configFromPeriod } from '../src/core/wird/migrate.ts';
import type { WirdPlan, WirdTask } from '../src/core/wird/model.ts';
import { wirdStats } from '../src/core/wird/stats.ts';
import { convertSpan, rangeQuarterSpan } from '../src/core/wird/units.ts';
import { WirdError, WirdService, type PlanInput } from '../src/core/wird/wirdService.ts';
import { syntheticDivisions } from './fixtures/synthetic.ts';

// 2026-11-22 is a Sunday. Times without "Z" are local, so date keys never shift with the time zone.
const SUN = '2026-11-22';
const at = (date: string, time = '10:00:00') => `${date}T${time}`;
const day = (offset: number) => {
  const d = new Date(2026, 10, 22 + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function setup(date = SUN) {
  const store = createMemoryStore();
  const clock = new FixedClock(at(date));
  const wird = new WirdService({ store, clock, ids: sequentialIds() });
  const goTo = (d: string) => clock.set(at(d));
  return { store, clock, wird, goTo };
}

const base = { revisionDays: [0, 1, 2, 3, 4], weekStart: 6, cycle: 'weekly', distribution: 'auto', manual: [], allowGaps: false, dailyAmount: 1, targetDate: null } as const;
const madinah = (over: Partial<PlanInput['config']> = {}): PlanInput => ({
  name: 'Madinah Revision',
  color: 0,
  startDate: SUN,
  config: { ...base, unit: 'hizb', from: 13, to: 30, fullDays: [5], carry: 'strict', fullDayOverdue: 'full_plus_overdue', ...over },
});
const morocco = (over: Partial<PlanInput['config']> = {}): PlanInput => ({
  name: 'Morocco Revision',
  color: 1,
  startDate: SUN,
  config: { ...base, unit: 'hizb', from: 1, to: 10, fullDays: [6], carry: 'strict', fullDayOverdue: 'full_plus_overdue', ...over },
});

const ns = (items: readonly UnitItem[]) => items.map((u) => u.n);
const refs = (items: readonly UnitItem[]) => items.map((u) => ({ taskId: u.taskId, n: u.n }));

async function today(w: WirdService, plan: WirdPlan) {
  await w.refresh();
  const { tasks } = await w.list();
  return planDay(plan, tasks, w.today(), w.today());
}

describe('Wird units and distribution', () => {
  it('maps units to quarters and converts ranges between units', () => {
    assert.deepEqual(rangeQuarterSpan('hizb', 13, 30), { from: 49, to: 120 });
    assert.deepEqual(convertSpan(rangeQuarterSpan('hizb', 13, 30), 'juz'), { from: 7, to: 15 });
    assert.deepEqual(convertSpan(rangeQuarterSpan('hizb', 13, 30), 'quarter'), { from: 49, to: 120 });
    assert.equal(convertSpan(rangeQuarterSpan('hizb', 2, 3), 'juz'), null);
  });

  it('balances a weekly range: Hizb 13–30 over five days = 4, 4, 4, 3, 3', () => {
    assert.deepEqual(balancedSizes(18, 5), [4, 4, 4, 3, 3]);
    const r = autoWeeklyRanges({ from: 13, to: 30, revisionDays: [4, 0, 2, 1, 3], weekStart: 6 });
    assert.deepEqual(r, [
      { day: 0, from: 13, to: 16 },
      { day: 1, from: 17, to: 20 },
      { day: 2, from: 21, to: 24 },
      { day: 3, from: 25, to: 27 },
      { day: 4, from: 28, to: 30 },
    ]);
  });

  it('fixed daily amount walks through the range and wraps around', () => {
    const c = { from: 1, to: 5, dailyAmount: 2, startOffset: 0 };
    assert.deepEqual([0, 1, 2, 3].map((k) => dailyUnits(c, k)), [[1, 2], [3, 4], [5, 1], [2, 3]]);
  });

  it('validates manual splits: gaps and repeats need explicit consent', () => {
    const c = { from: 1, to: 6, revisionDays: [0, 1] as const, manual: [{ day: 0 as const, from: 1, to: 3 }, { day: 1 as const, from: 3, to: 5 }] };
    const check = checkManual({ ...c, revisionDays: [...c.revisionDays] });
    assert.deepEqual(check.missing, [6]);
    assert.deepEqual(check.duplicated, [3]);
    assert.equal(manualOk(check, false), false);
    assert.equal(manualOk(check, true), true);
    assert.deepEqual(checkManual({ ...c, revisionDays: [0, 1, 2] }).emptyDays, [2]);
  });
});

describe('Wird plans run independently', () => {
  it("shows each plan's own assignment and completes plans separately", async () => {
    const { wird } = setup();
    const a = await wird.createPlan(madinah());
    const b = await wird.createPlan(morocco());
    const da = await today(wird, a);
    const db = await today(wird, b);
    assert.deepEqual(ns(da.scheduled), [13, 14, 15, 16]);
    assert.deepEqual(ns(db.scheduled), [1, 2]);
    await wird.complete(refs(db.scheduled));
    assert.equal((await today(wird, b)).status, 'done');
    assert.equal((await today(wird, a)).status, 'pending', 'completing one plan never completes another');
  });

  it('plans with overlapping ranges and different units do not merge into each other', async () => {
    const { wird, goTo } = setup();
    const a = await wird.createPlan(morocco());
    const b = await wird.createPlan({ ...morocco({ unit: 'quarter', from: 1, to: 40 }), name: 'Rub plan' });
    goTo(day(1));
    const da = await today(wird, a);
    const db = await today(wird, b);
    assert.deepEqual(ns(da.overdue), [1, 2]);
    assert.deepEqual(ns(db.overdue), [1, 2, 3, 4, 5, 6, 7, 8]);
    await wird.complete(refs(da.overdue));
    assert.equal((await today(wird, b)).overdue.filter((u) => u.done).length, 0);
  });

  it('rejects invalid configurations', async () => {
    const { wird } = setup();
    await assert.rejects(wird.createPlan(madinah({ from: 30, to: 13 })), WirdError);
    await assert.rejects(wird.createPlan(madinah({ to: 61 })), WirdError);
    await assert.rejects(wird.createPlan(madinah({ revisionDays: [] })), WirdError);
    await assert.rejects(wird.createPlan(madinah({ fullDays: [0] })), WirdError);
    await assert.rejects(wird.createPlan(madinah({ distribution: 'manual', manual: [{ day: 0, from: 13, to: 20 }] })), WirdError);
  });
});

describe('Wird carry-over', () => {
  it('Strict: Sunday not done → Monday shows overdue + scheduled, distinguished', async () => {
    const { wird, goTo } = setup();
    const p = await wird.createPlan(madinah());
    goTo(day(1));
    const d = await today(wird, p);
    assert.deepEqual(ns(d.overdue), [13, 14, 15, 16]);
    assert.ok(d.overdue.every((u) => u.taskDate === SUN));
    assert.deepEqual(ns(d.scheduled), [17, 18, 19, 20]);
    assert.equal(d.required.length, 8);
  });

  it('is idempotent: refreshing many times never duplicates tasks', async () => {
    const { wird, goTo, store } = setup();
    await wird.createPlan(madinah());
    goTo(day(3));
    await wird.refresh();
    const count = (await store.wirdTasks.getAll()).length;
    assert.equal(await wird.refresh(), 0);
    await wird.refresh();
    assert.equal((await store.wirdTasks.getAll()).length, count);
    assert.equal(count, 4, 'Sun–Wed');
  });

  it('partial completion: only the unfinished units carry over', async () => {
    const { wird, goTo } = setup();
    const p = await wird.createPlan(madinah());
    const d = await today(wird, p);
    await wird.complete(refs(d.scheduled.slice(0, 3)), 'good');
    goTo(day(1));
    const m = await today(wird, p);
    assert.deepEqual(ns(m.overdue), [16]);
  });

  it('completing overdue but not today, and today but not overdue', async () => {
    const { wird, goTo } = setup();
    const p = await wird.createPlan(madinah());
    goTo(day(1));
    let d = await today(wird, p);
    await wird.complete(refs(d.overdue));
    d = await today(wird, p);
    assert.equal(d.status, 'partial');
    assert.ok(d.overdue.every((u) => u.done && u.doneOn === day(1)), 'overdue done today stays visible as done');
    goTo(day(2));
    d = await today(wird, p);
    assert.deepEqual(ns(d.overdue), [17, 18, 19, 20]);
    await wird.complete(refs(d.scheduled));
    goTo(day(3));
    d = await today(wird, p);
    assert.deepEqual(ns(d.overdue), [17, 18, 19, 20], 'Tuesday was done, Monday still waits');
  });

  it('rest days get no automatic revision; overdue is optional there and moves to the next eligible day', async () => {
    const { wird, goTo } = setup();
    const p = await wird.createPlan(madinah({ fullDayOverdue: 'full_only' }));
    goTo(day(6)); // Saturday: rest
    const sat = await today(wird, p);
    assert.equal(sat.type, 'rest');
    assert.equal(sat.status, 'rest');
    assert.equal(sat.required.length, 0);
    assert.equal(sat.optional.length, 18, 'whole week missed, may be reviewed by choice');
    assert.equal(sat.nextEligible, day(7), 'Friday "full only" and Saturday rest are skipped → Sunday');
    await wird.complete(refs(sat.optional.slice(0, 2)));
    goTo(day(7));
    const sun = await today(wird, p);
    assert.ok(!sun.overdue.some((u) => u.n === 13 || u.n === 14), 'reviewed on the rest day by choice');
  });

  it('full revision day: tracked separately, overdue per setting, never completes daily tasks', async () => {
    const { wird, goTo, store } = setup();
    const p = await wird.createPlan(madinah());
    goTo(day(5)); // Friday
    const fri = await today(wird, p);
    assert.equal(fri.type, 'full');
    assert.equal(fri.full.length, 18);
    assert.equal(fri.overdue.length, 18, 'full + overdue');
    await wird.complete(refs(fri.full), 'excellent');
    const after = await today(wird, p);
    assert.equal(after.overdue.filter((u) => u.done).length, 0, 'full revision does not tick daily units');
    const s = wirdStats([p], await store.wirdTasks.getAll(), day(5));
    assert.equal(s.plans[0]?.done, 0);
    assert.equal(s.plans[0]?.full.complete, 1);
  });

  it('carry-over crosses the week boundary, and the next cycle merges the old copy', async () => {
    const { wird, goTo, store } = setup();
    const p = await wird.createPlan(madinah());
    goTo(day(7)); // next Sunday: 13–16 scheduled again
    const sun = await today(wird, p);
    assert.deepEqual(ns(sun.scheduled), [13, 14, 15, 16]);
    assert.ok(!sun.overdue.some((u) => [13, 14, 15, 16].includes(u.n)), 'no unit twice');
    assert.deepEqual(ns(sun.overdue), [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    const old = (await store.wirdTasks.getAll()).find((t) => t.date === SUN && t.kind === 'daily') as WirdTask;
    assert.ok(old.units.every((u) => u.closed === 'merged' && u.mergedInto === `wt:${p.id}:${day(7)}:daily`), 'kept in history');
    const s = wirdStats([p], await store.wirdTasks.getAll(), day(7));
    assert.equal(s.plans[0]?.merged, 4);
    assert.equal(s.plans[0]?.days.missed, 1);
  });

  it('Priority: overdue first within the normal daily amount; new units are postponed in order', async () => {
    const { wird, goTo } = setup();
    const p = await wird.createPlan(madinah({ carry: 'priority' }));
    goTo(day(1));
    let d = await today(wird, p);
    assert.deepEqual(ns(d.overdue), [13, 14, 15, 16]);
    assert.deepEqual(ns(d.scheduled), []);
    assert.deepEqual(ns(d.postponed), [17, 18, 19, 20]);
    assert.equal(d.required.length, 4);
    await wird.complete(refs(d.required));
    assert.equal((await today(wird, p)).status, 'done');
    goTo(day(2));
    d = await today(wird, p);
    assert.deepEqual(ns(d.overdue), [17, 18, 19, 20]);
    assert.deepEqual(ns(d.postponed), [21, 22, 23, 24]);
  });

  it('Flexible: proposes spreading overdue over the rest of the week; until approved it acts like Strict', async () => {
    const { wird, goTo } = setup();
    const p = await wird.createPlan(madinah({ carry: 'flexible' }));
    goTo(day(2)); // Tuesday; Sunday + Monday missed (8 units)
    let d = await today(wird, p);
    assert.equal(d.overdue.length, 8);
    const proposal = await wird.proposeSpread(p.id);
    assert.deepEqual(proposal.days.map((x) => [x.date, ns(x.units)]), [
      [day(2), [13, 14]],
      [day(3), [15, 16]],
      [day(4), [17, 18]],
      [day(5), [19, 20]],
    ]);
    await wird.applySpread(proposal);
    d = await today(wird, p);
    assert.deepEqual(ns(d.overdue), [13, 14]);
    assert.equal(d.spread.length, 6);
    const { tasks } = await wird.list();
    assert.deepEqual(ns(planDay(p, tasks, day(3), day(2)).spread), [15, 16], 'the week view shows moved units on their new day');
    goTo(day(4)); // Thursday, Wednesday's share not done → overdue again
    d = await today(wird, p);
    assert.deepEqual(ns(d.overdue).slice(0, 4), [13, 14, 15, 16]);
  });

  it('flexible proposal never lands on rest days', () => {
    const plan: WirdPlan = { id: 'p', name: 'x', color: 0, status: 'active', startDate: SUN, pauses: [], createdAt: '', updatedAt: '', configs: [{ ...madinah({ carry: 'flexible', fullDayOverdue: 'full_only' }).config, startOffset: 0, effectiveFrom: SUN }] };
    const t: WirdTask = { id: 'wt:p:' + SUN + ':daily', planId: 'p', date: SUN, kind: 'daily', unit: 'hizb', units: [13, 14, 15, 16].map((n) => ({ n, doneAt: null, doneOn: null, quality: null, dueOn: null, closed: null, closedOn: null, mergedInto: null })), note: null, createdAt: '', updatedAt: '' };
    const pr = proposeSpread(plan, [t], day(4)); // Thursday: Fri full-only, Sat rest → next days
    assert.ok(pr.days.every((x) => ![day(5), day(6)].includes(x.date)));
    assert.equal(pr.days.reduce((s, x) => s + x.units.length, 0), 4);
  });
});

describe('Wird plan changes', () => {
  it('editing keeps history, applies from today, removes overdue outside the new range', async () => {
    const { wird, goTo, store } = setup();
    const p = await wird.createPlan(madinah());
    const sun = await today(wird, p);
    await wird.complete(refs(sun.scheduled.slice(0, 2)), 'weak');
    goTo(day(2)); // Tuesday; Mon 17–20 missed, Sun 15–16 open
    const { effectiveFrom } = await wird.updatePlan(p.id, { ...madinah({ to: 18 }), name: 'Madinah' });
    assert.equal(effectiveFrom, day(2));
    const tasks = await store.wirdTasks.getAll();
    const sunTask = tasks.find((t) => t.date === SUN) as WirdTask;
    assert.deepEqual(sunTask.units.filter((u) => u.doneAt).map((u) => [u.n, u.quality]), [[13, 'weak'], [14, 'weak']], 'completion history preserved');
    const plan = (await wird.list()).plans[0] as WirdPlan;
    assert.equal(plan.configs.length, 2);
    const d = await today(wird, plan);
    // New split of 13–18 over Sun–Thu: Tuesday = Hizb 16, which merges Sunday's open copy.
    assert.deepEqual(ns(d.scheduled), [16], 'today rebuilt from the new range');
    assert.deepEqual(ns(d.overdue), [15, 17, 18]);
    const mon = (await store.wirdTasks.getAll()).find((t) => t.date === day(1)) as WirdTask;
    assert.deepEqual(mon.units.map((u) => u.closed), [null, null, 'removed', 'removed']);
    const s = wirdStats([plan], tasks, day(2));
    assert.equal(s.plans[0]?.scheduled, 6, 'Sun 4 + Mon 4 − 2 removed');
    assert.equal(s.plans[0]?.done, 2);
  });

  it('closes overdue outside a shrunk range as removed (not missed)', async () => {
    const { wird, goTo, store } = setup();
    const p = await wird.createPlan(madinah());
    goTo(day(2));
    await wird.updatePlan(p.id, madinah({ from: 21, to: 30 }));
    const tasks = await store.wirdTasks.getAll();
    const sunTask = tasks.find((t) => t.date === SUN) as WirdTask;
    assert.ok(sunTask.units.every((u) => u.closed === 'removed'));
    const plan = (await wird.list()).plans[0] as WirdPlan;
    assert.equal((await today(wird, plan)).overdue.length, 0);
    const st = wirdStats([plan], tasks, day(2)).plans[0];
    assert.equal(st?.days.missed, 0, 'removed units are not missed');
    assert.equal(st?.days.complete, 0, '…and not complete either');
  });

  it('an edit after ticking today applies from tomorrow, leaving today intact', async () => {
    const { wird } = setup();
    const p = await wird.createPlan(madinah());
    const d = await today(wird, p);
    await wird.complete(refs(d.scheduled.slice(0, 1)));
    const { effectiveFrom } = await wird.updatePlan(p.id, madinah({ from: 1, to: 5 }));
    assert.equal(effectiveFrom, day(1));
    const plan = (await wird.list()).plans[0] as WirdPlan;
    assert.deepEqual(ns((await today(wird, plan)).scheduled), [13, 14, 15, 16]);
  });

  it('pause and resume: paused days get no tasks and are not missed; overdue carries on', async () => {
    const { wird, goTo, store } = setup();
    const p = await wird.createPlan(madinah());
    goTo(day(1));
    await wird.pause(p.id);
    goTo(day(3));
    await wird.refresh();
    assert.deepEqual((await store.wirdTasks.getAll()).map((t) => t.date), [SUN]);
    const resumed = await wird.resume(p.id);
    const d = await today(wird, resumed);
    assert.deepEqual(ns(d.overdue), [13, 14, 15, 16]);
    assert.deepEqual(ns(d.scheduled), [25, 26, 27]);
    assert.equal(wirdStats([resumed], await store.wirdTasks.getAll(), day(3)).plans[0]?.days.missed, 0);
  });

  it('fixed daily amount continues where it was after an edit', async () => {
    const { wird, goTo } = setup();
    const p = await wird.createPlan({ ...madinah(), config: { ...madinah().config, unit: 'juz', from: 1, to: 5, cycle: 'daily', dailyAmount: 2, fullDays: [] } });
    goTo(day(1));
    let d = await today(wird, p);
    assert.deepEqual(ns(d.overdue), [1, 2]);
    assert.deepEqual(ns(d.scheduled), [3, 4]);
    await wird.updatePlan(p.id, { ...madinah(), config: { ...madinah().config, unit: 'juz', from: 1, to: 5, cycle: 'daily', dailyAmount: 1, fullDays: [] } });
    const plan = (await wird.list()).plans[0] as WirdPlan;
    d = await today(wird, plan);
    assert.deepEqual(ns(d.scheduled), [3], 'continues after Juz 2 (Sunday), not from the start');
  });

  it('deleting one plan leaves the others and their history', async () => {
    const { wird } = setup();
    const a = await wird.createPlan(madinah());
    const b = await wird.createPlan(morocco());
    await wird.complete(refs((await today(wird, b)).scheduled));
    await wird.deletePlan(a.id);
    const { plans, tasks } = await wird.list();
    assert.deepEqual(plans.map((p) => p.id), [b.id]);
    assert.ok(tasks.every((t) => t.planId === b.id));
    assert.equal(tasks[0]?.units.every((u) => u.doneAt), true);
  });

  it('undoing a tick reopens the unit (or merges it if it has been scheduled again)', async () => {
    const { wird, goTo } = setup();
    const p = await wird.createPlan(madinah());
    const d = await today(wird, p);
    await wird.complete(refs(d.scheduled));
    await wird.uncomplete(refs(d.scheduled.slice(0, 1)));
    goTo(day(1));
    assert.deepEqual(ns((await today(wird, p)).overdue), [13]);
  });
});

describe('Wird statistics', () => {
  it('rates, quality, difficult units and a forgiving streak come from completion records', async () => {
    const { wird, goTo, store } = setup();
    const a = await wird.createPlan(madinah());
    const b = await wird.createPlan(morocco());
    // Sun: both plans touched. Mon: only Madinah. Tue: both. Wed: both.
    for (const [offset, plans] of [[0, [a, b]], [1, [a]], [2, [a, b]], [3, [a, b]]] as const) {
      goTo(day(offset));
      for (const p of plans) {
        const d = await today(wird, p);
        await wird.complete(refs(d.scheduled.slice(0, 1)), offset === 2 ? 'weak' : 'good');
      }
    }
    const s = wirdStats([a, b], await store.wirdTasks.getAll(), day(3));
    assert.equal(s.streak.current, 2, 'Monday broke it (Morocco untouched); Tue + Wed');
    assert.equal(s.streak.best, 2);
    assert.equal(s.quality.weak, 2);
    assert.equal(s.difficult[0]?.count, 1);
    assert.equal(s.plans[0]?.days.partial, 3);
    assert.equal(s.unitsDone.hizb, 7);
    goTo(day(6)); // Saturday: Morocco full revision, Madinah rest → does not break or count
    await wird.refresh();
    const s2 = wirdStats([a, b], await store.wirdTasks.getAll(), day(6));
    assert.equal(s2.streak.current, 0, 'Thursday was missed');
  });
});

describe('Wird persistence', () => {
  it('backups include Wird plans and tasks; schema-1 backups migrate', async () => {
    const { wird, store } = setup();
    await wird.createPlan(madinah());
    const backup = await exportBackup(store, new Date(at(SUN)));
    const parsed = parseBackup(JSON.parse(JSON.stringify(backup)));
    assert.equal(parsed.data.wirdPlans.length, 1);
    const other = createMemoryStore();
    await restoreBackup(other, parsed, 'replace');
    assert.equal((await other.wirdTasks.getAll()).length, 1);
    const v1 = { ...backup, schemaVersion: 1, data: { ...backup.data, wirdPlans: undefined, wirdTasks: undefined } };
    assert.deepEqual(parseBackup(JSON.parse(JSON.stringify(v1))).data.wirdPlans, []);
  });

  it('migrates an unfinished week plan into a manual weekly Wird configuration', () => {
    const index = new DivisionIndex(syntheticDivisions());
    const dp = (date: string, n: number) => ({ id: date, date, kind: 'revision' as const, scope: { type: 'division' as const, kind: 'hizb' as const, number: n }, status: 'pending' as const, sessionIds: [], createdAt: '', updatedAt: '', completedAt: null });
    const c = configFromPeriod({ period: 'week', start: SUN, end: day(6) }, [dp(SUN, 5), dp(day(1), 6), dp(day(2), 7)], index, SUN);
    assert.ok(c);
    assert.equal(c.unit, 'hizb');
    assert.deepEqual([c.from, c.to], [5, 7]);
    assert.deepEqual(c.revisionDays, [0, 1, 2]);
    assert.equal(c.distribution, 'manual');
    assert.equal(configFromPeriod({ period: 'week', start: '2026-01-01', end: '2026-01-07' }, [], index, SUN), null, 'finished plans are not migrated');
  });
});
