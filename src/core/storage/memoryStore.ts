import type { Identified, KeyValue, Store, Table } from './store.ts';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryTable<T extends Identified> implements Table<T> {
  private readonly rows = new Map<string, T>();
  async get(id: string) {
    const v = this.rows.get(id);
    return v === undefined ? undefined : clone(v);
  }
  async getAll() {
    return [...this.rows.values()].map(clone);
  }
  async put(item: T) {
    this.rows.set(item.id, clone(item));
  }
  async putMany(items: readonly T[]) {
    for (const i of items) this.rows.set(i.id, clone(i));
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
  async clear() {
    this.rows.clear();
  }
}

export class MemoryKeyValue implements KeyValue {
  private readonly map = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.map.has(key) ? clone(this.map.get(key) as T) : undefined;
  }
  async set<T>(key: string, value: T) {
    this.map.set(key, clone(value));
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async keys() {
    return [...this.map.keys()];
  }
}

export function createMemoryStore(): Store {
  return {
    kind: 'memory',
    mistakes: new MemoryTable(),
    reviews: new MemoryTable(),
    mistakeEvents: new MemoryTable(),
    plans: new MemoryTable(),
    sessions: new MemoryTable(),
    settings: new MemoryKeyValue(),
    quranData: new MemoryKeyValue(),
    audio: new MemoryKeyValue(),
  };
}
