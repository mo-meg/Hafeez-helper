/**
 * Wird Planner engine: pure functions over plans and tasks (no storage, no clock).
 *
 * - Tasks are generated ("materialized") for every past day up to today with a deterministic id,
 *   so running the generation again never duplicates anything.
 * - Carry-over is computed, not copied: the overdue units of a day are the open units of earlier
 *   daily tasks. Completing one writes the completion on the task that scheduled it.
 * - When a unit is scheduled again as a fresh daily assignment, its open overdue copy is closed as
 *   `merged` (kept in history), so the backlog never holds the same unit twice.
 */
import { balancedSizes, dailyUnits, weeklyUnits } from './distribution.ts';
import { datesBetween, shiftDate, weekdayOf, weekStartOf } from './dates.ts';
import {
  isOpen,
  newUnit,
  taskId,
  type CarryMode,
  type ClosedReason,
  type Quality,
  type TaskKind,
  type WirdConfig,
  type WirdPlan,
  type WirdTask,
  type WirdTaskUnit,
} from './model.ts';
import { quarterSpan, rangeQuarterSpan, spanContains, type WirdUnit } from './units.ts';

// ------------------------------------------------------------------ plan calendar

export function configAt(plan: WirdPlan, date: string): WirdConfig | null {
  if (date < plan.startDate) return null;
  let found: WirdConfig | null = null;
  for (const c of plan.configs) if (c.effectiveFrom <= date) found = c;
  return found ?? plan.configs[0] ?? null;
}

export const currentConfig = (plan: WirdPlan, today: string): WirdConfig => configAt(plan, today < plan.startDate ? plan.startDate : today) ?? (plan.configs[plan.configs.length - 1] as WirdConfig);

export function isPaused(plan: WirdPlan, date: string): boolean {
  return plan.pauses.some((p) => p.from <= date && (p.to === null || date < p.to));
}

export type DayType = 'revision' | 'full' | 'rest' | 'paused' | 'inactive';

export function dayType(plan: WirdPlan, date: string): DayType {
  const c = configAt(plan, date);
  if (!c) return 'inactive';
  if (isPaused(plan, date)) return 'paused';
  const wd = weekdayOf(date);
  if (c.fullDays.includes(wd)) return 'full';
  if (c.revisionDays.includes(wd)) return 'revision';
  return 'rest';
}

/** Number of (unpaused) revision days of `c` from its effectiveFrom up to, not including, `date`. */
function revisionIndex(plan: WirdPlan, c: WirdConfig, date: string): number {
  let k = 0;
  const from = c.effectiveFrom < plan.startDate ? plan.startDate : c.effectiveFrom;
  for (let d = from; d < date; d = shiftDate(d, 1)) if (c.revisionDays.includes(weekdayOf(d)) && !c.fullDays.includes(weekdayOf(d)) && !isPaused(plan, d)) k++;
  return k;
}

/** What the configuration schedules on a date (whether or not a task exists for it yet). */
export function scheduledFor(plan: WirdPlan, date: string): { kind: TaskKind; unit: WirdUnit; units: number[] } | null {
  const type = dayType(plan, date);
  const c = configAt(plan, date);
  if (!c) return null;
  if (type === 'full') {
    const units: number[] = [];
    for (let n = c.from; n <= c.to; n++) units.push(n);
    return { kind: 'full', unit: c.unit, units };
  }
  if (type !== 'revision') return null;
  const units = c.cycle === 'weekly' ? weeklyUnits(c, weekdayOf(date)) : dailyUnits(c, revisionIndex(plan, c, date));
  return units.length ? { kind: 'daily', unit: c.unit, units } : null;
}

/** Overdue units are shown as required on this kind of day. */
function takesOverdue(plan: WirdPlan, date: string): boolean {
  const type = dayType(plan, date);
  if (type === 'revision') return true;
  if (type === 'full') return configAt(plan, date)?.fullDayOverdue !== 'full_only';
  return false;
}

