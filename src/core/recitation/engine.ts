/**
 * Speech-recognition engine boundary. The tracker only needs words; engines may add word
 * timestamps when the model really produces them (never derived from a sentence transcript).
 */
export interface AsrWord {
  readonly word: string;
  /** Seconds from the start of the submitted audio. */
  readonly start: number;
  readonly end: number;
  readonly confidence?: number;
}

export interface AsrResult {
  readonly text: string;
  readonly words?: readonly AsrWord[];
}

export interface AsrEngine {
  /** Human-readable engine id, e.g. "fastconformer-quran-ar @ http://127.0.0.1:8765". */
  readonly name: string;
  /** Loads / health-checks the model. Rejects with a readable message on failure. */
  load(): Promise<void>;
  /** Recognises one 16 kHz mono chunk. */
  transcribe(pcm16k: Float32Array): Promise<AsrResult>;
}

/** Encodes 16 kHz mono float PCM as a 16-bit WAV (what the local inference server accepts). */
export function encodeWav(pcm: Float32Array, rate = 16000): Uint8Array {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
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
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, pcm[i] as number)) * 32767), true);
  return new Uint8Array(buf);
}

/** True for loopback endpoints only: recordings must not leave the device. */
export function isLocalEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}
