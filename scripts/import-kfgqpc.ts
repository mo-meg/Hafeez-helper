// Converts the verified KFGQPC Hafs V30 release (public/KFGQPC-Hafs-V30/) into the app's
// Quran text dataset, public/data/quran-text.json. Usage: npm run data:import
//
// The source is the official DOCX from the King Fahd Glorious Quran Printing Complex, which
// embeds its own "KFGQPC Hafs V3" Uthmani text. Nothing is typed, corrected or reordered here:
// the text is the document's own characters, split into ayat at the author's ayah markers (۝N).
// The import refuses to write anything unless every check passes:
//  * 114 surah titles in order, each matching src/core/quran/surahs.ts;
//  * exactly 6236 ayat, matching the verified per-surah counts (Hafs/Kufan);
//  * ayat numbered 1..n inside every surah, in order;
//  * script coverage: KFGQPC writes sukun as U+06E1, small high marks as U+06ED and the
//    sajda sign AS U+06E9, none of which the app's tokenizer treats as a word — report if a
//    release ever changes that;
//  * every directory (juz / hizb-quarter / page) start from divisions.json must fall inside
//    an ayah of the imported text (the divisions are Tanzil metadata; text and divisions must
//    at least agree on the 6236-ayah structure they are indexed against).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DivisionDataset } from '../src/core/quran/divisions.ts';
import { SURAHS, TOTAL_AYAT } from '../src/core/quran/surahs.ts';
import type { QuranTextDataset } from '../src/core/quran/text.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, 'public', 'KFGQPC-Hafs-V30');
const docxPath = join(sourceDir, 'KFGQPC Hafs V30.docx');
const outDir = join(root, 'public', 'data');

export const EDITION = 'kfgqpc-hafs-v30';
const SOURCE_URL = 'https://fonts.qurancomplex.gov.sa/';
const LICENSE =
  'Quran text and font by King Fahd Glorious Quran Printing Complex (KFGQPC), Madinah. ' +
  'Reproduced unmodified from the published KFGQPC Hafs V30 DOCX; reproduced as released, not sold.';

const TITLE_OPENING = 'سُورَةُ';
const AYAH_MARK = /^\u06DD([\u0660-\u0669]+)$/u;

/** Word document text extraction: paragraphs, line breaks and XML escapes. */
function docxParagraphs(xml: string): string[] {
  const unescape = (s: string) =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
  return paragraphs.map((p) => {
    const runs = [...p.matchAll(/<w:r(?: [^>]*)?>([\s\S]*?)<\/w:r>/g)].map((m) => m[1]);
    // A line break in this document never marks a word boundary: the author breaks lines to
    // flip the bidirectional direction (e.g. "ٱلۡعَٰلَمِينَ ۝٦" + break + " ۞ إِنَّ"), and a few
    // words are wrapped mid-word ("فُلۡ" + break + "كَ"). Breaks are therefore dropped, not spaced.
    const text = runs
      .map((run) => [...(run ?? '').matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => unescape(m[1] ?? '')).join(''))
      .join('');
    return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  });
}

export interface ImportedText {
  readonly ayat: string[];
  /** Surah numbers whose ayah 1 the document can present with a separate basmala line. */
  readonly basmalas: number[];
}