/** The next day after `date` on which overdue revision is due again (rest days are skipped). */
export function nextEligibleDay(plan: WirdPlan, date: string, horizon = 28): string | null {
  for (let i = 1; i <= horizon; i++) {
    const d = shiftDate(date, i);
    if (takesOverdue(plan, d)) return d;
  }
  return null;
}

// ------------------------------------------------------------------ materialization

function quarters(unit: WirdUnit, numbers: readonly number[]): Set<number> {
  const out = new Set<number>();
  for (const n of numbers) {
    const s = quarterSpan(unit, n);
    for (let q = s.from; q <= s.to; q++) out.add(q);
  }
  return out;
}

function covered(set: Set<number>, unit: WirdUnit, n: number): boolean {
  const s = quarterSpan(unit, n);
  for (let q = s.from; q <= s.to; q++) if (!set.has(q)) return false;
  return true;
}

const withUnits = (t: WirdTask, units: WirdTaskUnit[], nowIso: string): WirdTask => ({ ...t, units, updatedAt: nowIso });

/** Closes open units of earlier daily tasks that the new daily task schedules again. */
function mergeInto(newTask: WirdTask, tasks: Map<string, WirdTask>, changed: Set<string>, nowIso: string): void {
  const cover = quarters(newTask.unit, newTask.units.map((u) => u.n));
  for (const t of tasks.values()) {
    if (t.planId !== newTask.planId || t.kind !== 'daily' || t.date >= newTask.date) continue;
    let touched = false;
    const units = t.units.map((u) => {
      if (!isOpen(u) || !covered(cover, t.unit, u.n)) return u;
      touched = true;
      return { ...u, closed: 'merged' as ClosedReason, closedOn: newTask.date, mergedInto: newTask.id };
    });
    if (touched) {
      tasks.set(t.id, withUnits(t, units, nowIso));
      changed.add(t.id);
    }
  }
}

export interface Changes {
  readonly created: WirdTask[];
  readonly updated: WirdTask[];
}

/**
 * Generates the missing tasks of a plan for every day up to and including `today`. Idempotent:
 * existing ids are never regenerated, so refreshing or running it twice changes nothing.
 */
export function materialize(plan: WirdPlan, tasks: readonly WirdTask[], today: string, nowIso: string): Changes {
  const map = new Map(tasks.filter((t) => t.planId === plan.id).map((t) => [t.id, t]));
  let latest = '';
  for (const t of map.values()) if (t.date > latest) latest = t.date;
  const from = latest && latest >= plan.startDate ? shiftDate(latest, 1) : plan.startDate;
  if (from > today) return { created: [], updated: [] };
  const created: WirdTask[] = [];
  const changed = new Set<string>();
  for (const date of datesBetween(from, today)) {
    const s = scheduledFor(plan, date);
    if (!s) continue;
    const id = taskId(plan.id, date, s.kind);
    if (map.has(id)) continue;
    const task: WirdTask = { id, planId: plan.id, date, kind: s.kind, unit: s.unit, units: s.units.map(newUnit), note: null, createdAt: nowIso, updatedAt: nowIso };
    if (s.kind === 'daily') mergeInto(task, map, changed, nowIso);
    map.set(id, task);
    created.push(task);
  }
  const createdIds = new Set(created.map((t) => t.id));
  return { created, updated: [...changed].filter((id) => !createdIds.has(id)).map((id) => map.get(id) as WirdTask) };
}

// ------------------------------------------------------------------ one plan, one day

export interface UnitItem {
  readonly taskId: string;
  readonly taskDate: string;
  readonly kind: TaskKind;
  readonly unit: WirdUnit;
  readonly n: number;
  readonly done: boolean;
  readonly doneOn: string | null;
  readonly quality: Quality | null;
  readonly dueOn: string | null;
  readonly closed: ClosedReason | null;
}

export type DayStatus = 'done' | 'partial' | 'pending' | 'overdue' | 'missed' | 'rest' | 'paused' | 'inactive' | 'upcoming';

