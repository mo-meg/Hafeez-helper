import type { DivisionDataset } from '../quran/divisions.ts';
import { validateDivisionDataset, type ValidationResult } from '../quran/divisionValidation.ts';
import { DataFormatError } from './alquranCloud.ts';

/**
 * Eighth (thumn) boundaries are not part of the Hafs/Madani metadata used by Tanzil and
 * AlQuran.cloud. Users who follow a mushaf with thumn marks can import a verified list.
 *
 * Accepted JSON shapes (480 entries, mushaf order, each the FIRST ayah of an eighth):
 *   { "label": "...", "source": { "name", "url", "license" }, "eighthStarts": [[2, 1], ...] }
 *   [[1, 1], [2, 1], ...]
 *   [{ "surah": 1, "ayah": 1 }, ...]
 *   [{ "start": { "surah": 1, "ayah": 1 } }, ...]
 * The list must use the same ayah numbering as the loaded quarters, and every odd eighth must
 * coincide with a quarter start; otherwise it is rejected (e.g. Warsh-numbered data on Hafs text).
 */
export function parseEighthsFile(json: unknown): { eighthStarts: Array<[number, number]>; label: string; source: DivisionDataset['source'] } {
  let list: unknown = json;
  let label = 'Imported eighths';
  let source: DivisionDataset['source'] = { name: 'User import', url: '', license: 'unknown — supplied by the user' };
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const o = json as Record<string, unknown>;
    list = o.eighthStarts ?? o.eighths;
    if (typeof o.label === 'string') label = o.label.slice(0, 120);
    const s = o.source as Record<string, unknown> | undefined;
    if (s && typeof s === 'object') {
      source = { name: String(s.name ?? source.name).slice(0, 200), url: String(s.url ?? '').slice(0, 500), license: String(s.license ?? source.license).slice(0, 200) };
    }
  }
  if (!Array.isArray(list)) throw new DataFormatError('Expected an array of eighth start references.');
  const starts = list.map((e, i): [number, number] => {
    let s: unknown;
    let a: unknown;
    if (Array.isArray(e)) [s, a] = e;
    else if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      const st = (o.start as Record<string, unknown> | undefined) ?? o;
      s = st.surah;
      a = st.ayah;
    }
    if (!Number.isInteger(s) || !Number.isInteger(a)) throw new DataFormatError(`Entry ${i + 1} is not a [surah, ayah] reference.`);
    return [s as number, a as number];
  });
  return { eighthStarts: starts, label, source };
}

export function withEighths(base: DivisionDataset, imported: ReturnType<typeof parseEighthsFile>): { dataset: DivisionDataset; validation: ValidationResult } {
  const dataset: DivisionDataset = {
    ...base,
    id: `${base.id}+eighths`,
    label: `${base.label} + ${imported.label}`,
    eighthStarts: imported.eighthStarts,
    eighthsSource: imported.source,
  };
  return { dataset, validation: validateDivisionDataset(dataset) };
}
