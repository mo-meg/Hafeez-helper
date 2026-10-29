/** What the app shell needs to know about the signed-in account (absent in local-only mode). */
import type { SyncEngine, SyncStatus } from '../../core/sync/syncEngine.ts';
import { fmtRelativeTime, t, tn } from '../i18n/index.ts';

export interface AccountController {
  readonly email: string;
  readonly sync: SyncEngine;
  /** True after the refresh token was rejected; local changes keep waiting in the outbox. */
  readonly sessionEnded: boolean;
  onSessionEnded(fn: () => void): void;
  signOut(): Promise<void>;
  /** Signs in again (clears the session, keeps local data, reloads to the sign-in screen). */
  signInAgain(): void;
  deleteAccount(): Promise<void>;
  changePassword(password: string): Promise<void>;
}

export function syncStatusText(s: SyncStatus, now: Date): string {
  switch (s.state) {
    case 'syncing':
      return t('sync.syncing');
    case 'offline':
      return s.pending ? tn('sync.offlinePending', s.pending) : t('sync.offline');
    case 'error':
      return t('sync.error', { detail: s.error ?? '' });
    default:
      return s.lastSyncedAt ? t('sync.synced', { when: fmtRelativeTime(s.lastSyncedAt, now) }) : t('sync.idle');
  }
}
