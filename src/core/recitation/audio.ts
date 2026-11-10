/** The model expects 16 kHz mono float PCM. */
export const MODEL_RATE = 16000;

/** Box-filtered linear downsampling to 16 kHz (adequate for speech; no dependency). */
export function downsample(input: Float32Array, inRate: number, outRate = MODEL_RATE): Float32Array {
  if (inRate === outRate) return input.slice();
  if (inRate < outRate) throw new Error(`Cannot upsample ${inRate} Hz to ${outRate} Hz`);
  const ratio = inRate / outRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let k = a; k < b; k++) sum += input[k] as number;
    out[i] = b > a ? sum / (b - a) : 0;
  }
  return out;
}

export interface AudioChunk {
  readonly pcm: Float32Array;
  /** Session time (ms) of the first sample. */
  readonly startMs: number;
  readonly endMs: number;
  readonly silenceBeforeMs: number;
  /** False when the chunk was cut inside continuous speech (its last word may be cut off). */
  readonly final: boolean;
}

export interface ChunkerConfig {
  readonly frameMs: number;
  /** Silence that closes an utterance chunk. */
  readonly endSilenceMs: number;
  readonly minChunkMs: number;
  /** Longest chunk; long continuous recitation is cut at the quietest recent frame. */
  readonly maxChunkMs: number;
  /** Absolute RMS floor for speech. */
  readonly minRms: number;
}

export const DEFAULT_CHUNKER: ChunkerConfig = { frameMs: 20, endSilenceMs: 400, minChunkMs: 700, maxChunkMs: 4000, minRms: 0.01 };

/**
 * Energy-based voice activity chunker. Each sample is emitted in exactly one chunk. Silence-only
 * audio is dropped but measured. Chunks cut inside continuous speech are marked `final: false`;
 * the controller then re-recognises only their unconfirmed tail together with the next chunk.
 */
export class Chunker {
  private readonly cfg: ChunkerConfig;
  private readonly frameLen: number;
  private carry: Float32Array = new Float32Array(0);
  private frames: Float32Array[] = [];
  private energies: number[] = [];
  private speechStartMs: number | null = null;
  private trailingSilence = 0;
  private silenceMs = 0;
  private noise = 0.003;
  /** A non-final chunk was emitted; the utterance must still be closed with a final chunk. */
  private open = false;
  private t = 0;

  constructor(cfg: Partial<ChunkerConfig> = {}) {
    this.cfg = { ...DEFAULT_CHUNKER, ...cfg };
    this.frameLen = Math.round((MODEL_RATE * this.cfg.frameMs) / 1000);
  }

  push(pcm: Float32Array): AudioChunk[] {
    const data = new Float32Array(this.carry.length + pcm.length);
    data.set(this.carry);
    data.set(pcm, this.carry.length);
    const out: AudioChunk[] = [];
    let off = 0;
    for (; off + this.frameLen <= data.length; off += this.frameLen) {
      const c = this.frame(data.subarray(off, off + this.frameLen));
      if (c) out.push(c);
    }
    this.carry = data.slice(off);
    return out;
  }

  /** Emits whatever speech is buffered (on stop). */
  flush(): AudioChunk[] {
    const c = this.emit(this.frames.length);
    return c ? [c] : [];
  }

  private frame(f: Float32Array): AudioChunk | null {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += (f[i] as number) ** 2;
    const rms = Math.sqrt(sum / f.length);
    // Noise floor: falls fast, rises very slowly and is capped. (Measured on real recordings: a
    // floor learned from quiet reverberant passages otherwise climbs above soft speech, which
    // was then dropped as silence.)
    this.noise = Math.min(0.008, rms < this.noise ? this.noise * 0.9 + rms * 0.1 : this.noise * 0.999 + rms * 0.001);
    const speech = rms > Math.max(this.cfg.minRms, this.noise * 3);
    const startT = this.t;
    this.t += this.cfg.frameMs;
    if (this.speechStartMs === null) {
      if (!speech) {
        this.silenceMs += this.cfg.frameMs;
        return null;
      }
      this.speechStartMs = startT;
    }
    this.frames.push(f.slice());
    this.energies.push(rms);
    this.trailingSilence = speech ? 0 : this.trailingSilence + this.cfg.frameMs;
    const lenMs = this.frames.length * this.cfg.frameMs;
    if (this.trailingSilence >= this.cfg.endSilenceMs) {
      if (lenMs - this.trailingSilence < this.cfg.minChunkMs * 0.4) return this.discard();
      return this.emit(this.frames.length - Math.floor(this.trailingSilence / this.cfg.frameMs), this.trailingSilence);
    }
    if (lenMs >= this.cfg.maxChunkMs) {
      // cut at the quietest frame within the last second
      const look = Math.min(this.energies.length - 1, Math.round(1000 / this.cfg.frameMs));
      let cut = this.energies.length;
      let min = Infinity;
      for (let k = this.energies.length - look; k < this.energies.length; k++) {
        if ((this.energies[k] as number) < min) {
          min = this.energies[k] as number;
          cut = k + 1;
        }
      }
      return this.emit(cut, 0, true);
    }
    return null;
  }

  private discard(): AudioChunk | null {
    const closing = this.open ? this.closer() : null;
    this.silenceMs += this.frames.length * this.cfg.frameMs;
    this.reset();
    return closing;
  }

  /** Empty final chunk: closes an utterance whose last audio was already sent. */
  private closer(): AudioChunk {
    const at = this.speechStartMs ?? this.t;
    this.open = false;
    return { pcm: new Float32Array(0), startMs: at, endMs: at, silenceBeforeMs: 0, final: true };
  }

  private reset(): void {
    this.frames = [];
    this.energies = [];
    this.speechStartMs = null;
    this.trailingSilence = 0;
  }

  private emit(count: number, trailingSilenceMs = 0, keepRest = false): AudioChunk | null {
    if (this.speechStartMs === null || count <= 0) {
      const closing = this.open ? this.closer() : null;
      this.reset();
      this.silenceMs = trailingSilenceMs;
      return closing;
    }
    const take = this.frames.slice(0, count);
    const pcm = new Float32Array(take.length * this.frameLen);
    take.forEach((fr, i) => pcm.set(fr, i * this.frameLen));
    const startMs = this.speechStartMs;
    const chunk: AudioChunk = { pcm, startMs, endMs: startMs + take.length * this.cfg.frameMs, silenceBeforeMs: this.silenceMs, final: !keepRest };
    this.open = keepRest;
    if (keepRest) {
      this.frames = this.frames.slice(count);
      this.energies = this.energies.slice(count);
      this.speechStartMs = chunk.endMs;
      this.silenceMs = 0;
    } else {
      this.reset();
      this.silenceMs = trailingSilenceMs;
    }
    return chunk;
  }
}