export interface PlanDay {
  readonly plan: WirdPlan;
  readonly date: string;
  readonly type: DayType;
  readonly config: WirdConfig | null;
  /** This day's own assignment (daily task). */
  readonly scheduled: UnitItem[];
  /** Full revision units (full revision day). */
  readonly full: UnitItem[];
  /** Carried from earlier days and required today (today only). */
  readonly overdue: UnitItem[];
  /** Overdue that may be reviewed today but is not required (rest day, "full only" day). */
  readonly optional: UnitItem[];
  /** Priority mode: open units beyond today's capacity; they move to the next revision day. */
  readonly postponed: UnitItem[];
  /** Flexible mode: overdue units moved to later days. */
  readonly spread: UnitItem[];
  readonly required: UnitItem[];
  readonly status: DayStatus;
  /** Next day overdue revision is due (for rest days and "full only" days). */
  readonly nextEligible: string | null;
  /** True for future days: what the configuration will schedule, not yet a task. */
  readonly preview: boolean;
}

const item = (t: WirdTask, u: WirdTaskUnit): UnitItem => ({ taskId: t.id, taskDate: t.date, kind: t.kind, unit: t.unit, n: u.n, done: u.doneAt !== null, doneOn: u.doneOn, quality: u.quality, dueOn: u.dueOn, closed: u.closed });
const byOrder = (a: UnitItem, b: UnitItem) => (a.taskDate === b.taskDate ? quarterSpan(a.unit, a.n).from - quarterSpan(b.unit, b.n).from : a.taskDate < b.taskDate ? -1 : 1);

function statusOf(units: readonly UnitItem[]): DayStatus {
  const live = units.filter((u) => u.closed !== 'removed');
  if (!live.length) return 'done';
  const done = live.filter((u) => u.done).length;
  if (done === live.length) return 'done';
  if (done > 0) return 'partial';
  return live.some((u) => !u.done && u.closed === null) ? 'overdue' : 'missed';
}

/** Everything one plan asks for on one date. Pure; `tasks` may contain other plans' tasks. */
export function planDay(plan: WirdPlan, tasks: readonly WirdTask[], date: string, today: string): PlanDay {
  const type = dayType(plan, date);
  const config = configAt(plan, date);
  const own = tasks.filter((t) => t.planId === plan.id);
  const base = { plan, date, type, config, scheduled: [] as UnitItem[], full: [] as UnitItem[], overdue: [] as UnitItem[], optional: [] as UnitItem[], postponed: [] as UnitItem[], spread: [] as UnitItem[], required: [] as UnitItem[], nextEligible: null as string | null, preview: false };
  const daily = own.find((t) => t.date === date && t.kind === 'daily');
  const fullTask = own.find((t) => t.date === date && t.kind === 'full');
  const scheduled = daily ? daily.units.map((u) => item(daily, u)) : [];
  const full = fullTask ? fullTask.units.map((u) => item(fullTask, u)) : [];

  if (date > today) {
    const s = scheduledFor(plan, date);
    const fake = (kind: TaskKind, unit: WirdUnit, n: number): UnitItem => ({ taskId: taskId(plan.id, date, kind), taskDate: date, kind, unit, n, done: false, doneOn: null, quality: null, dueOn: null, closed: null });
    const spreadHere = own.filter((t) => t.kind === 'daily' && t.date < today).flatMap((t) => t.units.filter((u) => isOpen(u) && u.dueOn === date).map((u) => item(t, u)));
    return {
      ...base,
      scheduled: s?.kind === 'daily' ? s.units.map((n) => fake('daily', s.unit, n)) : [],
      full: s?.kind === 'full' ? s.units.map((n) => fake('full', s.unit, n)) : [],
      spread: spreadHere,
      status: type === 'revision' || type === 'full' ? 'upcoming' : type,
      preview: true,
    };
  }

  if (date < today) {
    const units = [...scheduled, ...full];
    const status: DayStatus = units.length ? statusOf(units) : type === 'revision' || type === 'full' ? 'done' : type;
    return { ...base, scheduled, full, required: units, status };
  }

  // Today.
  const earlier = own.filter((t) => t.kind === 'daily' && t.date < date);
  const carried: UnitItem[] = [];
  const spread: UnitItem[] = [];
  for (const t of earlier) {
    for (const u of t.units) {
      if (isOpen(u)) (u.dueOn && u.dueOn > date ? spread : carried).push(item(t, u));
      else if (u.doneOn === date) carried.push(item(t, u));
    }
  }
  carried.sort(byOrder);
  spread.sort(byOrder);
  const nextEligible = takesOverdue(plan, date) ? null : nextEligibleDay(plan, date);
  if (type === 'paused' || type === 'inactive') return { ...base, status: type, nextEligible: null };
  if (!takesOverdue(plan, date)) {
    const required = [...full];
    const status: DayStatus = required.length ? statusOf(required) : type === 'rest' ? 'rest' : 'done';
    return { ...base, full, optional: carried, spread, required, status: status === 'overdue' ? 'pending' : status, nextEligible };
  }

  let overdue = carried;
  let shown = scheduled;
  let postponed: UnitItem[] = [];
  if (type === 'revision' && config?.carry === 'priority') {
    const cap = Math.max(scheduled.length, 1);
    const combined = [...carried, ...scheduled];
    const doneToday = combined.filter((u) => u.done && u.doneOn === date).length;
    let room = Math.max(0, cap - doneToday);
    const now = new Set<UnitItem>();
    for (const u of combined) {
      if (u.done) {
        if (u.doneOn === date || u.kind === 'daily') now.add(u);
      } else if (room > 0) {
        now.add(u);
        room--;
      }
    }
    overdue = carried.filter((u) => now.has(u));
    shown = scheduled.filter((u) => now.has(u));
    postponed = combined.filter((u) => !now.has(u) && !u.done);
  }
  const required = config?.fullDayOverdue === 'overdue_first' || type === 'revision' ? [...overdue, ...shown, ...full] : [...full, ...overdue, ...shown];
  const st = required.length ? statusOf(required) : 'done';
  return { ...base, scheduled: shown, full, overdue, postponed, spread, required, status: st === 'overdue' || st === 'missed' ? 'pending' : st, nextEligible };
}

