import { encodeWav, isLocalEndpoint, type AsrEngine, type AsrResult, type AsrWord } from '../core/recitation/engine.ts';

export const DEFAULT_ASR_ENDPOINT = 'http://127.0.0.1:8765';

/**
 * Talks to the local FastConformer inference server (`scripts/asr_server.py`) on this computer.
 * Only loopback addresses are accepted, so microphone audio never leaves the device.
 */
export class LocalAsrEngine implements AsrEngine {
  readonly name: string;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(endpoint: string, timeoutMs = 15000) {
    if (!isLocalEndpoint(endpoint)) throw new Error(`Only a local recognition server is allowed (127.0.0.1 / localhost), not ${endpoint}`);
    this.base = endpoint.replace(/\/+$/, '');
    this.name = `fastconformer-quran-ar @ ${this.base}`;
    this.timeoutMs = timeoutMs;
  }

  async load(): Promise<void> {
    const res = await this.request('/health', { method: 'GET' }).catch(() => {
      throw new Error(`The local recognition server is not reachable at ${this.base}. Start it with: python scripts/asr_server.py`);
    });
    const body = (await res.json().catch(() => ({}))) as { ready?: boolean; error?: string };
    if (!res.ok || body.ready === false) throw new Error(body.error ?? `Recognition server is not ready (HTTP ${res.status})`);
  }

  async transcribe(pcm16k: Float32Array): Promise<AsrResult> {
    const wav = encodeWav(pcm16k);
    const res = await this.request('/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav.buffer as ArrayBuffer });
    if (!res.ok) throw new Error(`Recognition failed (HTTP ${res.status})`);
    const body = (await res.json()) as { text?: unknown; words?: unknown };
    const words = Array.isArray(body.words)
      ? body.words.filter((w): w is AsrWord => !!w && typeof w === 'object' && typeof (w as AsrWord).word === 'string' && typeof (w as AsrWord).start === 'number' && typeof (w as AsrWord).end === 'number')
      : undefined;
    return { text: typeof body.text === 'string' ? body.text : '', ...(words && words.length ? { words } : {}) };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await fetch(this.base + path, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
