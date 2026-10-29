import {
  isUnresolved,
  type DifficultyOverride,
  type Mistake,
  type MistakeCategory,
  type MistakeEvent,
  type MistakeEventType,
  type MistakeStatus,
  type RecallOutcome,
  type ReviewEvent,
  type Severity,
} from '../model.ts';
import { applyOutcome, DEFAULT_POLICY, type PolicyConfig } from '../review/policy.ts';
import { computeIntervalDays, DEFAULT_SCHEDULER, nextReviewIso, type SchedulerConfig } from '../review/scheduler.ts';
import { assertValidRef, sortByQuranOrder, toIndex } from '../quran/refs.ts';
import type { AyahRef } from '../quran/types.ts';
import type { Store } from '../storage/store.ts';
import type { Clock, IdGenerator } from '../util/ids.ts';

export interface MarkInput {
  readonly category: MistakeCategory;
  readonly note?: string;
  readonly severity?: Severity;
  readonly confidence?: number | null;
  readonly confusedWith?: AyahRef | null;
  readonly demo?: boolean;
}

export interface WordTarget {
  readonly position: number;
  readonly tokenText: string;
  readonly edition: string;
}

export interface MarkResult {
  readonly mistake: Mistake;
  /** 'created' = new record; 'recurred' = existing unresolved record, occurrence recorded; 'reopened' = was resolved. */
  readonly action: 'created' | 'recurred' | 'reopened';
}

export interface MistakePatch {
  readonly category?: MistakeCategory;
  readonly note?: string;
  readonly severity?: Severity;
  readonly confidence?: number | null;
  readonly confusedWith?: AyahRef | null;
}

export interface ReviewContext {
  readonly sessionId: string | null;
  readonly repetitions: number;
  readonly durationMs?: number | null;
  readonly assisted?: boolean;
  readonly demo?: boolean;
}

export class MistakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MistakeError';
  }
}

/** Identity of a mark: one record per (ayah) or per (ayah, word position). */
export function mistakeKey(ref: AyahRef, wordPosition: number | null): string {
  return `${ref.surah}:${ref.ayah}:${wordPosition ?? 'ayah'}`;
}

export class MistakeService {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly policy: PolicyConfig;
  private readonly scheduler: SchedulerConfig;

