import { z } from 'zod';
import { MISTAKE_CATEGORIES, MISTAKE_STATUSES, RECALL_OUTCOMES, type DailyPlan, type Mistake, type MistakeEvent, type ReviewEvent, type RevisionSession } from '../model.ts';
import { isValidRef, toIndex } from '../quran/refs.ts';
import { normalizePreferences, RepeatConfigSchema, type Preferences } from '../settings/preferences.ts';
import { SCHEMA_VERSION, type Store } from './store.ts';

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp');
const RefSchema = z.object({ surah: z.number().int(), ayah: z.number().int() }).refine(isValidRef, 'invalid ayah reference');
const status = z.enum(MISTAKE_STATUSES);

const ScopeSchema = z.union([
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('division'), kind: z.enum(['juz', 'hizb', 'quarter', 'eighth', 'page']), number: z.number().int().min(1) }),
  z.object({ type: z.literal('surahs'), surahs: z.array(z.number().int().min(1).max(114)).min(1) }),
  z.object({ type: z.literal('range'), start: RefSchema, end: RefSchema }),
]);

const MistakeSchema = z
  .object({
    id: z.string().min(1),
    surah: z.number().int(),
    ayah: z.number().int(),
    globalIndex: z.number().int(),
    edition: z.string().nullable(),
    word: z.object({ position: z.number().int().min(1), tokenText: z.string().min(1) }).nullable(),
    category: z.enum(MISTAKE_CATEGORIES),
    status,
    severity: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    note: z.string().max(5000),
    confidence: z.number().int().min(1).max(5).nullable(),
    confusedWith: RefSchema.nullable(),
    createdAt: iso,
    updatedAt: iso,
    lastReviewedAt: iso.nullable(),
    resolvedAt: iso.nullable(),
    reviewCount: z.number().int().min(0),
    lapseCount: z.number().int().min(0),
    successStreak: z.number().int().min(0),
    lastStreakSessionId: z.string().nullable(),
    reopenCount: z.number().int().min(0),
    schedule: z.object({
      intervalDays: z.number().min(0),
      nextReviewAt: iso.nullable(),
      manualNextReviewAt: iso.nullable(),
      difficultyOverride: z.enum(['easier', 'normal', 'harder']),
    }),
    demo: z.boolean().optional(),
  })
  .refine((m) => isValidRef(m) && toIndex(m) === m.globalIndex, 'ayah reference and globalIndex disagree');

const ReviewSchema = z.object({
  id: z.string().min(1),
  mistakeId: z.string().min(1),
  surah: z.number().int(),
  ayah: z.number().int(),
  globalIndex: z.number().int(),
  sessionId: z.string().nullable(),
  at: iso,
  outcome: z.enum(RECALL_OUTCOMES),
  assisted: z.boolean(),
  repetitions: z.number().int().min(0),
  durationMs: z.number().nullable(),
  prevStatus: status,
  nextStatus: status,
  demo: z.boolean().optional(),
});

const EventSchema = z.object({
  id: z.string().min(1),
  mistakeId: z.string().min(1),
  at: iso,
  type: z.enum(['marked', 'remarked', 'edited', 'status_changed', 'resolved', 'reopened', 'schedule_overridden']),
  from: status.optional(),
  to: status.optional(),
  detail: z.string().optional(),
  demo: z.boolean().optional(),
});

const PlanSchema = z.object({
  id: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(['revision', 'memorization']),
  scope: ScopeSchema,
  status: z.enum(['pending', 'in_progress', 'completed']),
  sessionIds: z.array(z.string()),
  createdAt: iso,
  updatedAt: iso,
  completedAt: iso.nullable(),
});

const SessionSchema = z.object({
  id: z.string().min(1),
  planId: z.string().nullable(),
  mode: z.enum(['mistakes', 'full', 'combined', 'test']),
  scope: ScopeSchema,
  startedAt: iso,
  endedAt: iso.nullable(),
  status: z.enum(['active', 'completed', 'abandoned']),
  reciterId: z.string(),
  repeat: RepeatConfigSchema,
  mistakeAyahIndexes: z.array(z.number().int()),
  plannedSteps: z.number().int().min(0),
  completedSteps: z.number().int().min(0),
  playedAyahIndexes: z.array(z.number().int()),
  demo: z.boolean().optional(),
});

