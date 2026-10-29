import type { DailyPlan, PlanKind, RepeatConfig, RevisionSession, SessionMode } from '../model.ts';
import type { DivisionIndex } from '../quran/divisions.ts';
import { scopeKey, type RevisionScope } from '../quran/scope.ts';
import type { Store } from '../storage/store.ts';
import { localDateKey, type Clock, type IdGenerator } from '../util/ids.ts';

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface StartSessionInput {
  readonly planId: string | null;
  readonly mode: SessionMode;
  readonly scope: RevisionScope;
  readonly reciterId: string;
  readonly repeat: RepeatConfig;
  readonly mistakeAyahIndexes: readonly number[];
  readonly plannedSteps: number;
  readonly demo?: boolean;
}

/** Daily assignments and revision sessions. Completing a session NEVER resolves mistakes. */
export class PlanService {
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

  static planId(date: string, kind: PlanKind): string {
    return `plan_${date}_${kind}`;
  }

  async getPlan(date: string, kind: PlanKind = 'revision'): Promise<DailyPlan | undefined> {
    return this.store.plans.get(PlanService.planId(date, kind));
  }

  /** Creates or replaces the assignment for a date (one per date and kind — no duplicates). */
  async setPlan(date: string, scope: RevisionScope, kind: PlanKind = 'revision'): Promise<DailyPlan> {
    if (!DATE_RE.test(date)) throw new PlanError(`Invalid date ${date}`);
    const id = PlanService.planId(date, kind);
    const existing = await this.store.plans.get(id);
    const now = this.clock.now().toISOString();
    const sameScope = existing && scopeKey(existing.scope) === scopeKey(scope);
    const plan: DailyPlan = {
      id,
      date,
      kind,
      scope,
      status: sameScope ? existing.status : 'pending',
      sessionIds: sameScope ? existing.sessionIds : [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      completedAt: sameScope ? existing.completedAt : null,
    };
    await this.store.plans.put(plan);
    return plan;
  }

  async listPlans(): Promise<DailyPlan[]> {
    return (await this.store.plans.getAll()).sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind));
  }

  async deletePlan(id: string): Promise<void> {
    await this.store.plans.delete(id);
  }

  async setPlanStatus(id: string, status: DailyPlan['status']): Promise<DailyPlan> {
    const p = await this.store.plans.get(id);
    if (!p) throw new PlanError('Plan not found');
    const now = this.clock.now().toISOString();
    const updated: DailyPlan = { ...p, status, updatedAt: now, completedAt: status === 'completed' ? now : null };
    await this.store.plans.put(updated);
    return updated;
  }

  /** The division that follows a division scope (e.g. Hizb 5 → Hizb 6), for "continue tomorrow". */
  static nextScope(scope: RevisionScope, index: DivisionIndex): RevisionScope | null {
    if (scope.type !== 'division' || !index.has(scope.kind)) return null;
    const n = scope.number + 1;
    return n <= index.count(scope.kind) ? { type: 'division', kind: scope.kind, number: n } : { type: 'division', kind: scope.kind, number: 1 };
  }

  async startSession(input: StartSessionInput): Promise<RevisionSession> {
    const now = this.clock.now().toISOString();
    const session: RevisionSession = {
      id: this.ids('s'),
      planId: input.planId,
      mode: input.mode,
      scope: input.scope,
      startedAt: now,
      endedAt: null,
      status: 'active',
      reciterId: input.reciterId,
      repeat: input.repeat,
      mistakeAyahIndexes: input.mistakeAyahIndexes,
      plannedSteps: input.plannedSteps,
      completedSteps: 0,
      playedAyahIndexes: [],
      ...(input.demo ? { demo: true } : {}),
    };
    await this.store.sessions.put(session);
    if (input.planId) {
      const plan = await this.store.plans.get(input.planId);
      if (plan) {
        await this.store.plans.put({
          ...plan,
          status: plan.status === 'completed' ? 'completed' : 'in_progress',
          sessionIds: [...plan.sessionIds, session.id],
          updatedAt: now,
        });
      }
    }
    return session;
  }

  /** Records that an ayah's audio finished playing. Playback evidence only. */
  async recordPlayback(sessionId: string, globalIndex: number): Promise<RevisionSession> {
    const s = await this.requireSession(sessionId);
    const played = s.playedAyahIndexes.includes(globalIndex) ? s.playedAyahIndexes : [...s.playedAyahIndexes, globalIndex];
    const updated: RevisionSession = { ...s, completedSteps: s.completedSteps + 1, playedAyahIndexes: played };
    await this.store.sessions.put(updated);
    return updated;
  }

  /** Records how many test cards were answered (test sessions). */
  async recordTestProgress(sessionId: string, answered: number): Promise<RevisionSession> {
    const s = await this.requireSession(sessionId);
    const updated: RevisionSession = { ...s, completedSteps: Math.max(0, Math.min(answered, s.plannedSteps)) };
    await this.store.sessions.put(updated);
    return updated;
  }

  /** Ends a session. If it belongs to a plan, the plan is marked completed. Mistakes are untouched. */
  async completeSession(sessionId: string): Promise<RevisionSession> {
    const s = await this.requireSession(sessionId);
    const now = this.clock.now().toISOString();
    const updated: RevisionSession = { ...s, status: 'completed', endedAt: now };
    await this.store.sessions.put(updated);
    if (s.planId) {
      const plan = await this.store.plans.get(s.planId);
      if (plan) await this.store.plans.put({ ...plan, status: 'completed', completedAt: now, updatedAt: now });
    }
    return updated;
  }

  async abandonSession(sessionId: string): Promise<RevisionSession> {
    const s = await this.requireSession(sessionId);
    const updated: RevisionSession = { ...s, status: 'abandoned', endedAt: this.clock.now().toISOString() };
    await this.store.sessions.put(updated);
    return updated;
  }

  async listSessions(): Promise<RevisionSession[]> {
    return (await this.store.sessions.getAll()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Last completed session over the same scope. */
  async lastCompletedFor(scope: RevisionScope): Promise<RevisionSession | undefined> {
    const key = scopeKey(scope);
    return (await this.listSessions()).find((s) => s.status === 'completed' && scopeKey(s.scope) === key);
  }

  private async requireSession(id: string): Promise<RevisionSession> {
    const s = await this.store.sessions.get(id);
    if (!s) throw new PlanError(`Session ${id} not found`);
    return s;
  }
}
