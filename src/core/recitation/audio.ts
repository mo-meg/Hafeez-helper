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