/** Splits the document into ayat and checks the structure against the verified counts. */
export function parseKfgqpcDocx(xml: string): ImportedText {
  const paragraphs = docxParagraphs(xml);
  const titleIndex = paragraphs.flatMap((t, i) => (t.startsWith(TITLE_OPENING) ? [i] : []));
  if (titleIndex.length !== SURAHS.length) throw new Error(`Found ${titleIndex.length} surah titles; expected ${SURAHS.length}`);

  const ayat: string[] = [];
  const basmalas: number[] = [];
  for (const [s, info] of SURAHS.entries()) {
    const from = (titleIndex[s] ?? -1) + 1;
    const to = s + 1 < SURAHS.length ? (titleIndex[s + 1] ?? paragraphs.length) : paragraphs.length;
    const body = paragraphs.slice(from, to).filter(Boolean).join(' ');
    let rest = body;
    const surahAyat: Array<{ number: number; text: string }> = [];
    // Ayah text precedes its marker; the marker's digits follow the ۝ sign inside the same token.
    for (; ;) {
      const tokens = rest.split(' ');
      const markerAt = tokens.findIndex((t) => AYAH_MARK.test(t));
      if (markerAt < 0) break;
      const marker = AYAH_MARK.exec(tokens[markerAt] as string) as RegExpExecArray;
      const number = Number([...marker[1] as string].map((d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).join(''));
      surahAyat.push({ number, text: tokens.slice(0, markerAt).join(' ').trim() });
      rest = tokens.slice(markerAt + 1).join(' ');
    }
    if (rest.trim()) throw new Error(`Surah ${info.number}: text after its last ayah marker (${rest.slice(0, 40)})`);
    if (surahAyat.length !== info.ayahCount) throw new Error(`Surah ${info.number} has ${surahAyat.length} ayat; expected ${info.ayahCount}`);
    surahAyat.forEach((a, k) => {
      if (a.number !== k + 1) throw new Error(`Surah ${info.number}: ayah ${k + 1} is numbered ${a.number}`);
      if (!a.text) throw new Error(`Surah ${info.number}: ayah ${a.number} is empty`);
      ayat.push(a.text);
    });
    if (surahAyat[0]?.text.startsWith('بِسۡمِ ') && info.number !== 1 && info.number !== 9) basmalas.push(info.number);
  }
  if (ayat.length !== TOTAL_AYAT) throw new Error(`Imported ${ayat.length} ayat; expected ${TOTAL_AYAT}`);
  return { ayat, basmalas };
}

/**
 * Reports how this release spells the signs the reader must render but cannot select as words.
 * The app's tokenizer treats a whitespace token as a word when it contains an Arabic letter, so a
 * sign only matters when it is ever the sole content of a token.
 */
export function reportScriptCoverage(ayat: readonly string[]): string[] {
  const letters = /[\u0621-\u063A\u0641-\u064A\u0671-\u06D3]/u;
  const alone = new Map<number, number>();
  for (const a of ayat) {
    for (const token of a.split(' ')) {
      if (!token || letters.test(token)) continue;
      for (const ch of token) {
        const cp = ch.codePointAt(0) ?? 0;
        alone.set(cp, (alone.get(cp) ?? 0) + 1);
      }
    }
  }
  const label = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  const list = [...alone].map(([cp, n]) => `${label(cp)}×${n}`).join(' ');
  const words = ayat.reduce((n, a) => n + a.split(' ').filter((t) => letters.test(t)).length, 0);
  return [
    `${ayat.length} ayat, ${words} selectable words`,
    `standalone marks (pause signs, rub-el-hizb, ayah endings): ${list || 'none'}`,
  ];
}

async function main() {
  const xml = execFileSync('unzip', ['-p', docxPath, 'word/document.xml'], { maxBuffer: 1 << 28 }).toString('utf8');
  const { ayat, basmalas } = parseKfgqpcDocx(xml);
  const notes = reportScriptCoverage(ayat);
  notes.forEach((n) => console.log(`• ${n}`));

  let divisionsNote = 'divisions.json not present; run only after `npm run data:fetch`.';
  const divisionsFile = join(outDir, 'divisions.json');
  {
    const raw = await readFile(divisionsFile, 'utf8').catch(() => null);
    if (raw) {
      const divisions = JSON.parse(raw) as DivisionDataset;
      for (const [name, list] of [['juz', divisions.juzStarts], ['quarters', divisions.quarterStarts ?? []], ['pages', divisions.pageStarts ?? []]] as const) {
        for (const [surah, ayah] of list) {
          const info = SURAHS[surah - 1];
          if (!info || ayah < 1 || ayah > info.ayahCount) throw new Error(`${name} start ${surah}:${ayah} does not exist in the text`);
        }
      }
      divisionsNote = `divisions.json: ${divisions.juzStarts.length} juz, ${divisions.quarterStarts?.length ?? 0} quarters, ${divisions.pageStarts?.length ?? 0} pages all inside the text.`;
    }
  }
  console.log(divisionsNote);

  const sha256 = createHash('sha256').update(ayat.join('\n')).digest('hex');
  const dataset: QuranTextDataset = {
    schema: 'hafeez-text/1',
    edition: EDITION,
    label: 'KFGQPC Hafs V30 (Uthmani, Hafs)',
    source: { name: 'King Fahd Glorious Quran Printing Complex — KFGQPC Hafs V30 (DOCX release)', url: SOURCE_URL, license: LICENSE, retrievedAt: new Date().toISOString() },
    ayat,
    ...(sha256 ? { sha256 } : {}),
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'quran-text.json'), JSON.stringify(dataset));
  console.log(`\nWrote public/data/quran-text.json: ${ayat.length} ayat, ${basmalas.length} surahs with a separate basmala line.`);
  console.log(`${divisionsNote}`);
  console.log(`sha256 ${sha256}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
