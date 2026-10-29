import { MistakeService } from '../src/core/mistakes/mistakeService.ts';
import { PlanService } from '../src/core/plan/planService.ts';
import { createMemoryStore } from '../src/core/storage/memoryStore.ts';
import { FixedClock, sequentialIds } from '../src/core/util/ids.ts';

export function setup(startIso = '2026-03-01T08:00:00.000Z') {
  const store = createMemoryStore();
  const clock = new FixedClock(startIso);
  const ids = sequentialIds();
  return { store, clock, ids, mistakes: new MistakeService({ store, clock, ids }), plans: new PlanService({ store, clock, ids }) };
}

export const word = (position: number, tokenText = 'كلمة') => ({ position, tokenText, edition: 'synthetic-fixture' });
