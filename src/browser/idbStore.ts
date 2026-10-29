import type { Identified, KeyValue, Store, Table } from '../core/storage/store.ts';

const DB_NAME = 'hafeez-helfer';
/** IndexedDB structural version. Upgrades are applied step by step in `upgrade`. */
const DB_VERSION = 1;
const RECORD_STORES = ['mistakes', 'reviews', 'mistakeEvents', 'plans', 'sessions'] as const;
const KV_STORES = ['settings', 'quranData', 'audio'] as const;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function upgrade(db: IDBDatabase, oldVersion: number): void {
  // Version 0 -> 1: initial schema.
  if (oldVersion < 1) {
    for (const name of RECORD_STORES) {
      const os = db.createObjectStore(name, { keyPath: 'id' });
      if (name === 'mistakes' || name === 'reviews') os.createIndex('globalIndex', 'globalIndex');
    }
    for (const name of KV_STORES) db.createObjectStore(name);
  }
  // Future: if (oldVersion < 2) { ... }
}

export function openDatabase(name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = (e) => upgrade(open.result, e.oldVersion);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('Could not open IndexedDB'));
    open.onblocked = () => reject(new Error('The database is blocked by another open tab. Close other tabs of the app and reload.'));
  });
}

class IdbTable<T extends Identified> implements Table<T> {
  private readonly db: IDBDatabase;
  private readonly name: string;
  constructor(db: IDBDatabase, name: string) {
    this.db = db;
    this.name = name;
  }
  private os(mode: IDBTransactionMode) {
    return this.db.transaction(this.name, mode).objectStore(this.name);
  }
  get(id: string) {
    return req(this.os('readonly').get(id)) as Promise<T | undefined>;
  }
  getAll() {
    return req(this.os('readonly').getAll()) as Promise<T[]>;
  }
  async put(item: T) {
    await req(this.os('readwrite').put(item));
  }
  putMany(items: readonly T[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.name, 'readwrite');
      const os = tx.objectStore(this.name);
      for (const i of items) os.put(i);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
    });
  }
  async delete(id: string) {
    await req(this.os('readwrite').delete(id));
  }
  async clear() {
    await req(this.os('readwrite').clear());
  }
}

class IdbKeyValue implements KeyValue {
  private readonly db: IDBDatabase;
  private readonly name: string;
  constructor(db: IDBDatabase, name: string) {
    this.db = db;
    this.name = name;
  }
  private os(mode: IDBTransactionMode) {
    return this.db.transaction(this.name, mode).objectStore(this.name);
  }
  get<T>(key: string) {
    return req(this.os('readonly').get(key)) as Promise<T | undefined>;
  }
  async set<T>(key: string, value: T) {
    await req(this.os('readwrite').put(value, key));
  }
  async delete(key: string) {
    await req(this.os('readwrite').delete(key));
  }
  async keys() {
    return (await req(this.os('readonly').getAllKeys())).map(String);
  }
}

export async function createIdbStore(name = DB_NAME): Promise<Store> {
  const db = await openDatabase(name);
  return {
    kind: 'indexeddb',
    mistakes: new IdbTable(db, 'mistakes'),
    reviews: new IdbTable(db, 'reviews'),
    mistakeEvents: new IdbTable(db, 'mistakeEvents'),
    plans: new IdbTable(db, 'plans'),
    sessions: new IdbTable(db, 'sessions'),
    settings: new IdbKeyValue(db, 'settings'),
    quranData: new IdbKeyValue(db, 'quranData'),
    audio: new IdbKeyValue(db, 'audio'),
  };
}

/** Asks the browser not to evict local data under storage pressure (best effort). */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* ignore */
  }
  return null;
}
