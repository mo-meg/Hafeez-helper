/**
 * Local-first cloud sync.
 *
 * The app keeps reading and writing its local store (IndexedDB). `SyncEngine.store` wraps that
 * store: every write to a personal table (or a synced setting) is recorded in a persistent
 * outbox before it is applied locally. `syncNow()` uploads the latest local version of each
 * outbox entry (a missing record is uploaded as a deletion), then downloads rows changed on the
 * server since the last cursor. Remote rows never overwrite a record that still has a pending
 * local change; otherwise the server copy wins. Each row has a server-assigned sequence number,
 * so downloads are incremental and ordered.
 */
import { RECORD_SCHEMAS } from '../storage/backup.ts';
import { TABLE_NAMES, type Identified, type KeyValue, type Store, type Table, type TableName } from '../storage/store.ts';
import { AuthError } from './authClient.ts';
import { readJson, type CloudConfig, type HttpFetch } from './http.ts';

/** Settings keys that follow the user across devices. Others (caches, reminder state) stay local. */
export const SYNCED_SETTINGS: readonly string[] = ['preferences', 'readingPosition'];
export type RemoteTable = TableName | 'settings';

const OUTBOX_KEY = 'sync.outbox';
const CURSOR_KEY = 'sync.cursor';
const LAST_SYNC_KEY = 'sync.lastSyncedAt';
const PUSH_CHUNK = 500;
const PULL_LIMIT = 1000;

interface OutboxEntry {
  readonly tbl: RemoteTable;
  readonly id: string;
  /** Incremented on every local change, so an upload only clears what it actually sent. */
  readonly v: number;
}
type Outbox = Record<string, OutboxEntry>;

export interface PushRow {
  readonly tbl: RemoteTable;
  readonly id: string;
  readonly data: unknown;
  readonly deleted: boolean;
}

export interface RemoteRow extends PushRow {
  readonly seq: number;
}

export interface RemoteApi {
  push(rows: readonly PushRow[]): Promise<void>;
  pull(afterSeq: number, limit: number): Promise<RemoteRow[]>;
  deleteAccount(): Promise<void>;
}

export class SyncNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncNetworkError';
  }
}

export class SyncHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SyncHttpError';
    this.status = status;
  }
}

/** PostgREST access to the `user_records` table (see supabase/schema.sql). */
export class SupabaseRecords implements RemoteApi {
  private readonly cfg: CloudConfig;
  private readonly http: HttpFetch;
  private readonly auth: { accessToken(force?: boolean): Promise<string>; readonly user: { readonly id: string } };

  constructor(cfg: CloudConfig, http: HttpFetch, auth: { accessToken(force?: boolean): Promise<string>; readonly user: { readonly id: string } }) {
    this.cfg = cfg;
    this.http = http;
    this.auth = auth;
  }

