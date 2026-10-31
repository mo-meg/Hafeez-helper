/**
 * SYNTHETIC TEST FIXTURES — NOT QURAN TEXT, NOT REAL DIVISION BOUNDARIES.
 *
 * - Text: every "ayah" is made of placeholder Arabic words (letter names / the word "كلمة"
 *   meaning "word"), never Quranic text.
 * - Divisions: juz starts and hizb 1–11 starts are the real verified anchors (so validation
 *   passes); ALL OTHER quarter/eighth starts are interpolated placeholders. Tests must only
 *   assert real-world boundaries that follow from the verified anchors (e.g. Hizb 5 = 2:253–3:14).
 */
import { VERIFIED_HIZB_STARTS, VERIFIED_JUZ_STARTS } from '../../src/core/quran/anchors.ts';
import type { DivisionDataset } from '../../src/core/quran/divisions.ts';
import { fromIndex, toIndex } from '../../src/core/quran/refs.ts';
import { SURAHS, TOTAL_AYAT } from '../../src/core/quran/surahs.ts';
import type { QuranTextDataset } from '../../src/core/quran/text.ts';

const PLACEHOLDER_OPENING = ['ألف', 'باء', 'تاء', 'ثاء'];
const WORD = 'كلمة';
const PAUSE_MARK = 'ۖ'; // U+06D6, a pause sign (not a word)

function interpolate(known: Map<number, number>, total: number): number[] {
  const keys = [...known.keys()].sort((a, b) => a - b);
  const out: number[] = [];
  for (let q = 0; q < total; q++) {
    if (known.has(q)) {
      out.push(known.get(q) as number);
      continue;
    }
    const lo = [...keys].reverse().find((k) => k < q) as number;
    const hi = keys.find((k) => k > q);
    const loIdx = known.get(lo) as number;
    const hiIdx = hi === undefined ? TOTAL_AYAT + 1 : (known.get(hi) as number);
    const span = (hi ?? total) - lo;
    out.push(Math.round(loIdx + ((hiIdx - loIdx) * (q - lo)) / span));
  }
  return out;
}

export function syntheticDivisions(opts: { withEighths?: boolean; withPages?: boolean } = {}): DivisionDataset {
  const known = new Map<number, number>();
  VERIFIED_JUZ_STARTS.forEach(([s, a], j) => known.set(j * 8, toIndex({ surah: s, ayah: a })));
  for (const [h, [s, a]] of VERIFIED_HIZB_STARTS) known.set((h - 1) * 4, toIndex({ surah: s, ayah: a }));
  const quarters = interpolate(known, 240);
  const toPair = (i: number) => {
    const r = fromIndex(i);
    return [r.surah, r.ayah] as [number, number];
  };
  const eighths: number[] = [];
  quarters.forEach((q, i) => {
    const next = quarters[i + 1] ?? TOTAL_AYAT + 1;
    eighths.push(q, Math.floor((q + next) / 2));
  });
  return {
    schema: 'hafeez-divisions/1',
    id: 'synthetic-fixture',
    label: 'SYNTHETIC FIXTURE (not real boundaries except verified anchors)',
    numbering: 'hafs-kufan',
    source: { name: 'Synthetic test fixture', url: 'tests/fixtures/synthetic.ts', license: 'MIT' },
    synthetic: true,
    juzStarts: VERIFIED_JUZ_STARTS,
    quarterStarts: quarters.map(toPair),
    ...(opts.withEighths ? { eighthStarts: eighths.map(toPair) } : {}),
    // Evenly spread placeholder pages, consistent with the page numbers in syntheticText().
    ...(opts.withPages ? { pageStarts: syntheticPageStarts().map(toPair) } : {}),
  };
}

function syntheticPageStarts(): number[] {
  const starts: number[] = [];
  let last = 0;
  for (let g = 1; g <= TOTAL_AYAT; g++) {
    const p = Math.min(604, Math.ceil((g * 604) / TOTAL_AYAT));
    if (p !== last) starts.push(g);
    last = p;
  }
  return starts;
}

/** Synthetic "text": surah ≥ 2 (except 9) ayah 1 is prefixed with the placeholder opening, mimicking the source's basmala prefix. */
export function syntheticText(): QuranTextDataset {
  const ayat: string[] = [];
  for (const s of SURAHS) {
    for (let a = 1; a <= s.ayahCount; a++) {
      if (s.number === 1 && a === 1) {
        ayat.push(PLACEHOLDER_OPENING.join(' '));
        continue;
      }
      const n = 3 + ((s.number + a) % 5);
      const words = Array.from({ length: n }, () => WORD);
      if (a % 4 === 0) words.splice(2, 0, PAUSE_MARK);
      const body = words.join(' ');
      ayat.push(a === 1 && s.number !== 1 && s.number !== 9 ? `${PLACEHOLDER_OPENING.join(' ')} ${body}` : body);
    }
  }
  return {
    schema: 'hafeez-text/1',
    edition: 'synthetic-fixture',
    label: 'SYNTHETIC FIXTURE — NOT QURAN TEXT',
    source: { name: 'Synthetic test fixture', url: 'tests/fixtures/synthetic.ts', license: 'MIT' },
    synthetic: true,
    ayat,
  };
}

/** Builds a response shaped like AlQuran.cloud's /v1/quran/{edition} from synthetic data. */
export function syntheticAlQuranCloudResponse(): unknown {
  const div = syntheticDivisions();
  const text = syntheticText();
  const qStarts = (div.quarterStarts ?? []).map(([s, a]) => toIndex({ surah: s, ayah: a }));
  const jStarts = div.juzStarts.map(([s, a]) => toIndex({ surah: s, ayah: a }));
  const numberAt = (starts: number[], idx: number) => starts.filter((x) => x <= idx).length;
  let g = 0;
  return {
    code: 200,
    status: 'OK',
    data: {
      edition: { identifier: 'synthetic-edition', englishName: 'Synthetic' },
      surahs: SURAHS.map((s) => ({
        number: s.number,
        ayahs: Array.from({ length: s.ayahCount }, (_, i) => {
          g++;
          return {
            number: g,
            text: text.ayat[g - 1],
            numberInSurah: i + 1,
            juz: numberAt(jStarts, g),
            page: Math.min(604, Math.ceil((g * 604) / TOTAL_AYAT)),
            hizbQuarter: numberAt(qStarts, g),
          };
        }),
      })),
    },
  };
}
