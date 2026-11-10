// Runs a real recording through the Recitation Tracker exactly as the browser would (85 ms frames
// → Chunker → sliding-window recognition → tracker) and prints where the reciter was located and
// what was found. Needs the local recognition server (python scripts/asr_server.py) and ffmpeg.
//   node scripts/recitation-file-check.ts recording.ogg [--seconds 300] [--endpoint URL]
//        [--cache /tmp/asr-cache] [--budget 140]
// With --cache, recognition results are stored per audio window, so a long file can be processed
// over several runs (each run stops after --budget seconds of wall time and resumes from cache).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalAsrEngine } from '../src/browser/localAsrEngine.ts';
import { DivisionIndex } from '../src/core/quran/divisions.ts';
import { QuranText } from '../src/core/quran/text.ts';
import { RecitationController } from '../src/core/recitation/controller.ts';
import { RecitationCorpus } from '../src/core/recitation/corpus.ts';
import type { AsrResult } from '../src/core/recitation/engine.ts';
import { RecitationTracker } from '../src/core/recitation/tracker.ts';

const args = process.argv.slice(2);
const arg = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] as string) : dflt;
};
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!file) throw new Error('usage: node scripts/recitation-file-check.ts recording.ogg [--seconds N]');
const seconds = Number(arg('seconds', '0'));
const cacheDir = arg('cache', '');
const budgetMs = Number(arg('budget', '0')) * 1000;
const RATE = 16000;
const started = Date.now();

const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, ...(seconds ? ['-t', String(seconds)] : []), '-f', 'f32le', '-ac', '1', '-ar', String(RATE), '-'], { maxBuffer: 1 << 30 });
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();

const real = new LocalAsrEngine(arg('endpoint', 'http://127.0.0.1:8765'), 120000);
if (cacheDir) mkdirSync(cacheDir, { recursive: true });
let misses = 0;
let recognitions = 0;
let recogMs = 0;
const engine = {
  name: real.name,
  load: async () => {},
  async transcribe(pcm: Float32Array): Promise<AsrResult> {
    recognitions++;
    const key = createHash('sha1').update(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)).digest('hex');
    const path = cacheDir ? join(cacheDir, `${key}.json`) : '';
    if (path && existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as AsrResult;
    if (budgetMs && Date.now() - started > budgetMs) {
      console.log(`\n[budget reached at ${(audio.length / RATE).toFixed(0)} s file; cached so far — run again to continue]`);
      process.exit(3);
    }
    misses++;
    const t0 = Date.now();
    const r = await real.transcribe(pcm);
    recogMs += Date.now() - t0;
    if (path) writeFileSync(path, JSON.stringify(r));
    return r;
  },
};

const text = new QuranText(JSON.parse(readFileSync('public/data/quran-text.json', 'utf8')));
const corpus = new RecitationCorpus(text, new DivisionIndex(JSON.parse(readFileSync('public/data/divisions.json', 'utf8'))));
const tracker = new RecitationTracker(corpus);
// --debug FROM-TO (seconds): print the words handed to the tracker in that span
const [dFrom, dTo] = arg('debug', '').split('-').map(Number);
if (dTo) {
  const push = tracker.push.bind(tracker);
  tracker.push = (ch) => {
    if (ch.startMs / 1000 >= (dFrom as number) && ch.startMs / 1000 <= dTo) console.log(`        commit ${fmt(ch.startMs)} [${ch.words.map((w) => `${w.raw}@${((w.startMs ?? 0) / 1000).toFixed(1)}`).join(' ')}] -> cursor ${tracker.cursor}`);
    push(ch);
  };
}
const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
let lastAyah = '';
let lastMode = '';
let feedMs = 0;
const c = new RecitationController({
  engine,
  tracker,
  onUpdate: (st) => {
    const loc = st.tracker.location;
    const ayah = loc ? `${loc.ref.surah}:${loc.ref.ayah}` : '-';
    if (ayah !== lastAyah || st.tracker.mode !== lastMode) {
      console.log(`${fmt(feedMs).padStart(5)}  ${st.tracker.mode.padEnd(9)} ${loc ? `${ayah} word ${loc.position} page ${loc.page}` : ''}`);
      lastAyah = ayah;
      lastMode = st.tracker.mode;
    }
  },
});
await c.start();
const frame = Math.round(RATE * 0.085);
for (let o = 0; o < audio.length; o += frame) {
  feedMs = (o / RATE) * 1000;
  c.feed(audio.subarray(o, o + frame));
  await c.idle();
}
await c.stop();
const s = c.state().tracker;
const byKind = new Map<string, string[]>();
for (const f of s.findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), `${f.ref.surah}:${f.ref.ayah}#${f.position} ${f.tokenText}${f.heard ? ` (heard ${f.heard})` : ''} @${fmt(f.atMs)}`]);
const statuses = new Map<string, number>();
for (const v of s.status.values()) statuses.set(v, (statuses.get(v) ?? 0) + 1);
console.log(`\naudio ${fmt(audio.length / RATE * 1000)} | words followed ${s.recitedWords} | statuses ${JSON.stringify(Object.fromEntries(statuses))} | self-corrections ${s.selfCorrections}`);
console.log(`recognitions ${recognitions} (${misses} new, avg ${misses ? Math.round(recogMs / misses) : 0} ms)`);
for (const [k, list] of byKind) console.log(`\n${k} (${list.length}):\n  ${list.join('\n  ')}`);
