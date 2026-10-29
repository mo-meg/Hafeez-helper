import { VERIFIED_HIZB_STARTS, VERIFIED_JUZ_STARTS } from './anchors.ts';
import { EXPECTED_COUNTS, type DivisionDataset, type StartList } from './divisions.ts';
import { isValidRef, toIndex } from './refs.ts';

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: string[];
  readonly warnings: string[];
}

const fmt = (p: readonly [number, number] | undefined) => (p ? `${p[0]}:${p[1]}` : 'missing');

function checkList(
  name: string,
  list: StartList,
  expected: number,
  errors: string[],
  opts: { strict: boolean },
): number[] | null {
  if (list.length !== expected) {
    errors.push(`${name}: expected ${expected} entries, found ${list.length}`);
    return null;
  }
  const idx: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || p.length !== 2 || !isValidRef({ surah: p[0], ayah: p[1] })) {
      errors.push(`${name}[${i + 1}]: invalid reference ${JSON.stringify(p)}`);
      return null;
    }
    idx.push(toIndex({ surah: p[0], ayah: p[1] }));
  }
  if (idx[0] !== 1) errors.push(`${name}: first division must start at 1:1, found ${fmt(list[0])}`);
  for (let i = 1; i < idx.length; i++) {
    const prev = idx[i - 1] as number;
    const cur = idx[i] as number;
    if (opts.strict ? cur <= prev : cur < prev) {
      errors.push(`${name}[${i + 1}] (${fmt(list[i])}) is not after ${name}[${i}] (${fmt(list[i - 1])})`);
      return null;
    }
  }
  return idx;
}

/**
 * Validates a division dataset structurally and against the bundled verified anchors.
 * A dataset that fails is never used for navigation.
 */
export function validateDivisionDataset(ds: DivisionDataset): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (ds.schema !== 'hafeez-divisions/1') errors.push(`Unsupported schema ${String(ds.schema)}`);
  if (ds.numbering !== 'hafs-kufan') errors.push(`Unsupported ayah numbering ${String(ds.numbering)}`);

  const juz = checkList('juzStarts', ds.juzStarts, EXPECTED_COUNTS.juz, errors, { strict: true });
  if (juz) {
    VERIFIED_JUZ_STARTS.forEach((anchor, i) => {
      const got = ds.juzStarts[i];
      if (!got || got[0] !== anchor[0] || got[1] !== anchor[1]) {
        errors.push(`Juz ${i + 1} starts at ${fmt(got)} but the verified anchor is ${fmt(anchor)}`);
      }
    });
  }

  if (ds.quarterStarts) {
    const q = checkList('quarterStarts', ds.quarterStarts, EXPECTED_COUNTS.quarter, errors, { strict: true });
    if (q && juz) {
      for (let j = 0; j < 30; j++) {
        if (q[j * 8] !== juz[j]) {
          errors.push(`Quarter ${j * 8 + 1} (${fmt(ds.quarterStarts[j * 8])}) does not coincide with juz ${j + 1} start`);
        }
      }
    }
    if (q) {
      for (const [hizb, anchor] of VERIFIED_HIZB_STARTS) {
        const got = ds.quarterStarts[(hizb - 1) * 4];
        if (!got || got[0] !== anchor[0] || got[1] !== anchor[1]) {
          errors.push(`Hizb ${hizb} starts at ${fmt(got)} but the verified anchor is ${fmt(anchor)}`);
        }
      }
    }
    if (ds.eighthStarts) {
      const e = checkList('eighthStarts', ds.eighthStarts, EXPECTED_COUNTS.eighth, errors, { strict: true });
      if (e && q) {
        for (let i = 0; i < 240; i++) {
          if (e[i * 2] !== q[i]) {
            errors.push(
              `Eighth ${i * 2 + 1} (${fmt(ds.eighthStarts[i * 2])}) does not coincide with quarter ${i + 1} start (${fmt(ds.quarterStarts[i])}). ` +
                'The eighths dataset probably uses a different mushaf/numbering system.',
            );
            break;
          }
        }
      }
    }
  } else {
    if (ds.eighthStarts) errors.push('eighthStarts requires quarterStarts in the same dataset');
    warnings.push('No quarter (rub al-hizb) data: hizb, quarter and eighth navigation are unavailable.');
  }

  if (ds.pageStarts) {
    // Pages may begin inside a long ayah, so equal consecutive starts are allowed.
    checkList('pageStarts', ds.pageStarts, EXPECTED_COUNTS.page, errors, { strict: false });
  }
  return { ok: errors.length === 0, errors, warnings };
}
