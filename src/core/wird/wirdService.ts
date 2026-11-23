/** Persistence around the Wird engine. Every write first brings tasks up to date (idempotent). */
import type { Store } from '../storage/store.ts';
import { localDateKey, type Clock, type IdGenerator } from '../util/ids.ts';
import { isDateKey, type Weekday } from './dates.ts';
import { checkManual, manualOk } from './distribution.ts';
import {
  applyEdit,
  applySpread,
  materialize,
  pausePlan,
  proposeSpread,
  resumePlan,
  setDone,
  setQuality,
  type ConfigInput,
  type PlanChange,
  type SpreadProposal,
  type UnitRef,
} from './engine.ts';
import type { Quality, WirdPlan, WirdTask } from './model.ts';
import { validateRange } from './units.ts';

export class WirdError extends Error {
  /** Stable code for localized messages. */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WirdError';
    this.code = code;
  }
}

export interface PlanInput {
  readonly name: string;
  readonly color: number;
  readonly startDate: string;
  readonly config: ConfigInput;
}

/** Throws a WirdError when a configuration cannot be saved. */
export function validateConfig(c: ConfigInput): void {
  const r = validateRange(c.unit, c.from, c.to);
  if (r) throw new WirdError(`range.${r}`, 'The Quran range is not valid.');
  const days = new Set<Weekday>(c.revisionDays);
  if (!days.size) throw new WirdError('days.none', 'Choose at least one revision day.');
  if (c.fullDays.some((d) => days.has(d))) throw new WirdError('days.overlap', 'A day cannot be both a revision day and a full revision day.');
  if (c.cycle === 'weekly' && c.distribution === 'manual' && !manualOk(checkManual(c), c.allowGaps)) throw new WirdError('manual.invalid', 'The daily ranges leave out or repeat units.');
  if (c.cycle === 'daily' && (!Number.isInteger(c.dailyAmount) || c.dailyAmount < 1)) throw new WirdError('amount', 'The daily amount must be at least 1.');
  if (c.targetDate !== null && !isDateKey(c.targetDate)) throw new WirdError('date', 'The target date is not valid.');
}