/** Open overdue units of a plan as of today (due today or earlier, excluding Flexible units moved later). */
export function openOverdue(plan: WirdPlan, tasks: readonly WirdTask[], today: string): UnitItem[] {
  return tasks
    .filter((t) => t.planId === plan.id && t.kind === 'daily' && t.date < today)
    .flatMap((t) => t.units.filter((u) => isOpen(u) && !(u.dueOn && u.dueOn > today)).map((u) => item(t, u)))
    .sort(byOrder);
}

// ------------------------------------------------------------------ Flexible: spread overdue

export interface SpreadProposal {
  readonly days: ReadonlyArray<{ readonly date: string; readonly units: readonly UnitItem[] }>;
}

/**
 * Flexible mode: spreads the open overdue units, in Quran order, over the coming revision days —
 * the rest of the plan's week (weekly cycle) or the next 3 revision days, starting today.
 */
export function proposeSpread(plan: WirdPlan, tasks: readonly WirdTask[], today: string): SpreadProposal {
  const units = openOverdue(plan, tasks, today);
  if (!units.length) return { days: [] };
  const c = currentConfig(plan, today);
  const eligible = (d: string) => takesOverdue(plan, d);
  let targets: string[] = [];
  if (c.cycle === 'weekly') {
    const end = shiftDate(weekStartOf(today, c.weekStart), 6);
    targets = datesBetween(today, end).filter(eligible);
  }
  if (targets.length < 2) {
    targets = [];
    for (let i = 0; i < 28 && targets.length < 3; i++) {
      const d = shiftDate(today, i);
      if (eligible(d)) targets.push(d);
    }
  }
  const sizes = balancedSizes(units.length, targets.length);
  const days: Array<{ date: string; units: UnitItem[] }> = [];
  let at = 0;
  targets.forEach((date, i) => {
    const size = sizes[i] ?? 0;
    if (size > 0) days.push({ date, units: units.slice(at, at + size) });
    at += size;
  });
  return { days };
}

