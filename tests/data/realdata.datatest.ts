/**
 * Checks against the REAL downloaded dataset (public/data/*.json produced by `npm run data:fetch`).
 * Run with `npm run test:data`. Skipped when the data has not been downloaded.
 * Expected values come from independent sources cited in src/core/quran/anchors.ts, plus
 * AlQuran.cloud's documented sample for 2:255 (hizbQuarter 17, page 42, juz 3).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DivisionIndex, type DivisionDataset } from '../../src/core/quran/divisions.ts';
import { validateDivisionDataset } from '../../src/core/quran/divisionValidation.ts';
import { QuranText, type QuranTextDataset } from '../../src/core/quran/text.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'data');
const textFile = join(dir, 'quran-text.json');
const divFile = join(dir, 'divisions.json');
const available = existsSync(textFile) && existsSync(divFile);

describe('real Quran dataset (public/data)', { skip: available ? false : 'run `npm run data:fetch` first' }, () => {
  const text = available ? (JSON.parse(readFileSync(textFile, 'utf8')) as QuranTextDataset) : null;
  const div = available ? (JSON.parse(readFileSync(divFile, 'utf8')) as DivisionDataset) : null;

  it('has 6236 non-empty ayat and a matching checksum', () => {
    assert.ok(text);
    assert.equal(text.ayat.length, 6236);
    assert.ok(text.ayat.every((a) => a.trim().length > 0));
    assert.equal(createHash('sha256').update(text.ayat.join('\n')).digest('hex'), text.sha256);
  });

  it('division data passes verification against all anchors', () => {
    assert.ok(div);
    assert.deepEqual(validateDivisionDataset(div).errors, []);
  });

  it('Hizb 5 is 2:253 – 3:14 and 2:255 is in quarter 17, page 42', () => {
    assert.ok(div);
    const idx = new DivisionIndex(div);
    assert.deepEqual(idx.range('hizb', 5).start, { surah: 2, ayah: 253 });
    assert.deepEqual(idx.range('hizb', 5).end, { surah: 3, ayah: 14 });
    const loc = idx.locate({ surah: 2, ayah: 255 });
    assert.equal(loc.quarter, 17);
    assert.equal(loc.juz, 3);
    assert.equal(loc.page, 42);
  });

  it('every ayah tokenizes into at least one selectable word', () => {
    assert.ok(text);
    const q = new QuranText(text);
    for (let i = 1; i <= 6236; i++) assert.ok(q.ayahAt(i).tokens.some((t) => t.position !== null), `ayah #${i}`);
  });

  it('detects the source basmala prefix on 2:1 but not on 9:1', () => {
    assert.ok(text);
    const q = new QuranText(text);
    assert.notEqual(q.ayah({ surah: 2, ayah: 1 }).basmalaPrefix, null);
    assert.equal(q.ayah({ surah: 9, ayah: 1 }).basmalaPrefix, null);
  });
});
