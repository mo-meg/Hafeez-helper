// End-to-end check of the Recitation Tracker with REAL recorded recitation and the REAL model.
// Requires: the local recognition server (python scripts/asr_server.py), ffmpeg, internet access
// to everyayah.com (audio is downloaded at run time, never committed), and public/data/*.json.
//   node scripts/recitation-audio-check.ts [--endpoint http://127.0.0.1:8765] [--reciter Husary_64kbps]
// Audio is fed in 85 ms frames through the same Chunker → engine → tracker path as the browser.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DivisionIndex } from '../src/core/quran/divisions.ts';
import { QuranText } from '../src/core/quran/text.ts';
import { RecitationController } from '../src/core/recitation/controller.ts';
import { RecitationCorpus } from '../src/core/recitation/corpus.ts';
import { RecitationTracker, type Finding } from '../src/core/recitation/tracker.ts';
import { LocalAsrEngine } from '../src/browser/localAsrEngine.ts';
import { normWord } from '../src/core/recitation/normalize.ts';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] as string) : dflt;
};
const endpoint = arg('endpoint', 'http://127.0.0.1:8765');
const reciter = arg('reciter', 'Husary_64kbps');
const RATE = 16000;

const cache = new Map<string, Float32Array>();
function ayah(s: number, a: number): Float32Array {
  const key = `${String(s).padStart(3, '0')}${String(a).padStart(3, '0')}`;
  let pcm = cache.get(key);
  if (!pcm) {
    const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', `https://everyayah.com/data/${reciter}/${key}.mp3`, '-f', 'f32le', '-ac', '1', '-ar', String(RATE), '-'], { maxBuffer: 1 << 28 });
    pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
    cache.set(key, pcm);
  }
  return pcm;
}
const cut = (pcm: Float32Array, fromS: number, toS: number) => pcm.slice(Math.round(fromS * RATE), Math.round(toS * RATE));
const silence = (s: number) => new Float32Array(Math.round(s * RATE));
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** Word timestamps from the model, used only to build edited test audio (cut/replace a word). */
async function words(pcm: Float32Array) {
  return (await new LocalAsrEngine(endpoint).transcribe(pcm)).words ?? [];
}

const text = new QuranText(JSON.parse(readFileSync('public/data/quran-text.json', 'utf8')));
const corpus = new RecitationCorpus(text, new DivisionIndex(JSON.parse(readFileSync('public/data/divisions.json', 'utf8'))));

