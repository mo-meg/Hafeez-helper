import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MistakeService } from '../src/core/mistakes/mistakeService.ts';
import { AuthClient, AuthError, authErrorFrom, parseAuthCallback, SessionManager, type AuthSession } from '../src/core/sync/authClient.ts';
import { cloudConfigFrom } from '../src/core/sync/http.ts';
import { SupabaseRecords, SyncEngine } from '../src/core/sync/syncEngine.ts';
import { createMemoryStore } from '../src/core/storage/memoryStore.ts';
import { FakeSupabase } from './fixtures/fakeSupabase.ts';
import { FixedClock, sequentialIds } from '../src/core/util/ids.ts';

const CFG = { url: 'https://demo.supabase.co', anonKey: 'anon-key' };

async function device(server: FakeSupabase, session: AuthSession) {
  const auth = new SessionManager({ client: new AuthClient(CFG, server.fetch), session, onChange: () => {}, onExpired: () => {} });
  const base = createMemoryStore();
  const engine = new SyncEngine({ base, remote: new SupabaseRecords(CFG, server.fetch, auth), schedule: () => 0 });
  await engine.init();
  const clock = new FixedClock('2026-03-01T08:00:00.000Z');
  const mistakes = new MistakeService({ store: engine.store, clock, ids: sequentialIds() });
  return { base, engine, mistakes };
}

describe('cloud configuration', () => {
  it('runs local-only unless both values are set and the URL is https', () => {
    assert.equal(cloudConfigFrom('', ''), null);
    assert.equal(cloudConfigFrom('https://x.supabase.co', ''), null);
    assert.equal(cloudConfigFrom('http://x.supabase.co', 'k'), null);
    assert.deepEqual(cloudConfigFrom('https://x.supabase.co/', ' k '), { url: 'https://x.supabase.co', anonKey: 'k' });
  });
});

describe('email + password authentication', () => {
  it('signs up, signs in, and maps errors to stable codes', async () => {
    const server = new FakeSupabase();
    const auth = new AuthClient(CFG, server.fetch);
    const s = await auth.signUp('a@example.com', 'secret-123', 'https://app/');
    assert.ok(s && s.user.email === 'a@example.com' && s.expiresAt > Date.now());
    await assert.rejects(auth.signUp('a@example.com', 'secret-123', 'https://app/'), (e: unknown) => e instanceof AuthError && e.code === 'user_already_exists');
    await assert.rejects(auth.signIn('a@example.com', 'wrong'), (e: unknown) => e instanceof AuthError && e.code === 'invalid_credentials');
    assert.equal((await auth.signIn('a@example.com', 'secret-123')).user.id, 'user-1');
    await assert.rejects(auth.signUp('b@example.com', '123', 'https://app/'), (e: unknown) => e instanceof AuthError && e.code === 'weak_password');
  });

  it('returns no session when the project requires email confirmation', async () => {
    const server = new FakeSupabase();
    server.confirmRequired = true;
    assert.equal(await new AuthClient(CFG, server.fetch).signUp('c@example.com', 'secret-123', 'https://app/'), null);
  });

  it('reports network failures distinctly', async () => {
    const server = new FakeSupabase();
    server.online = false;
    await assert.rejects(new AuthClient(CFG, server.fetch).signIn('a@example.com', 'x'), (e: unknown) => e instanceof AuthError && e.code === 'network');
  });

  it('understands both GoTrue error formats', () => {
    assert.equal(authErrorFrom(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }).code, 'invalid_credentials');
    assert.equal(authErrorFrom(400, { error_code: 'email_not_confirmed', msg: 'Email not confirmed' }).code, 'email_not_confirmed');
    assert.equal(authErrorFrom(429, { error_code: 'over_email_send_rate_limit' }).code, 'rate_limited');
    assert.equal(authErrorFrom(400, { error_code: 'refresh_token_not_found' }).code, 'session_expired');
  });

  it('parses email-link fragments and leaves app routes alone', () => {
    assert.equal(parseAuthCallback('#/quran?hizb=5', 0), null);
    const cb = parseAuthCallback('#access_token=A&refresh_token=R&expires_in=3600&type=recovery', 1000);
    assert.deepEqual(cb, { kind: 'session', type: 'recovery', accessToken: 'A', refreshToken: 'R', expiresAt: 1000 + 3_600_000 });
    const err = parseAuthCallback('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', 0);
    assert.equal(err?.kind === 'error' && err.code, 'link_expired');
  });

  it('refreshes an expiring token once and reports an expired session', async () => {
    const server = new FakeSupabase();
    const client = new AuthClient(CFG, server.fetch);
    const s = (await client.signUp('a@example.com', 'secret-123', 'https://app/')) as AuthSession;
    let saved: AuthSession | null = null;
    let expired = false;
    const mgr = new SessionManager({ client, session: { ...s, expiresAt: Date.now() + 1000 }, onChange: (n) => { saved = n; }, onExpired: () => { expired = true; } });
    const [a, b] = await Promise.all([mgr.accessToken(), mgr.accessToken()]);
    assert.equal(a, b, 'concurrent callers share one refresh');
    assert.ok(saved);
    const gone = new SessionManager({ client, session: { ...s, refreshToken: 'nope', expiresAt: 0 }, onChange: () => {}, onExpired: () => { expired = true; } });
    await assert.rejects(gone.accessToken());
    assert.ok(expired);
  });
});

