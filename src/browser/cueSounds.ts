import type { CueSoundSource } from '../core/audio/playbackController.ts';
import { istiadhaUrls } from '../core/audio/reciters.ts';
import type { CueSound } from '../core/settings/preferences.ts';
import type { AudioCache } from './audioCache.ts';
import { encodeWav, synthCue, type SynthCue } from './cueSynth.ts';

/**
 * Turns a chosen cue sound into playable URLs for the recitation player:
 *   synthesized sounds → in-memory WAV blob URLs (no download, work offline)
 *   'istiadha'         → reciter's own audhubillah.mp3 → general EveryAyah file → knock
 * Offline, an Isti'adha file is only used if it was downloaded with "Save for offline".
 */
export class CueSoundLibrary implements CueSoundSource {
  private readonly cache: AudioCache;
  private readonly isOnline: () => boolean;
  private readonly blobUrls = new Map<SynthCue, string>();
  private previewEl: HTMLAudioElement | null = null;

  constructor(cache: AudioCache, isOnline: () => boolean) {
    this.cache = cache;
    this.isOnline = isOnline;
  }

  private synthUrl(kind: SynthCue): string {
    let u = this.blobUrls.get(kind);
    if (!u) {
      u = URL.createObjectURL(new Blob([encodeWav(synthCue(kind))], { type: 'audio/wav' }));
      this.blobUrls.set(kind, u);
    }
    return u;
  }

  async sources(sound: CueSound, reciterTemplate: string): Promise<readonly string[]> {
    if (sound === 'none') return [];
    if (sound !== 'istiadha') return [this.synthUrl(sound)];
    const out: string[] = [];
    for (const url of istiadhaUrls(reciterTemplate)) {
      const offline = await this.cache.objectUrlFor(url);
      if (offline) out.push(offline);
      else if (this.isOnline()) out.push(url);
    }
    out.push(this.synthUrl('knock'));
    return out;
  }

  /** Plays a sound once for the Settings preview (a user gesture), trying fallbacks in order. */
  preview(sound: CueSound, reciterTemplate: string): void {
    const el = (this.previewEl ??= new Audio());
    el.pause();
    void this.sources(sound, reciterTemplate).then(async (urls) => {
      for (const url of urls) {
        try {
          el.src = url;
          await el.play();
          return;
        } catch {
          /* try the next candidate */
        }
      }
    });
  }
}
