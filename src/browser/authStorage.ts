/**
 * Small pieces of state that must be readable before the user's database is opened:
 * the signed-in session, the interface language for the sign-in screen, and a database
 * scheduled for deletion after sign-out.
 */
import type { AuthSession } from '../core/sync/authClient.ts';

const SESSION_KEY = 'hafeez-helfer.session';
const LANG_KEY = 'hafeez-helfer.lang';
const WIPE_KEY = 'hafeez-helfer.pendingWipe';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode): the session lasts for this page only */
  }
}

export function loadSession(): AuthSession | null {
  const raw = read(SESSION_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<AuthSession>;
    if (typeof s.accessToken === 'string' && typeof s.refreshToken === 'string' && typeof s.expiresAt === 'number' && s.user && typeof s.user.id === 'string') {
      return { accessToken: s.accessToken, refreshToken: s.refreshToken, expiresAt: s.expiresAt, user: { id: s.user.id, email: typeof s.user.email === 'string' ? s.user.email : '' } };
    }
  } catch {
    /* corrupt value: treat as signed out */
  }
  return null;
}

export function saveSession(s: AuthSession): void {
  write(SESSION_KEY, JSON.stringify(s));
}

export function clearSession(): void {
  write(SESSION_KEY, null);
}

export function languageHint(): 'ar' | 'en' {
  return read(LANG_KEY) === 'en' ? 'en' : 'ar';
}

export function setLanguageHint(l: 'ar' | 'en'): void {
  write(LANG_KEY, l);
}

export function pendingWipe(): string | null {
  return read(WIPE_KEY);
}

export function setPendingWipe(dbName: string | null): void {
  write(WIPE_KEY, dbName);
}
