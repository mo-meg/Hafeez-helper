import { DataFormatError } from './alquranCloud.ts';

/**
 * Parser for Tanzil's quran-data.js (https://tanzil.net/res/text/metadata/quran-data.js,
 * CC BY 3.0). Only the numeric division arrays are read; the file is never executed.
 * Note: Tanzil spells the quarter array "HizbQaurter".
 */
export function parseTanzilQuranDataJs(source: string): {
  juzStarts: Array<[number, number]>;
  quarterStarts: Array<[number, number]>;
  pageStarts: Array<[number, number]>;
} {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const read = (name: string): Array<[number, number]> => {
    const m = new RegExp(`QuranData\\.${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`).exec(withoutComments);
    if (!m) throw new DataFormatError(`quran-data.js: array QuranData.${name} not found`);
    const body = (m[1] ?? '').replace(/,\s*$/, '');
    let arr: unknown;
    try {
      arr = JSON.parse(`[${body}]`);
    } catch {
      throw new DataFormatError(`quran-data.js: QuranData.${name} is not a numeric array`);
    }
    if (!Array.isArray(arr)) throw new DataFormatError(`quran-data.js: QuranData.${name} malformed`);
    return arr
      .filter((x): x is [number, number] => Array.isArray(x) && x.length === 2 && x.every((n) => Number.isInteger(n)))
      .filter(([s]) => s >= 1 && s <= 114); // drops the leading [] and any end sentinel
  };
  return { juzStarts: read('Juz'), quarterStarts: read('HizbQaurter'), pageStarts: read('Page') };
}