describe('cloud sync', () => {
  it('uploads local changes and restores them on another device', async () => {
    const server = new FakeSupabase();
    const session = (await new AuthClient(CFG, server.fetch).signUp('a@example.com', 'secret-123', 'https://app/')) as AuthSession;
    const phone = await device(server, session);
    await phone.mistakes.markAyah({ surah: 2, ayah: 255 }, { category: 'forgotten', note: 'private note' });
    await phone.engine.store.settings.set('preferences', { language: 'en' });
    await phone.engine.store.settings.set('lastReminderDate', '2026-03-01');
    assert.ok(phone.engine.pendingCount() >= 3);
    await phone.engine.syncNow();
    assert.equal(phone.engine.pendingCount(), 0);
    assert.equal(phone.engine.status.state, 'synced');
    assert.ok(![...server.rows.values()].some((r) => r.id === 'lastReminderDate'), 'device-only settings stay local');

    const laptop = await device(server, session);
    await laptop.engine.syncNow({ full: true });
    const ms = await laptop.base.mistakes.getAll();
    assert.equal(ms.length, 1);
    assert.equal(ms[0]?.note, 'private note');
    assert.deepEqual(await laptop.base.settings.get('preferences'), { language: 'en' });
    assert.equal((await laptop.base.mistakeEvents.getAll()).length, (await phone.base.mistakeEvents.getAll()).length);
  });

  it('propagates deletions and clears', async () => {
    const server = new FakeSupabase();
    const session = (await new AuthClient(CFG, server.fetch).signUp('a@example.com', 'secret-123', 'https://app/')) as AuthSession;
    const a = await device(server, session);
    const b = await device(server, session);
    const { mistake: m } = await a.mistakes.markAyah({ surah: 1, ayah: 1 }, { category: 'other' });
    await a.engine.syncNow();
    await b.engine.syncNow();
    assert.equal((await b.base.mistakes.getAll()).length, 1);
    await a.mistakes.deletePermanently(m.id);
    await a.engine.store.reviews.clear();
    await a.engine.syncNow();
    let changes = 0;
    b.engine.onRemoteChange = (n) => { changes = n; };
    await b.engine.syncNow();
    assert.equal((await b.base.mistakes.getAll()).length, 0);
    assert.ok(changes > 0, 'UI is told to reload');
  });

  it('keeps pending local edits when the server has an older copy', async () => {
    const server = new FakeSupabase();
    const session = (await new AuthClient(CFG, server.fetch).signUp('a@example.com', 'secret-123', 'https://app/')) as AuthSession;
    const a = await device(server, session);
    const { mistake: m } = await a.mistakes.markAyah({ surah: 3, ayah: 7 }, { category: 'other', note: 'v1' });
    await a.engine.syncNow();
    server.online = false;
    await a.mistakes.update(m.id, { note: 'v2 offline' });
    await a.engine.syncNow();
    assert.equal(a.engine.status.state, 'offline');
    assert.ok(a.engine.pendingCount() > 0, 'change waits in the outbox');
    server.online = true;
    await a.engine.syncNow({ full: true });
    assert.equal((await a.base.mistakes.get(m.id))?.note, 'v2 offline');
    assert.equal(a.engine.pendingCount(), 0);
    const row = [...server.rows.values()].find((r) => r.id === m.id);
    assert.equal((row?.data as { note: string }).note, 'v2 offline');
  });

  it('retries once with a fresh token after a 401', async () => {
    const server = new FakeSupabase();
    const session = (await new AuthClient(CFG, server.fetch).signUp('a@example.com', 'secret-123', 'https://app/')) as AuthSession;
    const a = await device(server, session);
    await a.mistakes.markAyah({ surah: 1, ayah: 2 }, { category: 'other' });
    server.expireNext = true;
    await a.engine.syncNow();
    assert.equal(a.engine.status.state, 'synced');
    assert.ok(server.requests.includes('POST /auth/v1/token'), 'token refreshed');
  });

  it('ignores malformed or foreign remote rows', async () => {
    const server = new FakeSupabase();
    const session = (await new AuthClient(CFG, server.fetch).signUp('a@example.com', 'secret-123', 'https://app/')) as AuthSession;
    server.rows.set('x1', { user_id: session.user.id, tbl: 'mistakes', id: 'm1', data: { id: 'm1', bogus: true }, deleted: false, seq: ++server.seq });
    server.rows.set('x2', { user_id: session.user.id, tbl: 'settings', id: 'lastReminderDate', data: 'x', deleted: false, seq: ++server.seq });
    server.rows.set('x3', { user_id: session.user.id, tbl: 'evil', id: 'e', data: {}, deleted: false, seq: ++server.seq });
    const a = await device(server, session);
    await a.engine.syncNow({ full: true });
    assert.equal((await a.base.mistakes.getAll()).length, 0);
    assert.equal(await a.base.settings.get('lastReminderDate'), undefined);
    assert.equal(a.engine.status.state, 'synced');
  });

  it('deletes the account data on the server', async () => {
    const server = new FakeSupabase();
    const session = (await new AuthClient(CFG, server.fetch).signUp('a@example.com', 'secret-123', 'https://app/')) as AuthSession;
    const a = await device(server, session);
    await a.mistakes.markAyah({ surah: 1, ayah: 3 }, { category: 'other' });
    await a.engine.syncNow();
    assert.ok(server.rows.size > 0);
    await a.engine.deleteAccount();
    assert.equal(server.rows.size, 0);
  });
});
