/**
 * Who may use the shared (online) recognition server. Users request access; the admin approves
 * in the app. Stored in Supabase table `recitation_access` (see supabase/recitation_access.sql);
 * Row Level Security makes sure nobody can approve themselves. The recognition server checks the
 * same table with the user's own token before it transcribes anything.
 */
import { readJson, type CloudConfig, type HttpFetch } from '../sync/http.ts';

/** Must match supabase/recitation_access.sql and scripts/asr_server.py. */
export const RECITATION_ADMIN_EMAIL = 'mmm_megahed@hotmail.com';

export type AccessState = 'pending' | 'approved' | 'denied';
export type AccessStatus = AccessState | 'none';

export interface AccessRequest {
  readonly userId: string;
  readonly email: string;
  readonly status: AccessState;
  readonly requestedAt: string;
}

export interface AccessAuth {
  accessToken(force?: boolean): Promise<string>;
  readonly user: { readonly id: string; readonly email: string };
}

export function isRecitationAdmin(email: string): boolean {
  return email.trim().toLowerCase() === RECITATION_ADMIN_EMAIL;
}

const isState = (v: unknown): v is AccessState => v === 'pending' || v === 'approved' || v === 'denied';

export class RecitationAccess {
  private readonly cfg: CloudConfig;
  private readonly http: HttpFetch;
  private readonly auth: AccessAuth;

  constructor(cfg: CloudConfig, http: HttpFetch, auth: AccessAuth) {
    this.cfg = cfg;
    this.http = http;
    this.auth = auth;
  }

  get isAdmin(): boolean {
    return isRecitationAdmin(this.auth.user.email);
  }

  private async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}, retried = false): Promise<unknown> {
    const token = await this.auth.accessToken(retried);
    const res = await this.http(`${this.cfg.url}/rest/v1/recitation_access${path}`, {
      method,
      headers: { apikey: this.cfg.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401 && !retried) return this.call(method, path, body, extra, true);
    const json = await readJson(res);
    if (!res.ok) {
      const b = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
      throw new Error(String(b.message ?? `HTTP ${res.status}`));
    }
    return json;
  }

  /** The admin is always approved; everyone else according to their row. */
  async myStatus(): Promise<AccessStatus> {
    if (this.isAdmin) return 'approved';
    const rows = await this.call('GET', `?select=status&user_id=eq.${encodeURIComponent(this.auth.user.id)}`);
    const row = Array.isArray(rows) ? (rows[0] as { status?: unknown } | undefined) : undefined;
    return row && isState(row.status) ? row.status : 'none';
  }

  /** Asks for access. Asking twice is harmless (an existing request or decision is kept). */
  async request(): Promise<void> {
    await this.call('POST', '?on_conflict=user_id', { user_id: this.auth.user.id, status: 'pending' }, { Prefer: 'resolution=ignore-duplicates,return=minimal' });
  }

  /** Admin only (Row Level Security hides other users' rows from everyone else). */
  async list(): Promise<AccessRequest[]> {
    const rows = await this.call('GET', '?select=user_id,email,status,requested_at&order=requested_at.desc');
    if (!Array.isArray(rows)) return [];
    const out: AccessRequest[] = [];
    for (const r of rows as Array<Record<string, unknown>>) {
      if (typeof r.user_id === 'string' && isState(r.status)) out.push({ userId: r.user_id, email: String(r.email ?? ''), status: r.status, requestedAt: String(r.requested_at ?? '') });
    }
    return out;
  }

  async decide(userId: string, status: 'approved' | 'denied' | 'pending', now: Date): Promise<void> {
    await this.call('PATCH', `?user_id=eq.${encodeURIComponent(userId)}`, { status, decided_at: now.toISOString() }, { Prefer: 'return=minimal' });
  }
}
