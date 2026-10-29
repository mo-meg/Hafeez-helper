import type { DailyPlan, Mistake, MistakeEvent, ReviewEvent, RevisionSession } from '../model.ts';

export interface Identified {
  readonly id: string;
}

/** Minimal async table abstraction shared by IndexedDB and in-memory implementations. */
export interface Table<T extends Identified> {
  get(id: string): Promise<T | undefined>;
  getAll(): Promise<T[]>;
  put(item: T): Promise<void>;
  putMany(items: readonly T[]): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface KeyValue {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface Store {
  readonly kind: 'indexeddb' | 'memory';
  readonly mistakes: Table<Mistake>;
  readonly reviews: Table<ReviewEvent>;
  readonly mistakeEvents: Table<MistakeEvent>;
  readonly plans: Table<DailyPlan>;
  readonly sessions: Table<RevisionSession>;
  /** Preferences and small app state. Part of backups. */
  readonly settings: KeyValue;
  /** Downloaded Quran text/division datasets. NOT part of personal backups. */
  readonly quranData: KeyValue;
  /** Offline audio blobs keyed by URL. NOT part of personal backups. */
  readonly audio: KeyValue;
}

/** Version of the personal-data schema. Bump with a migration in migrations.ts. */
export const SCHEMA_VERSION = 1;
export const TABLE_NAMES = ['mistakes', 'reviews', 'mistakeEvents', 'plans', 'sessions'] as const;
export type TableName = (typeof TABLE_NAMES)[number];
