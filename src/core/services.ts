import { QuranDataService, type Fetcher } from './data/quranDataService.ts';
import { MistakeService } from './mistakes/mistakeService.ts';
import { PlanService } from './plan/planService.ts';
import { normalizePreferences, type Preferences } from './settings/preferences.ts';
import type { Store } from './storage/store.ts';
import type { Clock, IdGenerator } from './util/ids.ts';

export class PreferencesRepository {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async load(): Promise<Preferences> {
    return normalizePreferences(await this.store.settings.get('preferences'));
  }
  async save(p: Preferences): Promise<Preferences> {
    const normalized = normalizePreferences(p);
    await this.store.settings.set('preferences', normalized);
    return normalized;
  }
}

export interface AppServices {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly mistakes: MistakeService;
  readonly plans: PlanService;
  readonly quran: QuranDataService;
  readonly preferences: PreferencesRepository;
}

/** Composition root: all dependencies are injected so every service can be tested in isolation. */
export function createServices(deps: { store: Store; clock: Clock; ids: IdGenerator; fetcher: Fetcher; bundledDataBase?: string }): AppServices {
  const { store, clock, ids } = deps;
  return {
    store,
    clock,
    ids,
    mistakes: new MistakeService({ store, clock, ids }),
    plans: new PlanService({ store, clock, ids }),
    quran: new QuranDataService({ cache: store.quranData, fetcher: deps.fetcher, ...(deps.bundledDataBase ? { bundledBase: deps.bundledDataBase } : {}) }),
    preferences: new PreferencesRepository(store),
  };
}
