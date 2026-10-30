import { z } from 'zod';
import type { DivisionDataset } from '../quran/divisions.ts';
import { SURAHS, TOTAL_AYAT } from '../quran/surahs.ts';
import { applyTanzilTextEncodingUpdates, type QuranTextDataset } from '../quran/text.ts';

/**
 * AlQuran.cloud (https://alquran.cloud/api) — free, no authentication, CORS-enabled.
 * The `quran-uthmani` edition is derived from Tanzil's Uthmani text (CC BY 3.0, verbatim).
 * Every ayah in the full-Quran response carries juz / page / hizbQuarter numbers, from which
 * division boundaries are derived (never by arithmetic).
 */
export const ALQURAN_CLOUD = {
  baseUrl: 'https://api.alquran.cloud/v1',
  /** Official mirror suggested by the maintainers for regions where the main host is blocked. */
  mirrorBaseUrl: 'https://alquran.api.islamic.network/v1',
  fullQuranPath: (edition: string) => `/quran/${encodeURIComponent(edition)}`,
  metaPath: '/meta',
  defaultEdition: 'quran-uthmani',
  license: 'Text: Tanzil Quran Text (CC BY 3.0, verbatim copies only, attribution to tanzil.net required).',
} as const;

/** Tanzil text styles in the Hafs narration, both with the standard 6236 ayat. */
export const QURAN_TEXT_EDITIONS = {
  uthmani: 'quran-uthmani',
  simple: 'quran-simple',
} as const;
export type QuranTextEdition = (typeof QURAN_TEXT_EDITIONS)[keyof typeof QURAN_TEXT_EDITIONS];

const AyahSchema = z.object({
  number: z.number().int(),
  text: z.string().min(1),
  numberInSurah: z.number().int(),
  juz: z.number().int().min(1).max(30),
  page: z.number().int().min(1),
  hizbQuarter: z.number().int().min(1).max(240),
});

const FullQuranSchema = z.object({
  code: z.literal(200),
  data: z.object({
    surahs: z
      .array(z.object({ number: z.number().int(), ayahs: z.array(AyahSchema) }))
      .length(114),
    edition: z.object({ identifier: z.string(), name: z.string().optional(), englishName: z.string().optional() }),
  }),
});

const RefsSchema = z.object({ count: z.number().int(), references: z.array(z.object({ surah: z.number().int(), ayah: z.number().int() })) });
const MetaSchema = z.object({
  code: z.literal(200),
  data: z.object({ juzs: RefsSchema, hizbQuarters: RefsSchema, pages: RefsSchema.optional() }),
});

export interface ParsedAlQuranCloud {
  readonly text: QuranTextDataset;
  readonly divisions: DivisionDataset;
}

export class DataFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataFormatError';
  }
}

/** Builds a start list from a per-ayah division number sequence. Rejects gaps that cannot be explained. */
function startsFromSequence(
  name: string,
  seq: ReadonlyArray<{ value: number; surah: number; ayah: number }>,
  opts: { allowSkips: boolean },
): Array<[number, number]> {
  const starts: Array<[number, number]> = [];
  let prev = 0;
  let prevRef: [number, number] | null = null;
  for (const item of seq) {
    if (item.value === prev) {
      prevRef = [item.surah, item.ayah];
      continue;
    }
    if (item.value < prev) throw new DataFormatError(`${name} decreases at ${item.surah}:${item.ayah}`);
    if (item.value !== prev + 1) {
      if (!opts.allowSkips || !prevRef) {
        throw new DataFormatError(`${name} jumps from ${prev} to ${item.value} at ${item.surah}:${item.ayah}`);
      }
      // A page that begins inside a long ayah: its first (partial) ayah is the previous ayah.
      for (let v = prev + 1; v < item.value; v++) starts.push([prevRef[0], prevRef[1]]);
    }
    starts.push([item.surah, item.ayah]);
    prev = item.value;
    prevRef = [item.surah, item.ayah];
  }
  return starts;
}

