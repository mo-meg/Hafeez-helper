import './ui/styles.css';
import { AudioCache } from './browser/audioCache.ts';
import { clearSession, languageHint, loadSession, pendingWipe, saveSession, setLanguageHint, setPendingWipe } from './browser/authStorage.ts';
import { HtmlAudioBackend } from './browser/htmlAudioBackend.ts';
import { createIdbStore, deleteDatabase, userDatabaseName } from './browser/idbStore.ts';
import { createServices } from './core/services.ts';
import { exportBackup, restoreBackup } from './core/storage/backup.ts';
import { createMemoryStore } from './core/storage/memoryStore.ts';
import type { Store } from './core/storage/store.ts';
import { AuthClient, parseAuthCallback, SessionManager, type AuthSession } from './core/sync/authClient.ts';
import { cloudConfigFrom, type CloudConfig, type HttpFetch } from './core/sync/http.ts';
import { SupabaseRecords, SyncEngine } from './core/sync/syncEngine.ts';
import { randomIds, systemClock } from './core/util/ids.ts';
import { App } from './ui/app.ts';
import type { AccountController } from './ui/auth/account.ts';
import { applyDocumentLanguage, authErrorText, showAuthScreen, showNewPasswordScreen, type AuthMessage } from './ui/auth/authView.ts';
import { confirmDialog } from './ui/components/dialog.ts';
import { t, tn } from './ui/i18n/index.ts';

/** Injected at build time from HAFEEZ_SUPABASE_URL / HAFEEZ_SUPABASE_ANON_KEY (see docs/DEPLOY.md). */
declare const __CLOUD_URL__: string | undefined;
declare const __CLOUD_ANON_KEY__: string | undefined;

const http: HttpFetch = (url, init) => fetch(url, init);

async function openDeviceStore(): Promise<{ store: Store; storageError?: string }> {
  try {
    return { store: await createIdbStore() };
  } catch (e) {
    return { store: createMemoryStore(), storageError: e instanceof Error ? e.message : String(e) };
  }
}

function startApp(root: HTMLElement, store: Store, extra: Partial<ConstructorParameters<typeof App>[0]> = {}): Promise<App> {
  const services = createServices({ store, clock: systemClock, ids: randomIds, fetcher: (url, init) => fetch(url, init) });
  const app = new App({ services, audioBackend: new HtmlAudioBackend(), audioCache: new AudioCache(store.audio), isOnline: () => navigator.onLine, ...extra });
  return app.start(root).then(() => app);
}

/** Local-only mode: no account; everything stays in this browser (used when no cloud is configured). */
async function bootLocal(root: HTMLElement): Promise<void> {
  const { store, storageError } = await openDeviceStore();
  await startApp(root, store, storageError ? { storageError } : {});
}

/** Cloud mode: sign-in is required; data is kept locally per account and synced to Supabase. */
async function bootCloud(root: HTMLElement, cfg: CloudConfig): Promise<void> {
  const wipe = pendingWipe();
  if (wipe) {
    await deleteDatabase(wipe);
    setPendingWipe(null);
  }
  applyDocumentLanguage(languageHint());
  const client = new AuthClient(cfg, http);
  const redirectTo = `${location.origin}${location.pathname}`;
  let session = loadSession();
  let message: AuthMessage | null = null;
  let recovery = false;
  let welcome: string | null = null;

  // Email links (confirmation, password reset) return with tokens in the URL fragment.
  const cb = parseAuthCallback(location.hash, Date.now());
  if (cb) {
    history.replaceState(null, '', `${location.pathname}${location.search}#/dashboard`);
    if (cb.kind === 'error') {
      message = { kind: 'error', text: () => (cb.code === 'link_expired' ? t('auth.e.link_expired') : t('auth.e.unknown', { detail: cb.message })) };
    } else {
      try {
        session = await client.sessionFromCallback(cb);
        saveSession(session);
        recovery = cb.type === 'recovery';
        if (cb.type === 'signup' || cb.type === 'email_change') welcome = 'auth.confirmed';
      } catch (e) {
        const text = authErrorText(e);
        message = { kind: 'error', text: () => text };
      }
    }
  }

  if (!session) {
    session = await showAuthScreen(root, { client, redirectTo, message, onLanguage: setLanguageHint });
    saveSession(session);
  }
  if (recovery) {
    await showNewPasswordScreen(root, { client, session, onLanguage: setLanguageHint });
    welcome = 'auth.passwordSaved';
  }
  await bootSignedIn(root, cfg, client, session, welcome);
}

