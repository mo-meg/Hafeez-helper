/**
 * Synthesized, NON-MUSICAL cue sounds. Every sound is shaped noise (no tones, no melody, no
 * intervals), so it reads as an everyday object sound:
 *
 *   knock  → two knocks on wood ("tok-tok")
 *   page   → a paper page being turned (rustle + soft flap)
 *   whoosh → a breath of air passing by
 *   clap   → one hand clap
 *   tick   → two dry clicks
 *
 * Each starts with 50 ms of silence so Bluetooth earphones / power-saving audio paths are awake
 * before the sound begins (otherwise the first part is often swallowed). Pure functions: no DOM.
 */

export const SYNTH_CUES = ['knock', 'page', 'whoosh', 'clap', 'tick'] as const;
export type SynthCue = (typeof SYNTH_CUES)[number];

export const CUE_RATE = 22_050;
const LEAD = 0.05;

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0x8000_0000 - 1;
  };
}

/** RBJ band-pass (constant 0 dB peak gain); frequency may change per sample. */
class BandPass {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  run(x: number, f: number, q: number): number {
    const w = (2 * Math.PI * f) / CUE_RATE;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    // b0 = alpha, b1 = 0, b2 = -alpha, a1 = -2cos(w), a2 = 1 - alpha
    const y = (alpha * x - alpha * this.x2 + 2 * Math.cos(w) * this.y1 - (1 - alpha) * this.y2) / a0;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

const sec = (s: number) => Math.round(s * CUE_RATE);

/** Adds a decaying noise burst at `at` seconds through a band-pass. */
function burst(out: Float32Array, at: number, o: { tau: number; f: number; q: number; gain?: number; seed: number; len?: number }): void {
  const r = rng(o.seed);
  const bp = new BandPass();
  const start = sec(at);
  const len = sec(o.len ?? o.tau * 8);
  for (let i = 0; i < len && start + i < out.length; i++) {
    const env = Math.exp(-i / (o.tau * CUE_RATE));
    out[start + i] = (out[start + i] ?? 0) + bp.run(r() * env, o.f, o.q) * (o.gain ?? 1);
  }
}

function knock(): Float32Array {
  const out = new Float32Array(sec(0.55));
  for (const [at, g] of [[LEAD, 1], [LEAD + 0.22, 0.85]] as const) {
    burst(out, at, { tau: 0.012, f: 380, q: 5, gain: g, seed: 11 }); // wooden body
    burst(out, at, { tau: 0.004, f: 1300, q: 2.5, gain: 0.5 * g, seed: 12 }); // knuckle contact
    burst(out, at, { tau: 0.02, f: 160, q: 1.2, gain: 0.6 * g, seed: 13 }); // thud
  }
  return out;
}

function page(): Float32Array {
  const out = new Float32Array(sec(0.65));
  const r = rng(21);
  const grain = rng(22);
  const bp = new BandPass();
  const n = sec(0.45);
  let held = 1;
  let smooth = 1;
  for (let i = 0; i < n; i++) {
    const x = i / n;
    if (i % sec(0.006) === 0) held = 0.25 + 0.75 * Math.abs(grain());
    smooth += 0.08 * (held - smooth);
    const env = Math.pow(Math.sin(Math.PI * x), 1.5) * smooth;
    const j = sec(LEAD) + i;
    out[j] = (out[j] ?? 0) + bp.run(r() * env, 2600 + 1400 * x, 0.8);
  }
  burst(out, LEAD + 0.43, { tau: 0.018, f: 700, q: 0.9, gain: 1.4, seed: 23 }); // page lands
  return out;
}

function whoosh(): Float32Array {
  const out = new Float32Array(sec(0.7));
  const r = rng(31);
  const bp = new BandPass();
  const n = sec(0.58);
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const s = Math.sin(Math.PI * x);
    const j = sec(LEAD) + i;
    out[j] = bp.run(r() * s * s, 300 + 2000 * s * s, 1.2);
  }
  return out;
}

function clap(): Float32Array {
  const out = new Float32Array(sec(0.35));
  for (const [dt, seed] of [[0, 41], [0.009, 42], [0.019, 43]] as const) burst(out, LEAD + dt, { tau: 0.0025, f: 1100, q: 1, seed });
  burst(out, LEAD + 0.019, { tau: 0.035, f: 1100, q: 1, gain: 0.55, seed: 44, len: 0.25 }); // room tail
  return out;
}

function tick(): Float32Array {
  const out = new Float32Array(sec(0.32));
  burst(out, LEAD, { tau: 0.003, f: 2500, q: 1.5, seed: 51 });
  burst(out, LEAD + 0.15, { tau: 0.003, f: 2500, q: 1.5, seed: 51 });
  return out;
}

const PEAK: Record<SynthCue, number> = { knock: 0.85, page: 0.55, whoosh: 0.5, clap: 0.85, tick: 0.75 };
const RENDER: Record<SynthCue, () => Float32Array> = { knock, page, whoosh, clap, tick };

export function synthCue(kind: SynthCue): Float32Array {
  const out = RENDER[kind]();
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const k = peak > 0 ? PEAK[kind] / peak : 0;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * k;
  return out;
}

/** 16-bit mono PCM WAV. */
export function encodeWav(samples: Float32Array, rate = CUE_RATE): Uint8Array<ArrayBuffer> {
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
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 0x7fff), true));
  return new Uint8Array(buf);
}