export function parseAlQuranCloudFullQuran(json: unknown, retrievedAt: string): ParsedAlQuranCloud {
  const parsed = FullQuranSchema.safeParse(json);
  if (!parsed.success) {
    throw new DataFormatError(`Unexpected AlQuran.cloud response: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const { surahs, edition } = parsed.data.data;
  const ayat: string[] = [];
  const juzSeq: Array<{ value: number; surah: number; ayah: number }> = [];
  const quarterSeq: typeof juzSeq = [];
  const pageSeq: typeof juzSeq = [];
  surahs.forEach((s, i) => {
    const expected = SURAHS[i];
    if (!expected || s.number !== expected.number) throw new DataFormatError(`Surah order mismatch at position ${i + 1}`);
    if (s.ayahs.length !== expected.ayahCount) {
      throw new DataFormatError(`Surah ${s.number} has ${s.ayahs.length} ayat in the source; expected ${expected.ayahCount}`);
    }
    s.ayahs.forEach((a, j) => {
      if (a.numberInSurah !== j + 1) throw new DataFormatError(`Ayah numbering mismatch in surah ${s.number} at ${j + 1}`);
      if (a.number !== ayat.length + 1) throw new DataFormatError(`Global ayah number mismatch at ${s.number}:${j + 1}`);
      ayat.push(applyTanzilTextEncodingUpdates(a.text));
      juzSeq.push({ value: a.juz, surah: s.number, ayah: a.numberInSurah });
      quarterSeq.push({ value: a.hizbQuarter, surah: s.number, ayah: a.numberInSurah });
      pageSeq.push({ value: a.page, surah: s.number, ayah: a.numberInSurah });
    });
  });
  if (ayat.length !== TOTAL_AYAT) throw new DataFormatError(`Source has ${ayat.length} ayat; expected ${TOTAL_AYAT}`);

  const source = {
    name: `AlQuran.cloud (${edition.identifier}, text by Tanzil.net)`,
    url: `${ALQURAN_CLOUD.baseUrl}${ALQURAN_CLOUD.fullQuranPath(edition.identifier)}`,
    license: ALQURAN_CLOUD.license,
    retrievedAt,
  };
  return {
    text: {
      schema: 'hafeez-text/1',
      edition: edition.identifier,
      label: edition.englishName ?? edition.identifier,
      source,
      ayat,
    },
    divisions: {
      schema: 'hafeez-divisions/1',
      id: `alquran-cloud:${edition.identifier}`,
      label: 'Madani mushaf divisions (Tanzil metadata via AlQuran.cloud)',
      numbering: 'hafs-kufan',
      source,
      juzStarts: startsFromSequence('juz', juzSeq, { allowSkips: false }),
      quarterStarts: startsFromSequence('hizbQuarter', quarterSeq, { allowSkips: false }),
      pageStarts: startsFromSequence('page', pageSeq, { allowSkips: true }),
    },
  };
}

/** Parses /v1/meta; used as an independent cross-check of the per-ayah derived boundaries. */
export function parseAlQuranCloudMeta(json: unknown): { juzStarts: Array<[number, number]>; quarterStarts: Array<[number, number]>; pageStarts?: Array<[number, number]> } {
  const parsed = MetaSchema.safeParse(json);
  if (!parsed.success) throw new DataFormatError('Unexpected AlQuran.cloud /meta response');
  const toList = (r: z.infer<typeof RefsSchema>) => r.references.map((x) => [x.surah, x.ayah] as [number, number]);
  const d = parsed.data.data;
  return { juzStarts: toList(d.juzs), quarterStarts: toList(d.hizbQuarters), ...(d.pages ? { pageStarts: toList(d.pages) } : {}) };
}

/** Lists the positions where two start lists disagree (for cross-source verification). */
export function diffStartLists(a: ReadonlyArray<readonly [number, number]>, b: ReadonlyArray<readonly [number, number]>): string[] {
  const out: string[] = [];
  if (a.length !== b.length) out.push(`length ${a.length} vs ${b.length}`);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as readonly [number, number];
    const y = b[i] as readonly [number, number];
    if (x[0] !== y[0] || x[1] !== y[1]) out.push(`#${i + 1}: ${x[0]}:${x[1]} vs ${y[0]}:${y[1]}`);
  }
  return out;
}