async function bootSignedIn(root: HTMLElement, cfg: CloudConfig, client: AuthClient, session: AuthSession, welcome: string | null): Promise<void> {
  const { store: device, storageError } = await openDeviceStore();
  const dbName = userDatabaseName(session.user.id);
  let personal: Store;
  try {
    personal = await createIdbStore(dbName);
  } catch {
    personal = createMemoryStore();
  }
  // Personal tables per account; Quran data and audio caches are shared on the device.
  const base: Store = { ...personal, quranData: device.quranData, audio: device.audio };

  let ended = false;
  const endedListeners: Array<() => void> = [];
  const auth = new SessionManager({
    client,
    session,
    onChange: saveSession,
    onExpired: () => {
      ended = true;
      for (const l of endedListeners) l();
    },
  });
  const engine = new SyncEngine({ base, remote: new SupabaseRecords(cfg, http, auth) });
  await engine.init();

  // A new device starts in the language chosen on the sign-in screen (synced preferences may override it).
  if ((await base.settings.get('preferences')) === undefined) await base.settings.set('preferences', { language: languageHint() });

  const leave = (deleteLocalCopy: boolean) => {
    engine.stop();
    clearSession();
    if (deleteLocalCopy) setPendingWipe(dbName);
    location.replace(`${location.pathname}${location.search}#/dashboard`);
    location.reload();
  };

  const account: AccountController = {
    email: session.user.email,
    sync: engine,
    get sessionEnded() {
      return ended;
    },
    onSessionEnded: (fn) => endedListeners.push(fn),
    signInAgain: () => leave(false),
    async signOut() {
      await engine.syncNow();
      const pending = engine.pendingCount();
      if (pending > 0 && !(await confirmDialog(t('acct.signOutPendingTitle'), tn('acct.signOutPendingBody', pending), t('acct.signOutAnyway'), true))) return;
      try {
        await client.signOut(await auth.accessToken());
      } catch {
        /* already signed out on the server or offline: the local session is cleared anyway */
      }
      leave(true);
    },
    async deleteAccount() {
      await engine.deleteAccount();
      leave(true);
    },
    async changePassword(password: string) {
      await client.updatePassword(await auth.accessToken(), password);
    },
  };

  const app = await startApp(root, engine.store, { account, onLanguageChange: setLanguageHint, ...(storageError ? { storageError } : {}) });
  if (welcome === 'auth.confirmed' || welcome === 'auth.passwordSaved') app.toast(t(welcome));

  // Keep in sync: now (full), when coming back online or to the tab, and every minute while visible.
  void engine.syncNow({ full: true }).then(() => offerDeviceHistory(app, device, engine.store, session.user.id));
  window.addEventListener('online', () => void engine.syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void engine.syncNow();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && !ended) void engine.syncNow();
  }, 60_000);
}

/** History saved on this device before accounts existed can be added to the account once. */
async function offerDeviceHistory(app: App, device: Store, target: Store, userId: string): Promise<void> {
  const decisions = (await device.settings.get<Record<string, string>>('legacyImport')) ?? {};
  if (decisions[userId]) return;
  const count = (await device.mistakes.getAll()).length;
  if (count === 0) return;
  const yes = await confirmDialog(t('acct.importTitle'), tn('acct.importBody', count), t('acct.importYes'));
  if (yes) {
    const ok = await app.act(async () => {
      await restoreBackup(target, await exportBackup(device, new Date()), 'merge');
      await app.refresh();
    }, t('acct.imported'));
    if (!ok) return;
  }
  await device.settings.set('legacyImport', { ...decisions, [userId]: yes ? 'imported' : 'declined' });
}

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;
  const cfg = cloudConfigFrom(typeof __CLOUD_URL__ === 'string' ? __CLOUD_URL__ : '', typeof __CLOUD_ANON_KEY__ === 'string' ? __CLOUD_ANON_KEY__ : '');
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline shell unavailable; the app still works online */
    });
  }
  await (cfg ? bootCloud(root, cfg) : bootLocal(root));
}

boot().catch((e: unknown) => {
  const root = document.getElementById('app');
  // Shown before the interface language is known, so both languages are used.
  if (root) root.textContent = `تعذّر تشغيل التطبيق / Hafeez Helfer could not start: ${e instanceof Error ? e.message : String(e)}`;
});
