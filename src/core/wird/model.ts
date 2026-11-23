import { z } from 'zod';
import { DATE_KEY_RE, type Weekday } from './dates.ts';
import { UNIT_COUNT, WIRD_UNITS, type WirdUnit } from './units.ts';

export const CARRY_MODES = ['strict', 'flexible', 'priority'] as const;
export type CarryMode = (typeof CARRY_MODES)[number];

/** What a full revision day does with overdue units. */
export const FULL_DAY_OVERDUE = ['full_only', 'full_plus_overdue', 'overdue_first'] as const;
export type FullDayOverdue = (typeof FULL_DAY_OVERDUE)[number];

export const QUALITIES = ['excellent', 'good', 'needs_practice', 'weak'] as const;
export type Quality = (typeof QUALITIES)[number];
export const isDifficult = (q: Quality | null | undefined) => q === 'needs_practice' || q === 'weak';

export type CycleMode = 'weekly' | 'daily';
export type DistributionMethod = 'auto' | 'manual';

export interface DayRange {
  readonly day: Weekday;
  readonly from: number;
  readonly to: number;
}

/** One version of a plan's configuration, in force from `effectiveFrom` until the next version. */
export interface WirdConfig {
  readonly effectiveFrom: string;
  readonly unit: WirdUnit;
  readonly from: number;
  readonly to: number;
  readonly revisionDays: readonly Weekday[];
  /** Weekly full revision day(s). Days in neither list are rest days. */
  readonly fullDays: readonly Weekday[];
  /** First day of the plan's week (orders the weekly split; Flexible spreads to the week's end). */
  readonly weekStart: Weekday;
  readonly cycle: CycleMode;
  /** Weekly cycle: balanced split, or the ranges in `manual`. */
  readonly distribution: DistributionMethod;
  readonly manual: readonly DayRange[];
  /** Manual split: the user accepted units that are left out or repeated. */
  readonly allowGaps: boolean;
  /** Fixed-daily cycle: units per revision day. */
  readonly dailyAmount: number;
  /** Fixed-daily cycle: position in the range (0-based) of the first unit on `effectiveFrom`. */
  readonly startOffset: number;
  /** Fixed-daily cycle: optional date to finish one pass by (informational). */
  readonly targetDate: string | null;
  readonly carry: CarryMode;
  readonly fullDayOverdue: FullDayOverdue;
}

export type PlanStatus = 'active' | 'paused' | 'archived';

export interface PausePeriod {
  /** First paused date. */
  readonly from: string;
  /** First date active again; null while paused. */
  readonly to: string | null;
}

export interface WirdPlan {
  readonly id: string;
  readonly name: string;
  /** Index into the plan colour palette (0..7). */
  readonly color: number;
  readonly status: PlanStatus;
  readonly startDate: string;
  /** Configuration history, sorted by effectiveFrom; the first starts on startDate. */
  readonly configs: readonly WirdConfig[];
  readonly pauses: readonly PausePeriod[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when migrated from the old week/month plan. */
  readonly migratedFrom?: string;
}

export type TaskKind = 'daily' | 'full';
export type ClosedReason = 'merged' | 'removed';

/** One Quran unit of a task, with its completion record. */
export interface WirdTaskUnit {
  readonly n: number;
  readonly doneAt: string | null;
  /** Local date the unit was completed (it can be later than the task's date). */
  readonly doneOn: string | null;
  readonly quality: Quality | null;
  /** Flexible mode: date the unit was moved to (null = carried normally). */
  readonly dueOn: string | null;
  /** Closed without completion: merged into its next scheduled occurrence, or removed by a plan change. */
  readonly closed: ClosedReason | null;
  readonly closedOn: string | null;
  readonly mergedInto: string | null;
}

/** Scheduled revision of one plan on one date. Its id is deterministic, so generation is idempotent. */
export interface WirdTask {
  readonly id: string;
  readonly planId: string;
  readonly date: string;
  readonly kind: TaskKind;
  readonly unit: WirdUnit;
  readonly units: readonly WirdTaskUnit[];
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const taskId = (planId: string, date: string, kind: TaskKind) => `wt:${planId}:${date}:${kind}`;

export const newUnit = (n: number): WirdTaskUnit => ({ n, doneAt: null, doneOn: null, quality: null, dueOn: null, closed: null, closedOn: null, mergedInto: null });
export const isOpen = (u: WirdTaskUnit) => u.doneAt === null && u.closed === null;

// ------------------------------------------------------------------ validation (backup + sync)
const dateKey = z.string().regex(DATE_KEY_RE);
const iso = z.string().min(10);
const weekday = z.number().int().min(0).max(6);
const unitKind = z.enum(WIRD_UNITS);

export const WirdConfigSchema = z
  .object({
    effectiveFrom: dateKey,
    unit: unitKind,
    from: z.number().int().min(1),
    to: z.number().int().min(1),
    revisionDays: z.array(weekday),
    fullDays: z.array(weekday),
    weekStart: weekday,
    cycle: z.enum(['weekly', 'daily']),
    distribution: z.enum(['auto', 'manual']),
    manual: z.array(z.object({ day: weekday, from: z.number().int().min(1), to: z.number().int().min(1) })),
    allowGaps: z.boolean(),
    dailyAmount: z.number().int().min(1).max(240),
    startOffset: z.number().int().min(0),
    targetDate: dateKey.nullable(),
    carry: z.enum(CARRY_MODES),
    fullDayOverdue: z.enum(FULL_DAY_OVERDUE),
  })
  .refine((c) => c.from <= c.to && c.to <= UNIT_COUNT[c.unit], 'invalid range');

export const WirdPlanSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  color: z.number().int().min(0).max(7),
  status: z.enum(['active', 'paused', 'archived']),
  startDate: dateKey,
  configs: z.array(WirdConfigSchema).min(1),
  pauses: z.array(z.object({ from: dateKey, to: dateKey.nullable() })),
  createdAt: iso,
  updatedAt: iso,
  migratedFrom: z.string().optional(),
});

export const WirdTaskSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  date: dateKey,
  kind: z.enum(['daily', 'full']),
  unit: unitKind,
  units: z.array(
    z.object({
      n: z.number().int().min(1).max(240),
      doneAt: iso.nullable(),
      doneOn: dateKey.nullable(),
      quality: z.enum(QUALITIES).nullable(),
      dueOn: dateKey.nullable(),
      closed: z.enum(['merged', 'removed']).nullable(),
      closedOn: dateKey.nullable(),
      mergedInto: z.string().nullable(),
    }),
  ),
  note: z.string().max(2000).nullable(),
  createdAt: iso,
  updatedAt: iso,
});
