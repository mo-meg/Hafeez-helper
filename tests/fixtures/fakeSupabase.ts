import type { HttpFetch } from '../../src/core/sync/http.ts';

/** In-memory stand-in for the Supabase endpoints the app uses. */
export class FakeSupabase {
  rows = new Map<string, { user_id: string; tbl: string; id: string; data: unknown; deleted: boolean; seq: number }>();
  seq = 0;
  users = new Map<string, { id: string; password: string; confirmed: boolean }>();
  tokens = new Map<string, string>(); // access token -> user id
  online = true;
  expireNext = false;
  requests: string[] = [];
  confirmRequired = false;
  private n = 0;

  session(email: string) {
    const u = this.users.get(email) as { id: string };
    const access = `at-${++this.n}`;
    this.tokens.set(access, u.id);
    return { access_token: access, refresh_token: `rt-${u.id}`, expires_in: 3600, user: { id: u.id, email } };
  }

  fetch: HttpFetch = async (url, init) => {
    if (!this.online) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    this.requests.push(`${init.method} ${u.pathname}`);
    const body = init.body ? JSON.parse(init.body) : null;
    const reply = (status: number, json: unknown) => ({ ok: status < 300, status, text: async () => (json === undefined ? '' : JSON.stringify(json)) });
    if (init.headers.apikey !== 'anon-key') throw new Error('missing apikey header');
    if (u.pathname === '/auth/v1/signup') {
      if (this.users.has(body.email)) return reply(422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
      if (body.password.length < 6) return reply(422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 6 characters.' });
      this.users.set(body.email, { id: `user-${this.users.size + 1}`, password: body.password, confirmed: !this.confirmRequired });
      return reply(200, this.confirmRequired ? { id: 'x', email: body.email } : this.session(body.email));
    }
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password') {
      const user = this.users.get(body.email);
      if (!user || user.password !== body.password) return reply(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return reply(200, this.session(body.email));
    }
    if (u.pathname === '/auth/v1/token') {
      const email = [...this.users.entries()].find(([, v]) => `rt-${v.id}` === body.refresh_token)?.[0];
      if (!email) return reply(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      return reply(200, this.session(email));
    }
    const token = (init.headers.Authorization ?? '').replace('Bearer ', '');
    const uid = this.tokens.get(token);
    if (u.pathname.startsWith('/rest/v1/')) {
      if (!uid || this.expireNext) {
        this.expireNext = false;
        return reply(401, { message: 'JWT expired' });
      }
      if (u.pathname === '/rest/v1/user_records' && init.method === 'POST') {
        for (const r of body) {
          if (r.user_id !== uid) return reply(403, { message: 'row-level security violation' });
          this.rows.set(`${uid}/${r.tbl}/${r.id}`, { ...r, seq: ++this.seq });
        }
        return reply(201, undefined);
      }
      if (u.pathname === '/rest/v1/user_records' && init.method === 'GET') {
        const after = Number((u.searchParams.get('seq') ?? 'gt.0').slice(3));
        const limit = Number(u.searchParams.get('limit'));
        const list = [...this.rows.values()].filter((r) => r.user_id === uid && r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit);
        return reply(200, list.map(({ tbl, id, data, deleted, seq }) => ({ tbl, id, data, deleted, seq })));
      }
      if (u.pathname === '/rest/v1/rpc/delete_my_account') {
        for (const [k, r] of this.rows) if (r.user_id === uid) this.rows.delete(k);
        return reply(204, undefined);
      }
    }
    return reply(404, { message: 'not found' });
  };
}
