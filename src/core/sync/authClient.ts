/**
 * Email + password authentication against Supabase Auth (GoTrue) using plain HTTP.
 * No SDK: the endpoints used are /signup, /token (password, refresh_token), /logout, /recover, /user.
 */
import { readJson, type CloudConfig, type HttpFetch } from './http.ts';

export interface AuthUser {
  readonly id: string;
  readonly email: string;
}

export interface AuthSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  readonly expiresAt: number;
  readonly user: AuthUser;
}

/** Stable, UI-translatable reasons. */
export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'user_already_exists'
  | 'weak_password'
  | 'same_password'
  | 'rate_limited'
  | 'signup_disabled'
  | 'link_expired'
  | 'session_expired'
  | 'network'
  | 'unknown';

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;
  constructor(code: AuthErrorCode, message: string, status = 0) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

/** Maps a GoTrue error body (old and new formats) to a stable code. */
export function authErrorFrom(status: number, body: unknown): AuthError {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const code = String(b.error_code ?? b.code ?? b.error ?? '').toLowerCase();
  const msg = String(b.msg ?? b.error_description ?? b.message ?? b.error ?? `HTTP ${status}`);
  const lower = msg.toLowerCase();
  let c: AuthErrorCode = 'unknown';
  if (code === 'invalid_credentials' || lower.includes('invalid login credentials')) c = 'invalid_credentials';
  else if (code === 'email_not_confirmed' || lower.includes('email not confirmed')) c = 'email_not_confirmed';
  else if (code === 'user_already_exists' || code === 'email_exists' || lower.includes('already registered')) c = 'user_already_exists';
  else if (code === 'weak_password' || lower.includes('password should be')) c = 'weak_password';
  else if (code === 'same_password') c = 'same_password';
  else if (code.startsWith('over_') || status === 429) c = 'rate_limited';
  else if (code === 'signup_disabled' || lower.includes('signups not allowed')) c = 'signup_disabled';
  else if (code === 'otp_expired' || lower.includes('expired')) c = 'link_expired';
  else if (code === 'invalid_grant' || code === 'refresh_token_not_found' || code === 'session_not_found' || status === 401) c = 'session_expired';
  return new AuthError(c, msg, status);
}

function sessionFrom(body: unknown, now: number): AuthSession | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const user = (b.user && typeof b.user === 'object' ? b.user : null) as Record<string, unknown> | null;
  if (typeof b.access_token !== 'string' || typeof b.refresh_token !== 'string' || !user || typeof user.id !== 'string') return null;
  const expiresAt = typeof b.expires_at === 'number' ? b.expires_at * 1000 : now + (typeof b.expires_in === 'number' ? b.expires_in : 3600) * 1000;
  return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt, user: { id: user.id, email: typeof user.email === 'string' ? user.email : '' } };
}

/** What an email link (confirmation or password reset) left in the URL fragment. */
export type AuthCallback =
  | { readonly kind: 'session'; readonly type: string; readonly accessToken: string; readonly refreshToken: string; readonly expiresAt: number }
  | { readonly kind: 'error'; readonly code: AuthErrorCode; readonly message: string };