export class WirdService {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(deps: { store: Store; clock: Clock; ids: IdGenerator }) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.ids = deps.ids;
  }

  today(): string {
    return localDateKey(this.clock.now());
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  /** Generates missing tasks for every plan up to today. Safe to call on every load. Returns how many tasks were written. */
  async refresh(): Promise<number> {
    const [plans, tasks] = await Promise.all([this.store.wirdPlans.getAll(), this.store.wirdTasks.getAll()]);
    const today = this.today();
    const nowIso = this.nowIso();
    const writes: WirdTask[] = [];
    for (const p of plans) {
      const c = materialize(p, tasks, today, nowIso);
      writes.push(...c.created, ...c.updated);
    }
    if (writes.length) await this.store.wirdTasks.putMany(writes);
    return writes.length;
  }

  async list(): Promise<{ plans: WirdPlan[]; tasks: WirdTask[] }> {
    const [plans, tasks] = await Promise.all([this.store.wirdPlans.getAll(), this.store.wirdTasks.getAll()]);
    plans.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return { plans, tasks };
  }

  private async requirePlan(id: string): Promise<WirdPlan> {
    const p = await this.store.wirdPlans.get(id);
    if (!p) throw new WirdError('plan.missing', 'This plan no longer exists.');
    return p;
  }

  private async save(change: PlanChange): Promise<WirdPlan> {
    for (const id of change.deleted) await this.store.wirdTasks.delete(id);
    if (change.updated.length) await this.store.wirdTasks.putMany(change.updated);
    await this.store.wirdPlans.put(change.plan);
    await this.refresh();
    return change.plan;
  }

  async createPlan(input: PlanInput, migratedFrom?: string): Promise<WirdPlan> {
    const name = input.name.trim();
    if (!name) throw new WirdError('name', 'Give the plan a name.');
    if (!isDateKey(input.startDate)) throw new WirdError('date', 'The start date is not valid.');
    validateConfig(input.config);
    const nowIso = this.nowIso();
    const plan: WirdPlan = {
      id: this.ids('wird'),
      name: name.slice(0, 80),
      color: input.color,
      status: 'active',
      startDate: input.startDate,
      configs: [{ ...input.config, startOffset: input.config.startOffset ?? 0, effectiveFrom: input.startDate }],
      pauses: [],
      createdAt: nowIso,
      updatedAt: nowIso,
      ...(migratedFrom ? { migratedFrom } : {}),
    };
    await this.store.wirdPlans.put(plan);
    await this.refresh();
    return plan;
  }

  async updatePlan(id: string, input: PlanInput): Promise<{ plan: WirdPlan; effectiveFrom: string }> {
    const name = input.name.trim();
    if (!name) throw new WirdError('name', 'Give the plan a name.');
    validateConfig(input.config);
    await this.refresh();
    const plan = await this.requirePlan(id);
    const change = applyEdit(plan, await this.store.wirdTasks.getAll(), input.config, this.today(), this.nowIso(), { name: name.slice(0, 80), color: input.color, startDate: input.startDate });
    return { plan: await this.save(change), effectiveFrom: change.effectiveFrom };
  }

  async pause(id: string): Promise<WirdPlan> {
    await this.refresh();
    return this.save(pausePlan(await this.requirePlan(id), await this.store.wirdTasks.getAll(), this.today(), this.nowIso()));
  }

  async archive(id: string): Promise<WirdPlan> {
    await this.refresh();
    return this.save(pausePlan(await this.requirePlan(id), await this.store.wirdTasks.getAll(), this.today(), this.nowIso(), true));
  }

  /** Resumes a paused plan or restores an archived one, from today. */
  async resume(id: string): Promise<WirdPlan> {
    const plan = resumePlan(await this.requirePlan(id), this.today(), this.nowIso());
    await this.store.wirdPlans.put(plan);
    await this.refresh();
    return plan;
  }

  /** Deletes a plan with its whole history. Other plans are untouched. */
  async deletePlan(id: string): Promise<void> {
    const tasks = (await this.store.wirdTasks.getAll()).filter((t) => t.planId === id);
    for (const t of tasks) await this.store.wirdTasks.delete(t.id);
    await this.store.wirdPlans.delete(id);
  }

  async complete(refs: readonly UnitRef[], quality?: Quality | null): Promise<number> {
    await this.refresh();
    const changed = setDone(await this.store.wirdTasks.getAll(), refs, true, this.today(), this.nowIso(), quality);
    if (changed.length) await this.store.wirdTasks.putMany(changed);
    return changed.length;
  }

  async uncomplete(refs: readonly UnitRef[]): Promise<void> {
    const changed = setDone(await this.store.wirdTasks.getAll(), refs, false, this.today(), this.nowIso());
    if (changed.length) await this.store.wirdTasks.putMany(changed);
  }

  async rate(refs: readonly UnitRef[], quality: Quality | null): Promise<void> {
    const changed = setQuality(await this.store.wirdTasks.getAll(), refs, quality, this.nowIso());
    if (changed.length) await this.store.wirdTasks.putMany(changed);
  }

  async setNote(taskId: string, note: string): Promise<void> {
    const t = await this.store.wirdTasks.get(taskId);
    if (!t) throw new WirdError('task.missing', 'This revision task no longer exists.');
    const text = note.trim().slice(0, 2000);
    await this.store.wirdTasks.put({ ...t, note: text || null, updatedAt: this.nowIso() });
  }

  async proposeSpread(planId: string): Promise<SpreadProposal> {
    await this.refresh();
    return proposeSpread(await this.requirePlan(planId), await this.store.wirdTasks.getAll(), this.today());
  }

  async applySpread(proposal: SpreadProposal): Promise<void> {
    const changed = applySpread(await this.store.wirdTasks.getAll(), proposal, this.nowIso());
    if (changed.length) await this.store.wirdTasks.putMany(changed);
  }
}