export function applySpread(tasks: readonly WirdTask[], proposal: SpreadProposal, nowIso: string): WirdTask[] {
  const due = new Map<string, string>();
  for (const d of proposal.days) for (const u of d.units) due.set(`${u.taskId}#${u.n}`, d.date);
  const out: WirdTask[] = [];
  for (const t of tasks) {
    let touched = false;
    const units = t.units.map((u) => {
      const d = due.get(`${t.id}#${u.n}`);
      if (!d || !isOpen(u)) return u;
      touched = true;
      return { ...u, dueOn: d };
    });
    if (touched) out.push(withUnits(t, units, nowIso));
  }
  return out;
}

// ------------------------------------------------------------------ completion

export interface UnitRef {
  readonly taskId: string;
  readonly n: number;
}

/**
 * Marks units done (with optional quality) or not done. Closed units are left alone. Undoing a unit
 * that has since been scheduled again closes it as merged instead of reopening a duplicate.
 */
export function setDone(tasks: readonly WirdTask[], refs: readonly UnitRef[], done: boolean, today: string, nowIso: string, quality?: Quality | null): WirdTask[] {
  const wanted = new Map<string, Set<number>>();
  for (const r of refs) (wanted.get(r.taskId) ?? wanted.set(r.taskId, new Set()).get(r.taskId))?.add(r.n);
  const out: WirdTask[] = [];
  for (const t of tasks) {
    const ns = wanted.get(t.id);
    if (!ns) continue;
    let touched = false;
    const later = t.kind === 'daily' ? tasks.filter((x) => x.planId === t.planId && x.kind === 'daily' && x.date > t.date).sort((a, b) => (a.date < b.date ? -1 : 1)) : [];
    const units = t.units.map((u) => {
      if (!ns.has(u.n) || u.closed) return u;
      if (done) {
        touched = true;
        return { ...u, doneAt: u.doneAt ?? nowIso, doneOn: u.doneOn ?? today, quality: quality === undefined ? u.quality : quality };
      }
      if (u.doneAt === null) return u;
      touched = true;
      const again = later.find((x) => covered(quarters(x.unit, x.units.map((v) => v.n)), t.unit, u.n));
      return { ...u, doneAt: null, doneOn: null, quality: null, ...(again ? { closed: 'merged' as ClosedReason, closedOn: again.date, mergedInto: again.id } : {}) };
    });
    if (touched) out.push(withUnits(t, units, nowIso));
  }
  return out;
}

export function setQuality(tasks: readonly WirdTask[], refs: readonly UnitRef[], quality: Quality | null, nowIso: string): WirdTask[] {
  const keys = new Set(refs.map((r) => `${r.taskId}#${r.n}`));
  return tasks.flatMap((t) => {
    let touched = false;
    const units = t.units.map((u) => {
      if (!keys.has(`${t.id}#${u.n}`) || u.doneAt === null) return u;
      touched = true;
      return { ...u, quality };
    });
    return touched ? [withUnits(t, units, nowIso)] : [];
  });
}

// ------------------------------------------------------------------ plan changes

const hasTicksOn = (planTasks: readonly WirdTask[], date: string) => planTasks.some((t) => t.units.some((u) => u.doneOn === date));

/** Removes tasks that have not been worked on yet (they are generated again) and reopens what they had merged. */
function dropTasks(planTasks: readonly WirdTask[], ids: ReadonlySet<string>, nowIso: string): WirdTask[] {
  const out: WirdTask[] = [];
  for (const t of planTasks) {
    if (ids.has(t.id)) continue;
    let touched = false;
    const units = t.units.map((u) => {
      if (u.closed !== 'merged' || !u.mergedInto || !ids.has(u.mergedInto)) return u;
      touched = true;
      return { ...u, closed: null, closedOn: null, mergedInto: null };
    });
    if (touched) out.push(withUnits(t, units, nowIso));
  }
  return out;
}

export interface PlanChange {
  readonly plan: WirdPlan;
  readonly updated: WirdTask[];
  readonly deleted: string[];
  /** Date the change takes effect. */
  readonly effectiveFrom: string;
}

export type ConfigInput = Omit<WirdConfig, 'effectiveFrom' | 'startOffset'> & { readonly startOffset?: number };

