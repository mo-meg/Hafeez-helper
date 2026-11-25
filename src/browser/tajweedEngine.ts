import { TajweedClient, type TajweedDecoded, type TajweedModel, type TajweedSession } from '@quran-lab/tajweedformer';
import type { AyahUnits, EngineTake, HeardUpdate, LoadProgress, RecitationEngine, TakeEndReason } from '../core/recitation/engine.ts';
import type { HeardUnit } from '../core/recitation/segment.ts';

/**
 * TajweedFormer (Quran Lab) in the browser: `@quran-lab/tajweedformer` 4.x, no server of ours.
 * The package is a tiny wrapper (bundled): on the first `TajweedClient.create` it loads Quran Lab's
 * hosted loader (web.quranlab.ai/4/loader.js), which runs the engine and the protected model in a
 * Quran Lab frame + Worker. Nothing of it loads until the tracker starts.
 *
 * Needs a web key from sdk.quranlab.ai that lists the page's origin (build env HAFEEZ_QURANLAB_KEY).
 * The first start downloads the model (~57 MB) once; later starts work offline.
 */

/** One Client per page (the SDK refuses a second one). */
let clientPromise: Promise<TajweedClient> | null = null;

/** TajweedError carries a readable `message` and a `fix`; show both. */
export function engineErrorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const fix = (e as { fix?: unknown }).fix;
    const msg = String((e as { message: unknown }).message);
    return typeof fix === 'string' && fix && !msg.includes(fix) ? `${msg} ${fix}` : msg;
  }
  return String(e);
}

const readable = (e: unknown) => new Error(engineErrorText(e));

export class TajweedFormerEngine implements RecitationEngine {
  readonly name = 'TajweedFormer (Quran Lab)';
  separators: ReadonlySet<number> = new Set();
  private readonly key: string;
  private model: TajweedModel | null = null;
  /** Shortest-chunk context of the model (fast recitation, hadr): results arrive soonest. */
  private context: string | undefined;
  /**
   * 'fast': the shortest chunks (160 ms) — the page keeps up with hadr, the model hears less ahead.
   * 'accurate': the model's default chunks (320 ms) — a little later, but each decision hears more.
   * Read when a take starts, so a change applies from the next start / resume.
   */
  speed: 'fast' | 'accurate' = 'fast';
  private loading: Promise<void> | null = null;

  constructor(key: string) {
    this.key = key.trim();
  }

  load(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (!this.loading) {
      this.loading = this.open(onProgress).catch((e: unknown) => {
        this.loading = null;
        throw readable(e);
      });
    }
    return this.loading;
  }

  private async open(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (!this.key) throw new Error('No Quran Lab web key is configured (HAFEEZ_QURANLAB_KEY). See docs/RECITATION.md.');
    if (!clientPromise) {
      clientPromise = TajweedClient.create({ key: this.key, appVersion: '0.1.0' });
      clientPromise.catch(() => (clientPromise = null));
    }
    const client = await clientPromise;
    await client.prefetch({ ...(onProgress ? { onProgress } : {}) });
    const model = await client.model();
    if (!model.reference) throw new Error('This model build has no reference table, which the tracker needs.');
    if (!model.reference.isDownloaded) await model.reference.fetch();
    this.separators = new Set([model.tokens.wordBar, model.tokens.blank]);
    this.context = fastestContext(model);
    this.model = model;
  }

  async ayahUnits(surah: number, ayah: number): Promise<AyahUnits> {
    if (!this.model?.reference) throw new Error('The model is not loaded.');
    return this.model.reference.units(surah, ayah);
  }

  start(onUpdate: (u: HeardUpdate) => void, onEnd: (reason: TakeEndReason, error?: unknown) => void): EngineTake {
    if (!this.model) throw new Error('The model is not loaded.');
    const seps = this.separators;
    // Only the heads the tracker reads: recognition (always computed) and confidence.
    const session: TajweedSession = this.model.session({ sampleRate: 16000, heads: ['log_probs', 'conf'], ...(this.speed === 'fast' && this.context ? { context: this.context } : {}) });
    let finishing = false;
    let speech = false;
    const chunks = (async () => {
      for await (const chunk of session.chunks) {
        speech = chunk.speech;
        onUpdate(toUpdate(chunk.decoded, speech, seps));
      }
    })();
    void (async () => {
      for await (const ev of session.events) {
        if (ev.type !== 'ended' || finishing) continue;
        await chunks.catch(() => {});
        onEnd(ev.reason === 'error' ? 'error' : 'ended', ev.error ? readable(ev.error) : undefined);
      }
    })().catch(() => {});
    return {
      push: (pcm) => {
        try {
          session.push(pcm);
        } catch {
          /* the take already ended (onEnd reports it) */
        }
      },
      finish: async () => {
        finishing = true;
        try {
          await session.finish();
        } catch (e) {
          throw readable(e);
        }
        await chunks;
      },
      cancel: async () => {
        finishing = true;
        await session.cancel().catch(() => {});
      },
    };
  }
}

/** The context with the shortest chunks (README: 160 ms, default 320 ms); undefined keeps the default. */
export function fastestContext(model: Pick<TajweedModel, 'contexts' | 'chunkMs'>): string | undefined {
  let best: { name: string; ms: number } | undefined;
  for (const name of model.contexts) {
    let ms: number;
    try {
      ms = model.chunkMs(name);
    } catch {
      continue;
    }
    if (Number.isFinite(ms) && ms > 0 && (!best || ms < best.ms)) best = { name, ms };
  }
  return best?.name;
}

/** Maps the SDK's decoded layer to the engine boundary: a flat unit stream (word bars dropped). */
export function toUpdate(d: TajweedDecoded, speech: boolean, seps: ReadonlySet<number>): HeardUpdate {
  const units: HeardUnit[] = [];
  let settledUnits = 0;
  d.tokens.forEach((t, k) => {
    if (seps.has(t.id)) return;
    units.push({ id: t.id, name: t.name, startMs: t.firstMs, endMs: t.lastMs + 40, confidence: t.confidence });
    if (k < d.settled) settledUnits = units.length;
  });
  return { units, settledUnits, final: d.isFinal, text: d.text, speech };
}