/** Parses `#access_token=…&refresh_token=…&type=recovery` or `#error=…`. Returns null for app routes. */
export function parseAuthCallback(hash: string, now: number): AuthCallback | null {
  const raw = hash.replace(/^#\/?/, '');
  if (!/(^|&)(access_token|error|error_code)=/.test(raw)) return null;
  const p = new URLSearchParams(raw);
  if (p.get('error') || p.get('error_code')) {
    const code = (p.get('error_code') ?? '').toLowerCase();
    return { kind: 'error', code: code === 'otp_expired' ? 'link_expired' : 'unknown', message: p.get('error_description') ?? p.get('error') ?? '' };
  }
  const accessToken = p.get('access_token');
  const refreshToken = p.get('refresh_token');
  if (!accessToken || !refreshToken) return null;
  const expiresAt = p.get('expires_at') ? Number(p.get('expires_at')) * 1000 : now + Number(p.get('expires_in') ?? 3600) * 1000;
  return { kind: 'session', type: p.get('type') ?? '', accessToken, refreshToken, expiresAt };
}

export class AuthClient {
  private readonly cfg: CloudConfig;
  private readonly http: HttpFetch;
  private readonly now: () => number;

  constructor(cfg: CloudConfig, http: HttpFetch, now: () => number = () => Date.now()) {
    this.cfg = cfg;
    this.http = http;
    this.now = now;
  }

  private async call(method: string, path: string, body?: unknown, token?: string): Promise<unknown> {
    const headers: Record<string, string> = { apikey: this.cfg.anonKey, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await this.http(`${this.cfg.url}/auth/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (e) {
      throw new AuthError('network', e instanceof Error ? e.message : String(e));
    }
    const json = await readJson(res);
    if (!res.ok) throw authErrorFrom(res.status, json);
    return json;
  }

  /** Creates an account. Returns a session, or null when the project requires email confirmation first. */
  async signUp(email: string, password: string, redirectTo: string): Promise<AuthSession | null> {
    const body = await this.call('POST', `/signup?redirect_to=${encodeURIComponent(redirectTo)}`, { email, password });
    return sessionFrom(body, this.now());
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
    const s = sessionFrom(await this.call('POST', '/token?grant_type=password', { email, password }), this.now());
    if (!s) throw new AuthError('unknown', 'The server returned no session.');
    return s;
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    const s = sessionFrom(await this.call('POST', '/token?grant_type=refresh_token', { refresh_token: refreshToken }), this.now());
    if (!s) throw new AuthError('session_expired', 'The server returned no session.');
    return s;
  }

  /** Completes a session from an email link by looking up the user. */
  async sessionFromCallback(cb: Extract<AuthCallback, { kind: 'session' }>): Promise<AuthSession> {
    const user = (await this.call('GET', '/user', undefined, cb.accessToken)) as Record<string, unknown> | null;
    if (!user || typeof user.id !== 'string') throw new AuthError('session_expired', 'The link did not contain a valid session.');
    return { accessToken: cb.accessToken, refreshToken: cb.refreshToken, expiresAt: cb.expiresAt, user: { id: user.id, email: typeof user.email === 'string' ? user.email : '' } };
  }

  async signOut(accessToken: string): Promise<void> {
    await this.call('POST', '/logout', undefined, accessToken);
  }

  /** Sends a password-reset email whose link returns to `redirectTo`. */
  async recover(email: string, redirectTo: string): Promise<void> {
    await this.call('POST', `/recover?redirect_to=${encodeURIComponent(redirectTo)}`, { email });
  }

  async updatePassword(accessToken: string, password: string): Promise<void> {
    await this.call('PUT', '/user', { password }, accessToken);
  }
}

/**
 * Keeps the current session fresh. `onChange` persists it; `onExpired` fires when the refresh
 * token is no longer accepted (the user must sign in again).
 */
export class SessionManager {
  private session: AuthSession;
  private readonly client: AuthClient;
  private readonly now: () => number;
  private refreshing: Promise<AuthSession> | null = null;
  private readonly onChange: (s: AuthSession) => void;
  private readonly onExpired: () => void;

  constructor(opts: { client: AuthClient; session: AuthSession; now?: () => number; onChange: (s: AuthSession) => void; onExpired: () => void }) {
    this.client = opts.client;
    this.session = opts.session;
    this.now = opts.now ?? (() => Date.now());
    this.onChange = opts.onChange;
    this.onExpired = opts.onExpired;
  }

  get user(): AuthUser {
    return this.session.user;
  }

  get current(): AuthSession {
    return this.session;
  }

  /** Returns a valid access token, refreshing it shortly before expiry. */
  async accessToken(force = false): Promise<string> {
    if (!force && this.session.expiresAt - 60_000 > this.now()) return this.session.accessToken;
    if (!this.refreshing) {
      this.refreshing = this.client
        .refresh(this.session.refreshToken)
        .then((s) => {
          this.session = s;
          this.onChange(s);
          return s;
        })
        .catch((e: unknown) => {
          if (e instanceof AuthError && e.code === 'session_expired') this.onExpired();
          throw e;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return (await this.refreshing).accessToken;
  }
}