  constructor(deps: { store: Store; clock: Clock; ids: IdGenerator; policy?: PolicyConfig; scheduler?: SchedulerConfig }) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.policy = deps.policy ?? DEFAULT_POLICY;
    this.scheduler = deps.scheduler ?? DEFAULT_SCHEDULER;
  }

  async list(): Promise<Mistake[]> {
    const all = await this.store.mistakes.getAll();
    // Canonical Quran order; ayah-level marks before word marks of the same ayah.
    return sortByQuranOrder(all, (m) => m).sort(
      (a, b) => a.globalIndex - b.globalIndex || (a.word?.position ?? 0) - (b.word?.position ?? 0) || a.createdAt.localeCompare(b.createdAt),
    );
  }

  async get(id: string): Promise<Mistake> {
    const m = await this.store.mistakes.get(id);
    if (!m) throw new MistakeError(`Mistake ${id} not found`);
    return m;
  }

  async findByKey(ref: AyahRef, wordPosition: number | null): Promise<Mistake | undefined> {
    const key = mistakeKey(ref, wordPosition);
    return (await this.store.mistakes.getAll()).find((m) => mistakeKey(m, m.word?.position ?? null) === key);
  }

  async forAyah(ref: AyahRef): Promise<Mistake[]> {
    const idx = toIndex(ref);
    return (await this.list()).filter((m) => m.globalIndex === idx);
  }

  markAyah(ref: AyahRef, input: MarkInput): Promise<MarkResult> {
    return this.mark(ref, null, input);
  }

  markWord(ref: AyahRef, word: WordTarget, input: MarkInput): Promise<MarkResult> {
    if (!Number.isInteger(word.position) || word.position < 1) throw new MistakeError('Word position must be a positive integer');
    if (!word.tokenText) throw new MistakeError('Word token snapshot is required');
    return this.mark(ref, word, input);
  }

  /**
   * Marks an ayah or word. Marking the same target again never creates a duplicate record:
   * an unresolved record gets a recorded recurrence (lapse); a resolved record is reopened.
   */
  private async mark(ref: AyahRef, word: WordTarget | null, input: MarkInput): Promise<MarkResult> {
    assertValidRef(ref);
    const now = this.clock.now().toISOString();
    const existing = await this.findByKey(ref, word?.position ?? null);
    if (existing) {
      const reopening = existing.status === 'resolved';
      const status: MistakeStatus = reopening ? 'reopened' : existing.status === 'new' ? 'new' : 'needs_practice';
      const updated: Mistake = {
        ...existing,
        category: input.category,
        note: input.note && input.note.trim() ? input.note.trim() : existing.note,
        severity: input.severity ?? existing.severity,
        status,
        lapseCount: existing.lapseCount + 1,
        successStreak: 0,
        lastStreakSessionId: null,
        reopenCount: reopening ? existing.reopenCount + 1 : existing.reopenCount,
        resolvedAt: reopening ? null : existing.resolvedAt,
        updatedAt: now,
        schedule: { ...existing.schedule, intervalDays: this.scheduler.ladderDays[0] ?? 1, nextReviewAt: now, manualNextReviewAt: null },
      };
      await this.store.mistakes.put(updated);
      await this.logEvent(updated.id, reopening ? 'reopened' : 'remarked', { from: existing.status, to: status, demo: input.demo });
      return { mistake: updated, action: reopening ? 'reopened' : 'recurred' };
    }
    const mistake: Mistake = {
      id: this.ids('m'),
      surah: ref.surah,
      ayah: ref.ayah,
      globalIndex: toIndex(ref),
      edition: word ? word.edition : null,
      word: word ? { position: word.position, tokenText: word.tokenText } : null,
      category: input.category,
      status: 'new',
      severity: input.severity ?? 2,
      note: input.note?.trim() ?? '',
      confidence: input.confidence ?? null,
      confusedWith: input.confusedWith ?? null,
      createdAt: now,
      updatedAt: now,
      lastReviewedAt: null,
      resolvedAt: null,
      reviewCount: 0,
      lapseCount: 0,
      successStreak: 0,
      lastStreakSessionId: null,
      reopenCount: 0,
      // New mistakes are due immediately.
      schedule: { intervalDays: 0, nextReviewAt: now, manualNextReviewAt: null, difficultyOverride: 'normal' },
      ...(input.demo ? { demo: true } : {}),
    };
    await this.store.mistakes.put(mistake);
    await this.logEvent(mistake.id, 'marked', { to: 'new', demo: input.demo });
    return { mistake, action: 'created' };
  }

  async update(id: string, patch: MistakePatch): Promise<Mistake> {
    const m = await this.get(id);
    if (patch.confidence !== undefined && patch.confidence !== null && (patch.confidence < 1 || patch.confidence > 5)) {
      throw new MistakeError('Confidence must be between 1 and 5');
    }
    if (patch.confusedWith) assertValidRef(patch.confusedWith);
    const updated: Mistake = {
      ...m,
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.note !== undefined ? { note: patch.note.trim() } : {}),
      ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
      ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
      ...(patch.confusedWith !== undefined ? { confusedWith: patch.confusedWith } : {}),
      updatedAt: this.clock.now().toISOString(),
    };
    await this.store.mistakes.put(updated);
    await this.logEvent(id, 'edited', { detail: Object.keys(patch).join(',') });
    return updated;
  }

  /** Explicit status change by the user. "reopened" is only valid from "resolved". */
  async setStatus(id: string, status: MistakeStatus): Promise<Mistake> {
    const m = await this.get(id);
    if (m.status === status) return m;
    if (status === 'new') throw new MistakeError('A mistake cannot be set back to "new"');
    if (status === 'reopened' && m.status !== 'resolved') throw new MistakeError('Only a resolved mistake can be reopened');
    if (status === 'resolved') return this.resolve(id);
    const now = this.clock.now().toISOString();
    const reopening = m.status === 'resolved';
    const updated: Mistake = {
      ...m,
      status,
      updatedAt: now,
      resolvedAt: reopening ? null : m.resolvedAt,
      reopenCount: reopening ? m.reopenCount + 1 : m.reopenCount,
      ...(reopening ? { schedule: { ...m.schedule, nextReviewAt: now } } : {}),
    };
    await this.store.mistakes.put(updated);
    await this.logEvent(id, reopening ? 'reopened' : 'status_changed', { from: m.status, to: status });
    return updated;
  }

  async resolve(id: string): Promise<Mistake> {
    const m = await this.get(id);
    if (m.status === 'resolved') return m;
    const now = this.clock.now().toISOString();
    const updated: Mistake = { ...m, status: 'resolved', resolvedAt: now, updatedAt: now };
    await this.store.mistakes.put(updated);
    await this.logEvent(id, 'resolved', { from: m.status, to: 'resolved' });
    return updated;
  }

  reopen(id: string): Promise<Mistake> {
    return this.setStatus(id, 'reopened');
  }

  async overrideSchedule(id: string, manualNextReviewAt: string | null, difficulty?: DifficultyOverride): Promise<Mistake> {
    const m = await this.get(id);
    if (manualNextReviewAt !== null && Number.isNaN(Date.parse(manualNextReviewAt))) throw new MistakeError('Invalid date');
    const updated: Mistake = {
      ...m,
      schedule: { ...m.schedule, manualNextReviewAt, ...(difficulty ? { difficultyOverride: difficulty } : {}) },
      updatedAt: this.clock.now().toISOString(),
    };
    await this.store.mistakes.put(updated);
    await this.logEvent(id, 'schedule_overridden', { detail: `${manualNextReviewAt ?? 'auto'}${difficulty ? `,${difficulty}` : ''}` });
    return updated;
  }

  /**
   * Records ONE recall outcome for an ayah. It is applied to every unresolved mistake of that
   * ayah (several marked words share one recall) — or to resolved ones only if explicitly listed.
   */
  async recordAyahReview(ref: AyahRef, outcome: RecallOutcome, ctx: ReviewContext, mistakeIds?: readonly string[]): Promise<ReviewEvent[]> {
    const all = await this.forAyah(ref);
    const targets = mistakeIds ? all.filter((m) => mistakeIds.includes(m.id)) : all.filter((m) => isUnresolved(m.status));
    if (targets.length === 0) throw new MistakeError(`No ${mistakeIds ? 'matching' : 'unresolved'} mistakes recorded for ${ref.surah}:${ref.ayah}`);
    const at = this.clock.now();
    const atIso = at.toISOString();
    const events: ReviewEvent[] = [];
    for (const m of targets) {
      const res = applyOutcome(
        { status: m.status, successStreak: m.successStreak, lapseCount: m.lapseCount, reopenCount: m.reopenCount, lastStreakSessionId: m.lastStreakSessionId },
        outcome,
        ctx.sessionId,
        this.policy,
      );
      const intervalDays = computeIntervalDays(
        {
          outcome,
          successStreak: res.successStreak,
          lapseCount: res.lapseCount,
          severity: m.severity,
          category: m.category,
          difficulty: m.schedule.difficultyOverride,
          previousIntervalDays: m.schedule.intervalDays,
          lastReviewedAt: m.lastReviewedAt,
          reviewedAt: at,
        },
        this.scheduler,
      );
      const updated: Mistake = {
        ...m,
        status: res.status,
        successStreak: res.successStreak,
        lapseCount: res.lapseCount,
        reopenCount: res.reopenCount,
        resolvedAt: res.status === 'resolved' ? m.resolvedAt : null,
        lastStreakSessionId: res.streakCounted ? ctx.sessionId : res.successStreak === 0 ? null : m.lastStreakSessionId,
        reviewCount: m.reviewCount + 1,
        lastReviewedAt: atIso,
        updatedAt: atIso,
        // A recorded review supersedes a manual one-off override.
        schedule: { ...m.schedule, intervalDays, nextReviewAt: nextReviewIso(at, intervalDays), manualNextReviewAt: null },
      };
      const event: ReviewEvent = {
        id: this.ids('r'),
        mistakeId: m.id,
        surah: m.surah,
        ayah: m.ayah,
        globalIndex: m.globalIndex,
        sessionId: ctx.sessionId,
        at: atIso,
        outcome,
        assisted: ctx.assisted ?? outcome === 'needed_prompt',
        repetitions: ctx.repetitions,
        durationMs: ctx.durationMs ?? null,
        prevStatus: m.status,
        nextStatus: res.status,
        ...(ctx.demo || m.demo ? { demo: true } : {}),
      };
      await this.store.mistakes.put(updated);
      await this.store.reviews.put(event);
      if (m.status !== res.status) await this.logEvent(m.id, res.status === 'reopened' ? 'reopened' : 'status_changed', { from: m.status, to: res.status, detail: `review:${outcome}` });
      events.push(event);
    }
    return events;
  }

  /** User-initiated permanent deletion (privacy). Never called automatically. */
  async deletePermanently(id: string): Promise<void> {
    await this.get(id);
    await this.store.mistakes.delete(id);
    for (const r of await this.store.reviews.getAll()) if (r.mistakeId === id) await this.store.reviews.delete(r.id);
    for (const e of await this.store.mistakeEvents.getAll()) if (e.mistakeId === id) await this.store.mistakeEvents.delete(e.id);
  }

  async history(id: string): Promise<{ events: MistakeEvent[]; reviews: ReviewEvent[] }> {
    const events = (await this.store.mistakeEvents.getAll()).filter((e) => e.mistakeId === id).sort((a, b) => a.at.localeCompare(b.at));
    const reviews = (await this.store.reviews.getAll()).filter((r) => r.mistakeId === id).sort((a, b) => a.at.localeCompare(b.at));
    return { events, reviews };
  }

  private async logEvent(
    mistakeId: string,
    type: MistakeEventType,
    extra: { from?: MistakeStatus; to?: MistakeStatus; detail?: string; demo?: boolean | undefined },
  ): Promise<void> {
    const { demo, ...rest } = extra;
    const ev: MistakeEvent = { id: this.ids('e'), mistakeId, at: this.clock.now().toISOString(), type, ...rest, ...(demo ? { demo: true } : {}) };
    await this.store.mistakeEvents.put(ev);
  }
}
