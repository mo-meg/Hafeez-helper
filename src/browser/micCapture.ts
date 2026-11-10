import { downsample } from '../core/recitation/audio.ts';

export type MicErrorKind = 'unsupported' | 'denied' | 'not-found' | 'failed' | 'ended';

export class MicError extends Error {
  readonly kind: MicErrorKind;
  constructor(kind: MicErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface MicSession {
  stop(): void;
}

/**
 * Captures the microphone as 16 kHz mono float PCM. Audio stays in memory on this device and is
 * handed only to the recognition engine; nothing is recorded to disk.
 */
export async function startMicrophone(onPcm: (pcm16k: Float32Array) => void, onEnded: (e: MicError) => void): Promise<MicSession> {
  if (!navigator.mediaDevices?.getUserMedia) throw new MicError('unsupported', 'Microphone access is not available in this browser (a secure https or localhost page is required).');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicError('denied', 'Microphone permission was denied.');
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new MicError('not-found', 'No microphone was found.');
    throw new MicError('failed', e instanceof Error ? e.message : String(e));
  }
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor keeps this dependency- and worker-file-free; 4096 frames ≈ 85 ms at 48 kHz.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  proc.onaudioprocess = (ev) => onPcm(downsample(ev.inputBuffer.getChannelData(0), ctx.sampleRate));
  source.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    proc.disconnect();
    source.disconnect();
    for (const t of stream.getTracks()) t.stop();
    void ctx.close();
  };
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (stopped) return;
      stop();
      onEnded(new MicError('ended', 'The microphone stopped (device disconnected or permission revoked).'));
    });
  }
  if (ctx.state === 'suspended') await ctx.resume();
  return { stop };
}