  private async request(method: string, path: string, body?: unknown, extra: Record<string, string> = {}, retried = false): Promise<unknown> {
    const token = await this.auth.accessToken(retried);
    const headers: Record<string, string> = { apikey: this.cfg.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra };
    let res;
    try {
      res = await this.http(`${this.cfg.url}/rest/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (e) {
      throw new SyncNetworkError(e instanceof Error ? e.message : String(e));
    }
    if (res.status === 401 && !retried) return this.request(method, path, body, extra, true);
    const json = await readJson(res);
    if (!res.ok) {
      const b = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
      throw new SyncHttpError(res.status, String(b.message ?? b.hint ?? `HTTP ${res.status}`));
    }
    return json;
  }

  async push(rows: readonly PushRow[]): Promise<void> {
    const userId = this.auth.user.id;
    await this.request('POST', '/user_records?on_conflict=user_id,tbl,id', rows.map((r) => ({ user_id: userId, tbl: r.tbl, id: r.id, data: r.deleted ? null : r.data, deleted: r.deleted })), { Prefer: 'resolution=merge-duplicates,return=minimal' });
  }

  async pull(afterSeq: number, limit: number): Promise<RemoteRow[]> {
    const q = `select=tbl,id,data,deleted,seq&user_id=eq.${encodeURIComponent(this.auth.user.id)}&seq=gt.${afterSeq}&order=seq.asc&limit=${limit}`;
    const json = await this.request('GET', `/user_records?${q}`);
    if (!Array.isArray(json)) throw new SyncHttpError(500, 'Unexpected response from the server.');
    return json.map((r: Record<string, unknown>) => ({ tbl: String(r.tbl) as RemoteTable, id: String(r.id), data: r.data, deleted: r.deleted === true, seq: Number(r.seq) }));
  }

  async deleteAccount(): Promise<void> {
    await this.request('POST', '/rpc/delete_my_account', {});
  }
}

export type SyncState = 'idle' | 'syncing' | 'synced' | 'offline' | 'error';

export interface SyncStatus {
  readonly state: SyncState;
  readonly pending: number;
  readonly lastSyncedAt: string | null;
  /** Technical detail of the last failure (shown next to a localized message). */
  readonly error: string | null;
  /** True when the failure means the user must sign in again. */
  readonly signedOut: boolean;
}

const isRemoteTable = (t: string): t is RemoteTable => t === 'settings' || (TABLE_NAMES as readonly string[]).includes(t);

function validRemote(row: RemoteRow): boolean {
  if (row.deleted) return true;
  if (row.tbl === 'settings') {
    if (!SYNCED_SETTINGS.includes(row.id)) return false;
    if (row.id === 'readingPosition') {
      const d = row.data as { surah?: unknown; ayah?: unknown } | null;
      return !!d && Number.isInteger(d.surah) && Number.isInteger(d.ayah);
    }
    return !!row.data && typeof row.data === 'object';
  }
  const parsed = RECORD_SCHEMAS[row.tbl].safeParse(row.data);
  return parsed.success && (row.data as Identified).id === row.id;
}

export class SyncEngine {
  readonly store: Store;
  private readonly base: Store;
  private readonly remote: RemoteApi;
  private readonly now: () => Date;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly debounceMs: number;
  private outbox: Outbox = {};
  private version = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private timer = false;
  private stopped = false;
  private statusValue: SyncStatus = { state: 'idle', pending: 0, lastSyncedAt: null, error: null, signedOut: false };
  private readonly listeners = new Set<(s: SyncStatus) => void>();
  /** Called after remote changes were written locally (the UI reloads its data). */
  onRemoteChange: (applied: number) => void = () => {};

  constructor(opts: { base: Store; remote: RemoteApi; now?: () => Date; schedule?: (fn: () => void, ms: number) => unknown; debounceMs?: number }) {
    this.base = opts.base;
    this.remote = opts.remote;
    this.now = opts.now ?? (() => new Date());
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.debounceMs = opts.debounceMs ?? 1500;
    this.store = this.wrap(opts.base);
  }

  async init(): Promise<void> {
    this.outbox = (await this.base.settings.get<Outbox>(OUTBOX_KEY)) ?? {};
    this.version = Math.max(0, ...Object.values(this.outbox).map((e) => e.v));
    const last = (await this.base.settings.get<string>(LAST_SYNC_KEY)) ?? null;
    this.setStatus({ pending: this.pendingCount(), lastSyncedAt: last });
  }

  get status(): SyncStatus {
    return this.statusValue;
  }

  subscribe(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  pendingCount(): number {
    return Object.keys(this.outbox).length;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Uploads pending changes, then downloads remote changes. `full` re-reads everything. */
  syncNow(opts: { full?: boolean } = {}): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.runOnce(!!opts.full).finally(() => {
      this.running = null;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.syncNow();
      }
    });
    return this.running;
  }

  async deleteAccount(): Promise<void> {
    await this.remote.deleteAccount();
    this.stop();
  }

  // ------------------------------------------------------------------ internals

  private setStatus(patch: Partial<SyncStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
    for (const l of this.listeners) l(this.statusValue);
  }

  private async runOnce(full: boolean): Promise<void> {
    this.setStatus({ state: 'syncing', error: null });
    try {
      await this.push();
      const applied = await this.pull(full);
      const at = this.now().toISOString();
      await this.base.settings.set(LAST_SYNC_KEY, at);
      this.setStatus({ state: 'synced', lastSyncedAt: at, pending: this.pendingCount(), error: null, signedOut: false });
      if (applied > 0) this.onRemoteChange(applied);
    } catch (e) {
      const offline = e instanceof SyncNetworkError || (e instanceof AuthError && e.code === 'network');
      const signedOut = e instanceof AuthError && e.code === 'session_expired';
      this.setStatus({ state: offline ? 'offline' : 'error', error: e instanceof Error ? e.message : String(e), pending: this.pendingCount(), signedOut });
    }
  }

  private async push(): Promise<void> {
    const snapshot = Object.entries(this.outbox);
    for (let i = 0; i < snapshot.length; i += PUSH_CHUNK) {
      const chunk = snapshot.slice(i, i + PUSH_CHUNK);
      const rows: PushRow[] = [];
      for (const [, e] of chunk) {
        const data = e.tbl === 'settings' ? await this.base.settings.get(e.id) : await this.base[e.tbl].get(e.id);
        rows.push({ tbl: e.tbl, id: e.id, data: data ?? null, deleted: data === undefined || data === null });
      }
      await this.remote.push(rows);
      // Clear only entries that were not changed again while uploading.
      for (const [key, e] of chunk) if (this.outbox[key]?.v === e.v) delete this.outbox[key];
      await this.base.settings.set(OUTBOX_KEY, this.outbox);
      this.setStatus({ pending: this.pendingCount() });
    }
  }

  private async pull(full: boolean): Promise<number> {
    let cursor = full ? 0 : ((await this.base.settings.get<number>(CURSOR_KEY)) ?? 0);
    let applied = 0;
    for (;;) {
      const rows = await this.remote.pull(cursor, PULL_LIMIT);
      for (const row of rows) {
        cursor = Math.max(cursor, row.seq);
        if (!isRemoteTable(row.tbl) || this.outbox[`${row.tbl}/${row.id}`] || !validRemote(row)) continue;
        if (row.tbl === 'settings') {
          if (row.deleted) await this.base.settings.delete(row.id);
          else await this.base.settings.set(row.id, row.data);
        } else if (row.deleted) {
          await this.base[row.tbl].delete(row.id);
        } else {
          await (this.base[row.tbl] as Table<Identified>).put(row.data as Identified);
        }
        applied++;
      }
      await this.base.settings.set(CURSOR_KEY, cursor);
      if (rows.length < PULL_LIMIT) break;
    }
    return applied;
  }

  private async enqueue(tbl: RemoteTable, ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    for (const id of ids) this.outbox[`${tbl}/${id}`] = { tbl, id, v: ++this.version };
    await this.base.settings.set(OUTBOX_KEY, this.outbox);
    this.setStatus({ pending: this.pendingCount() });
  }

  private changed(): void {
    if (this.timer || this.stopped) return;
    this.timer = true;
    this.schedule(() => {
      this.timer = false;
      void this.syncNow();
    }, this.debounceMs);
  }

  private wrap(base: Store): Store {
    const table = <T extends Identified>(tbl: TableName, t: Table<T>): Table<T> => ({
      get: (id) => t.get(id),
      getAll: () => t.getAll(),
      put: async (item) => {
        await this.enqueue(tbl, [item.id]);
        await t.put(item);
        this.changed();
      },
      putMany: async (items) => {
        await this.enqueue(tbl, items.map((i) => i.id));
        await t.putMany(items);
        this.changed();
      },
      delete: async (id) => {
        await this.enqueue(tbl, [id]);
        await t.delete(id);
        this.changed();
      },
      clear: async () => {
        await this.enqueue(tbl, (await t.getAll()).map((i) => i.id));
        await t.clear();
        this.changed();
      },
    });
    const settings: KeyValue = {
      get: (key) => base.settings.get(key),
      keys: () => base.settings.keys(),
      set: async (key, value) => {
        const synced = SYNCED_SETTINGS.includes(key);
        if (synced) await this.enqueue('settings', [key]);
        await base.settings.set(key, value);
        if (synced) this.changed();
      },
      delete: async (key) => {
        const synced = SYNCED_SETTINGS.includes(key);
        if (synced) await this.enqueue('settings', [key]);
        await base.settings.delete(key);
        if (synced) this.changed();
      },
    };
    return {
      kind: base.kind,
      mistakes: table('mistakes', base.mistakes),
      reviews: table('reviews', base.reviews),
      mistakeEvents: table('mistakeEvents', base.mistakeEvents),
      plans: table('plans', base.plans),
      sessions: table('sessions', base.sessions),
      settings,
      quranData: base.quranData,
      audio: base.audio,
    };
  }
}
