/** Minimal fetch shape used by the cloud clients (injected so tests can fake the server). */
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

/** Public project settings. The anon key is designed to be public; Row Level Security protects data. */
export interface CloudConfig {
  readonly url: string;
  readonly anonKey: string;
}

/** Returns a config only when both values look usable; otherwise the app runs in local-only mode. */
export function cloudConfigFrom(url: string | undefined, anonKey: string | undefined): CloudConfig | null {
  const u = (url ?? '').trim().replace(/\/+$/, '');
  const k = (anonKey ?? '').trim();
  if (!u || !k) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return null;
  } catch {
    return null;
  }
  return { url: u, anonKey: k };
}

export async function readJson(res: HttpResponse): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 200) };
  }
}
