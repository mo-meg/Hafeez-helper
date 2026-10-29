import { AudioUnavailableError, type UrlResolver } from '../core/audio/playbackController.ts';
import { resolveAudioUrl } from '../core/audio/reciters.ts';
import type { KeyValue } from '../core/storage/store.ts';
import type { PlaybackStep } from '../core/playlist/sequence.ts';

/**
 * Offline audio: files are stored ONLY when the user explicitly downloads a playlist, and only
 * if the audio host allows cross-origin reads (CORS). Stored blobs are for personal offline use.
 */
export class AudioCache {
  private readonly kv: KeyValue;
  private readonly objectUrls = new Map<string, string>();
  constructor(kv: KeyValue) {
    this.kv = kv;
  }

  async has(url: string): Promise<boolean> {
    return (await this.kv.get<Blob>(url)) !== undefined;
  }

  async countCached(urls: readonly string[]): Promise<number> {
    let n = 0;
    for (const u of new Set(urls)) if (await this.has(u)) n++;
    return n;
  }

  async download(urls: readonly string[], onProgress: (done: number, total: number) => void): Promise<{ ok: number; failed: string[] }> {
    const unique = [...new Set(urls)];
    const failed: string[] = [];
    let ok = 0;
    for (const [i, url] of unique.entries()) {
      if (await this.has(url)) {
        ok++;
      } else {
        try {
          const res = await fetch(url, { mode: 'cors' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await this.kv.set(url, await res.blob());
          ok++;
        } catch {
          failed.push(url);
        }
      }
      onProgress(i + 1, unique.length);
    }
    return { ok, failed };
  }

  async totalBytes(): Promise<{ files: number; bytes: number }> {
    let bytes = 0;
    const keys = await this.kv.keys();
    for (const k of keys) bytes += (await this.kv.get<Blob>(k))?.size ?? 0;
    return { files: keys.length, bytes };
  }

  async clear(): Promise<void> {
    for (const k of await this.kv.keys()) await this.kv.delete(k);
    for (const u of this.objectUrls.values()) URL.revokeObjectURL(u);
    this.objectUrls.clear();
  }

  /** Prefers an offline copy; otherwise streams; offline without a copy is an explicit error. */
  resolver(template: () => string, isOnline: () => boolean): UrlResolver {
    return async (step: PlaybackStep) => {
      const url = resolveAudioUrl(template(), step.item.ref);
      const cachedUrl = this.objectUrls.get(url);
      if (cachedUrl) return cachedUrl;
      const blob = await this.kv.get<Blob>(url);
      if (blob) {
        const objectUrl = URL.createObjectURL(blob);
        this.objectUrls.set(url, objectUrl);
        return objectUrl;
      }
      if (!isOnline()) throw new AudioUnavailableError('you are offline and this ayah has not been downloaded for offline use');
      return url;
    };
  }
}