interface Expect {
  readonly end: string;
  /** Exact findings, or a predicate over them. */
  readonly kinds: readonly string[] | ((kinds: readonly string[]) => boolean);
  readonly page?: number;
}
const only = arg('only', '').split(',').filter(Boolean).map(Number);
let scenario = 0;
async function run(name: string, audio: Float32Array, expect: Expect): Promise<boolean> {
  scenario++;
  if (only.length && !only.includes(scenario)) return true;
  const tracker = new RecitationTracker(corpus);
  const real = new LocalAsrEngine(endpoint, 60000);
  const debug = process.env.DEBUG === '1';
  if (debug) {
    const push = tracker.push.bind(tracker);
    tracker.push = (ch) => {
      console.log(`        commit [${ch.words.map((w) => `${w.raw}@${Math.round(w.startMs ?? -1)}`).join(' ')}] sil=${ch.silenceBeforeMs}`);
      push(ch);
    };
  }
  const engine = { name: real.name, load: () => real.load(), transcribe: async (pcm: Float32Array) => {
    const r = await real.transcribe(pcm).catch((e: unknown) => {
      if (debug) console.log(`      engine error: ${String(e)}`);
      throw e;
    });
    if (debug) console.log(`      [${(pcm.length / RATE).toFixed(1)}s] ${r.text}`);
    return r;
  } };
  let last = '';
  const c = new RecitationController({ engine, tracker, onUpdate: (st) => {
    const now = `${st.tracker.mode}@${st.tracker.cursor} findings=${st.tracker.findings.length}`;
    if (debug && now !== last) console.log(`        -> ${now}`);
    last = now;
  } });
  if (!(await c.start())) throw new Error(c.state().error?.detail);
  const frame = Math.round(RATE * 0.085);
  for (let o = 0; o < audio.length; o += frame) {
    c.feed(audio.subarray(o, o + frame));
    await c.idle(); // behave like real time with a model faster than speech: no backlog
  }
  c.feed(silence(1));
  await c.stop();
  const s = c.state().tracker;
  const loc = s.location ? `${s.location.ref.surah}:${s.location.ref.ayah}#${s.location.position}` : 'none';
  const kinds = s.findings.map((f: Finding) => `${f.kind}@${f.ref.surah}:${f.ref.ayah}#${f.position}`);
  const kindsOk = typeof expect.kinds === 'function' ? expect.kinds(kinds) : JSON.stringify(kinds) === JSON.stringify(expect.kinds);
  const ok = loc === expect.end && kindsOk && (expect.page === undefined || s.location?.page === expect.page);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      at ${loc} page ${s.location?.page ?? '-'} | findings ${JSON.stringify(kinds)}${ok ? '' : `\n      expected ${expect.end} ${typeof expect.kinds === 'function' ? expect.kinds.toString() : JSON.stringify(expect.kinds)}${expect.page ? ` page ${expect.page}` : ''}`}`);
  return ok;
}

const gap = silence(0.6);
const mulk1 = ayah(67, 1);
const kahf10 = ayah(18, 10);
const w1 = await words(mulk1);
const k10 = await words(kahf10);
if (process.env.DEBUG === "1") console.log(JSON.stringify(w1));
/** Cut points are placed in the middle of the gap between two words (model timestamps are approximate). */
const before = (ws: typeof w1, i: number) => (i === 0 ? 0 : ((ws[i - 1]?.end as number) + (ws[i]?.start as number)) / 2);
const after = (ws: typeof w1, i: number) => (i + 1 >= ws.length ? Infinity : ((ws[i]?.end as number) + (ws[i + 1]?.start as number)) / 2);
const rest = (pcm: Float32Array, fromS: number) => cut(pcm, fromS, pcm.length / RATE);
/** Index of a word in the model output (recordings may start with the basmala or repeat words). */
const find = (ws: typeof w1, word: string, nth = 0) => {
  const hits = ws.flatMap((w, i) => (normWord(w.word) === normWord(word) ? [i] : []));
  const i = hits[nth];
  if (i === undefined) throw new Error(`word ${word} not found in ${ws.map((w) => w.word).join(' ')}`);
  return i;
};
/** Repetitions are not mistakes: compare only incorrect / skipped / hesitation findings. */
const mistakes = (expected: readonly string[]) => (k: readonly string[]) => JSON.stringify(k.filter((x) => !x.startsWith('repeated@'))) === JSON.stringify(expected);
const results = [
  await run('correct passage, located without selecting a surah (18:10–13)', join(kahf10, gap, ayah(18, 11), gap, ayah(18, 12), gap, ayah(18, 13)), { end: '18:14#1', kinds: mistakes([]) }),
  await run('across a mushaf page boundary (2:4–6, page 2 → 3)', join(ayah(2, 4), gap, ayah(2, 5), gap, ayah(2, 6)), { end: '2:7#1', kinds: mistakes([]), page: 3 }),
  await run('repeating an ayah is not a mistake (18:10, 11, 11, 12)', join(kahf10, gap, ayah(18, 11), gap, ayah(18, 11), gap, ayah(18, 12)), { end: '18:13#1', kinds: (k) => mistakes([])(k) && k.filter((x) => x.startsWith('repeated@18:11#')).length >= 3 }),
  await run('skipped word: 18:10 without «الفتية»', join(cut(kahf10, 0, before(k10, find(k10, 'الفتية'))), rest(kahf10, after(k10, find(k10, 'الفتية'))), gap, ayah(18, 11)), { end: '18:12#1', kinds: (k) => k.includes('skipped@18:10#3') && k.every((x) => x === 'skipped@18:10#3' || x.startsWith('repeated@') || x.startsWith('hesitation@')) }),
  await run('skipped ayah: 67:1 then 67:3', join(mulk1, gap, ayah(67, 3), gap, ayah(67, 4)), { end: '67:5#1', kinds: mistakes(Array.from({ length: text.ayah({ surah: 67, ayah: 2 }).tokens.filter((x) => x.position !== null).length }, (_, i) => `skipped@67:2#${i + 1}`)) }),
  await run('wrong word: «الكهف» replaced by «الملك» (from 67:1)', join(cut(kahf10, 0, before(k10, find(k10, 'الكهف'))), cut(mulk1, before(w1, find(w1, 'الملك')), after(w1, find(w1, 'الملك'))), rest(kahf10, after(k10, find(k10, 'الكهف'))), gap, ayah(18, 11)), { end: '18:12#1', kinds: (k) => k.includes('incorrect@18:10#5') && k.every((x) => x === 'incorrect@18:10#5' || x.startsWith('repeated@') || x.startsWith('hesitation@')) }),
  await run('long pause inside an ayah (67:1, 5 s before «وهو»)', join(cut(mulk1, 0, after(w1, find(w1, 'الملك'))), silence(5), rest(mulk1, after(w1, find(w1, 'الملك'))), gap, ayah(67, 2)), { end: '67:3#1', kinds: mistakes(['hesitation@67:1#5']) }),
];
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} of ${results.length} scenarios failed` : `All ${results.length} audio scenarios passed`);
process.exitCode = failed ? 1 : 0;
