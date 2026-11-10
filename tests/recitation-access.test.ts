import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRecitationAdmin, RecitationAccess } from '../src/core/recitation/access.ts';
import { LocalAsrEngine } from '../src/browser/localAsrEngine.ts';
import type { HttpFetch } from '../src/core/sync/http.ts';

const cfg = { url: 'https://x.supabase.co', anonKey: 'anon' };
function fake(reply: (method: string, url: string, body: unknown) => { status?: number; json: unknown }) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  const http: HttpFetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, url, headers: init.headers, body });
    const r = reply(init.method, url, body);
    const status = r.status ?? 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(r.json) };
  };
  return { http, calls };
}
const auth = (email: string) => ({ accessToken: async () => 'tok', user: { id: 'u1', email } });

describe('recitation access', () => {
  it('recognises the admin email case-insensitively', () => {
    assert.ok(isRecitationAdmin(' MMM_Megahed@Hotmail.com '));
    assert.ok(!isRecitationAdmin('someone@example.com'));
  });

  it('admin is approved without asking the server', async () => {
    const f = fake(() => ({ json: [] }));
    assert.equal(await new RecitationAccess(cfg, f.http, auth('mmm_megahed@hotmail.com')).myStatus(), 'approved');
    assert.equal(f.calls.length, 0);
  });

  it('reads own status: none, pending, approved', async () => {
    let rows: unknown[] = [];
    const f = fake(() => ({ json: rows }));
    const a = new RecitationAccess(cfg, f.http, auth('a@b.c'));
    assert.equal(await a.myStatus(), 'none');
    rows = [{ status: 'pending' }];
    assert.equal(await a.myStatus(), 'pending');
    rows = [{ status: 'approved' }];
    assert.equal(await a.myStatus(), 'approved');
    assert.match(f.calls[0]!.url, /recitation_access\?select=status&user_id=eq\.u1$/);
    assert.equal(f.calls[0]!.headers.Authorization, 'Bearer tok');
  });

  it('a request is always created as pending for the signed-in user', async () => {
    const f = fake(() => ({ json: null }));
    await new RecitationAccess(cfg, f.http, auth('a@b.c')).request();
    assert.deepEqual(f.calls[0]!.body, { user_id: 'u1', status: 'pending' });
    assert.match(f.calls[0]!.headers.Prefer ?? '', /ignore-duplicates/);
  });

  it('admin lists and decides', async () => {
    const f = fake((m) => ({ json: m === 'GET' ? [{ user_id: 'u2', email: 'x@y.z', status: 'pending', requested_at: '2026-11-10T10:00:00Z' }, { bad: true }] : null }));
    const a = new RecitationAccess(cfg, f.http, auth('mmm_megahed@hotmail.com'));
    const list = await a.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.email, 'x@y.z');
    await a.decide('u2', 'approved', new Date('2026-11-10T12:00:00Z'));
    const patch = f.calls.at(-1)!;
    assert.equal(patch.method, 'PATCH');
    assert.match(patch.url, /user_id=eq\.u2$/);
    assert.deepEqual(patch.body, { status: 'approved', decided_at: '2026-11-10T12:00:00.000Z' });
  });

  it('surfaces server errors', async () => {
    const f = fake(() => ({ status: 403, json: { message: 'permission denied' } }));
    await assert.rejects(new RecitationAccess(cfg, f.http, auth('a@b.c')).request(), /permission denied/);
  });
});

describe('recognition engine endpoints', () => {
  it('refuses a public server unless explicitly allowed', () => {
    assert.throws(() => new LocalAsrEngine('https://tunnel.example.com'));
    assert.doesNotThrow(() => new LocalAsrEngine('https://tunnel.example.com', 1000, { allowRemote: true }));
    assert.doesNotThrow(() => new LocalAsrEngine('http://127.0.0.1:8765'));
  });
});