/**
 * Applies a new configuration. Past tasks stay as they were. It takes effect today, or tomorrow if
 * something of this plan was already ticked today. Open overdue units outside the new range are
 * closed as `removed` (kept in history, not counted as missed).
 */
export function applyEdit(plan: WirdPlan, tasks: readonly WirdTask[], input: ConfigInput, today: string, nowIso: string, meta: { name?: string; color?: number; startDate?: string } = {}): PlanChange {
  const planTasks = tasks.filter((t) => t.planId === plan.id);
  const notStarted = plan.startDate > today;
  const startDate = notStarted && meta.startDate ? meta.startDate : plan.startDate;
  const effectiveFrom = notStarted ? startDate : hasTicksOn(planTasks, today) ? shiftDate(today, 1) : today;
  const dropIds = new Set(planTasks.filter((t) => t.date >= effectiveFrom).map((t) => t.id));
  const remaining = planTasks.filter((t) => !dropIds.has(t.id));
  const reopened = new Map(dropTasks(planTasks, dropIds, nowIso).map((t) => [t.id, t]));
  const current = remaining.map((t) => reopened.get(t.id) ?? t);

  let startOffset = input.startOffset ?? 0;
  if (input.startOffset === undefined && input.cycle === 'daily') {
    const last = current.filter((t) => t.kind === 'daily').sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const lastN = last?.unit === input.unit ? last.units[last.units.length - 1]?.n : undefined;
    const length = input.to - input.from + 1;
    if (lastN !== undefined && lastN >= input.from && lastN <= input.to) startOffset = (lastN - input.from + 1) % length;
  }
  const config: WirdConfig = { ...input, startOffset, effectiveFrom };
  const configs = notStarted ? [config] : [...plan.configs.filter((c) => c.effectiveFrom < effectiveFrom), config];

  const range = rangeQuarterSpan(input.unit, input.from, input.to);
  const updated = new Map(reopened);
  for (const t of current) {
    if (t.kind !== 'daily') continue;
    let touched = false;
    const units = t.units.map((u) => {
      if (!isOpen(u) || spanContains(range, quarterSpan(t.unit, u.n))) return u;
      touched = true;
      return { ...u, closed: 'removed' as ClosedReason, closedOn: today };
    });
    if (touched) updated.set(t.id, withUnits(t, units, nowIso));
  }
  const next: WirdPlan = { ...plan, name: meta.name ?? plan.name, color: meta.color ?? plan.color, startDate, configs, updatedAt: nowIso };
  return { plan: next, updated: [...updated.values()], deleted: [...dropIds], effectiveFrom };
}

/** Pauses from today (tomorrow if something was ticked today). Paused days get no tasks and are not missed. */
export function pausePlan(plan: WirdPlan, tasks: readonly WirdTask[], today: string, nowIso: string, archive = false): PlanChange {
  const planTasks = tasks.filter((t) => t.planId === plan.id);
  const open = plan.pauses.find((p) => p.to === null);
  if (open) return { plan: { ...plan, status: archive ? 'archived' : 'paused', updatedAt: nowIso }, updated: [], deleted: [], effectiveFrom: open.from };
  const from = plan.startDate > today ? plan.startDate : hasTicksOn(planTasks, today) ? shiftDate(today, 1) : today;
  const dropIds = new Set(planTasks.filter((t) => t.date >= from).map((t) => t.id));
  return {
    plan: { ...plan, status: archive ? 'archived' : 'paused', pauses: [...plan.pauses, { from, to: null }], updatedAt: nowIso },
    updated: dropTasks(planTasks, dropIds, nowIso),
    deleted: [...dropIds],
    effectiveFrom: from,
  };
}

/** Resumes today. Overdue units from before the pause carry on from here. */
export function resumePlan(plan: WirdPlan, today: string, nowIso: string): WirdPlan {
  const pauses = plan.pauses.flatMap((p) => (p.to !== null ? [p] : p.from >= today ? [] : [{ from: p.from, to: today }]));
  return { ...plan, status: 'active', pauses, updatedAt: nowIso };
}

export const carryModeOf = (plan: WirdPlan, today: string): CarryMode => currentConfig(plan, today).carry;