export const BackupSchema = z.object({
  app: z.literal('hafeez-helfer'),
  schemaVersion: z.literal(SCHEMA_VERSION),
  exportedAt: iso,
  data: z.object({
    mistakes: z.array(MistakeSchema),
    reviews: z.array(ReviewSchema),
    mistakeEvents: z.array(EventSchema),
    plans: z.array(PlanSchema),
    sessions: z.array(SessionSchema),
    preferences: z.unknown().optional(),
  }),
});

/** Backup file shape (validated by BackupSchema on import). */
export interface Backup {
  readonly app: 'hafeez-helfer';
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly exportedAt: string;
  readonly data: {
    readonly mistakes: readonly Mistake[];
    readonly reviews: readonly ReviewEvent[];
    readonly mistakeEvents: readonly MistakeEvent[];
    readonly plans: readonly DailyPlan[];
    readonly sessions: readonly RevisionSession[];
    readonly preferences?: unknown;
  };
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/**
 * Migrations from older backup schema versions to the current one. Each entry upgrades
 * version N to N+1. (Version 1 is the first released schema, so the list is empty.)
 */
const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {};

export function migrateBackup(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  let obj = raw as Record<string, unknown>;
  let v = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : NaN;
  if (v > SCHEMA_VERSION) throw new BackupError(`This backup was made by a newer version of the app (schema ${v}).`);
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new BackupError(`No migration available from schema ${v}.`);
    obj = { ...step(obj), schemaVersion: v + 1 };
    v++;
  }
  return obj;
}

export async function exportBackup(store: Store, now: Date): Promise<Backup> {
  return {
    app: 'hafeez-helfer',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    data: {
      mistakes: await store.mistakes.getAll(),
      reviews: await store.reviews.getAll(),
      mistakeEvents: await store.mistakeEvents.getAll(),
      plans: await store.plans.getAll(),
      sessions: await store.sessions.getAll(),
      preferences: await store.settings.get('preferences'),
    },
  };
}

export function parseBackup(json: unknown): Backup {
  const migrated = migrateBackup(json);
  const parsed = BackupSchema.safeParse(migrated);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new BackupError(`Invalid backup file${first ? ` at ${first.path.join('.')}: ${first.message}` : ''}.`);
  }
  const d = parsed.data.data;
  const ids = new Set(d.mistakes.map((m) => m.id));
  const orphan = d.reviews.find((r) => !ids.has(r.mistakeId)) ?? d.mistakeEvents.find((e) => !ids.has(e.mistakeId));
  if (orphan) throw new BackupError(`Backup references a mistake that does not exist (${orphan.mistakeId}).`);
  return parsed.data as Backup;
}

export interface RestoreSummary {
  readonly mistakes: number;
  readonly reviews: number;
  readonly plans: number;
  readonly sessions: number;
}

/**
 * Restores a validated backup. 'replace' wipes personal data first; 'merge' upserts by id
 * (for mistakes the more recently updated record wins). Quran data and audio are untouched.
 */
export async function restoreBackup(store: Store, backup: Backup, mode: 'replace' | 'merge'): Promise<{ summary: RestoreSummary; preferences: Preferences | null }> {
  const d = backup.data;
  if (mode === 'replace') {
    await Promise.all([store.mistakes.clear(), store.reviews.clear(), store.mistakeEvents.clear(), store.plans.clear(), store.sessions.clear()]);
    await store.mistakes.putMany(d.mistakes);
  } else {
    const current = new Map((await store.mistakes.getAll()).map((m) => [m.id, m]));
    const winners = (d.mistakes).filter((m) => {
      const c = current.get(m.id);
      return !c || c.updatedAt <= m.updatedAt;
    });
    await store.mistakes.putMany(winners);
  }
  await store.reviews.putMany(d.reviews);
  await store.mistakeEvents.putMany(d.mistakeEvents);
  await store.plans.putMany(d.plans);
  await store.sessions.putMany(d.sessions);
  let preferences: Preferences | null = null;
  if (d.preferences !== undefined && mode === 'replace') {
    preferences = normalizePreferences(d.preferences);
    await store.settings.set('preferences', preferences);
  }
  return { summary: { mistakes: d.mistakes.length, reviews: d.reviews.length, plans: d.plans.length, sessions: d.sessions.length }, preferences };
}

/** Deletes every personal record (mistakes, reviews, plans, sessions, preferences). */
export async function wipePersonalData(store: Store): Promise<void> {
  await Promise.all([store.mistakes.clear(), store.reviews.clear(), store.mistakeEvents.clear(), store.plans.clear(), store.sessions.clear()]);
  await store.settings.delete('preferences');
}
