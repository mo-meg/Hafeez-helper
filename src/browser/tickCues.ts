import type { CuePlayer } from '../core/audio/playbackController.ts';
import type { CueKind } from '../core/playlist/sequence.ts';

/**
 * Non-musical orientation ticks. The sound is synthesized here (a few milliseconds of filtered,
 * fast-decaying noise — no pitch, no melody), encoded as a tiny WAV and played through its own
 * HTMLAudioElement, so it needs no download, works offline and keeps playing with the screen off
 * just like the recitation element.
 *
 *   group   → "tick-tick" (two bursts, 150 ms apart)
 *   mistake → "tick"
 */

const RATE = 22_050;

/** Deterministic noise so the tick sounds identical every time. */
function noise(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0x8000_0000 - 1;
  };
}

/** One dry click: band-limited noise with a ~4 ms decay. */
function burst(out: Float32Array, at: number, gain: number, seed: number): void {
  const rnd = noise(seed);
  const len = Math.floor(RATE * 0.03);
  let lp = 0;
  let prev = 0;
  for (let i = 0; i < len && at + i < out.length; i++) {
    const env = Math.exp(-i / (RATE * 0.004));
    lp += 0.35 * (rnd() - lp); // soften the hiss
    const hp = lp - prev; // remove rumble
    prev = lp;
    out[at + i] = (out[at + i] ?? 0) + hp * env * gain;
  }
}

function render(kind: CueKind): Float32Array {
  const total = Math.floor(RATE * (kind === 'group' ? 0.25 : 0.08));
  const out = new Float32Array(total);
  burst(out, 0, 1, 7);
  if (kind === 'group') burst(out, Math.floor(RATE * 0.15), 1, 7);
  // Normalize to a moderate peak so the tick never startles over the recitation.
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const k = peak > 0 ? 0.7 / peak : 0;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * k;
  return out;
}

/** 16-bit mono PCM WAV. */
export function encodeWav(samples: Float32Array, rate = RATE): Uint8Array<ArrayBuffer> {
  const data = samples.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, data, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return new Uint8Array(buf);
}

export function tickSamples(kind: CueKind): Float32Array {
  return render(kind);
}

export class TickCuePlayer implements CuePlayer {
  private readonly els = new Map<CueKind, HTMLAudioElement>();
  private primed = false;
  private priming = false;

  private el(kind: CueKind): HTMLAudioElement {
    let a = this.els.get(kind);
    if (!a) {
      const blob = new Blob([encodeWav(render(kind))], { type: 'audio/wav' });
      a = new Audio(URL.createObjectURL(blob));
      a.preload = 'auto';
      this.els.set(kind, a);
    }
    return a;
  }

  /** Unlocks both elements during a user gesture (mobile browsers block later programmatic play otherwise). */
  prime(): void {
    if (this.primed || this.priming) return;
    this.priming = true;
    const all = (['group', 'mistake'] as const).map((k) => {
      const a = this.el(k);
      a.muted = true;
      return a.play().then(() => {
        // If a real cue started meanwhile (play() unmutes), leave it playing.
        if (!a.muted) return;
        a.pause();
        a.currentTime = 0;
        a.muted = false;
      });
    });
    Promise.all(all)
      .then(() => (this.primed = true))
      .catch(() => {
        for (const a of this.els.values()) a.muted = false;
      })
      .finally(() => (this.priming = false));
  }

  play(kind: CueKind): void {
    const a = this.el(kind);
    a.muted = false;
    try {
      a.currentTime = 0;
    } catch {
      /* not loaded yet */
    }
    void a.play().catch(() => {
      /* blocked or interrupted: a missing tick must never affect the session */
    });
  }
}
