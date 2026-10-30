import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EDITION, parseKfgqpcDocx, reportScriptCoverage } from '../scripts/import-kfgqpc.ts';
import { SURAHS, TOTAL_AYAT } from '../src/core/quran/surahs.ts';

/**
 * Unit tests use a synthetic WordprocessingML document (placeholder words, not Quran text); the
 * REAL release in public/KFGQPC-Hafs-V30/ is checked in tests/data/realdata.datatest.ts.
 */
const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const brk = '<w:r><w:br/></w:r>';
const p = (xml: string) => `<w:p>${xml}</w:p>`;
const arabic = (n: number) => [...String(n)].map((d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]).join('');

/** A document shaped like the release: surah titles, an optional basmala line, then ۝N-marked ayat. */
function fixture(opts: { withBasmala?: boolean; swapMarkers?: boolean; dropAyah?: boolean; extraText?: boolean } = {}): string {
  const parts: string[] = [];
  for (const s of SURAHS) {
    parts.push(p(run(`سُورَةُ ${s.nameArabic}`)));
    if (opts.withBasmala && s.number !== 1 && s.number !== 9) parts.push(p(run('بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ')));
    const count = opts.dropAyah && s.number === 2 ? s.ayahCount - 1 : s.ayahCount;
    for (let a = 1; a <= count; a++) {
      const n = opts.swapMarkers && s.number === 3 ? (a === 1 ? 2 : a === 2 ? 1 : a) : a;
      // Every second ayah is split by a line break, as the release does to switch direction.
      parts.push(a % 2 === 0 ? p(`${run('كلمة كلمة')}${brk}${run(` كلمة ۝${arabic(n)}`)}`) : p(run(`كلمة ۝${arabic(n)}`)));
    }
  }
  if (opts.extraText) parts.push(p(run('كلمة')));
  return `<w:document><w:body>${parts.join('')}</w:body></w:document>`;
}

describe('KFGQPC DOCX importer (synthetic document)', () => {
  it('splits ayat at the markers and drops line breaks without joining words', () => {
    const { ayat } = parseKfgqpcDocx(fixture());
    assert.equal(ayat.length, TOTAL_AYAT);
    assert.equal(ayat[0], 'كلمة');
    assert.equal(ayat[1], 'كلمة كلمة كلمة', 'a line break is not a word boundary');
  });
  it('recognises the basmala line and reports it as a separate basmala', () => {
    const { basmalas } = parseKfgqpcDocx(fixture({ withBasmala: true }));
    assert.deepEqual(basmalas, SURAHS.filter((s) => s.number !== 1 && s.number !== 9).map((s) => s.number));
  });
  it('rejects a missing ayah, out-of-order numbering, or text after the last marker', () => {
    assert.throws(() => parseKfgqpcDocx(fixture({ dropAyah: true })), /Surah 2 has 285 ayat; expected 286/);
    assert.throws(() => parseKfgqpcDocx(fixture({ swapMarkers: true })), /Surah 3: ayah 1 is numbered 2/);
    assert.throws(() => parseKfgqpcDocx(fixture({ extraText: true })), /text after its last ayah marker/);
  });
  it('names the edition after the release it was imported from', () => {
    assert.equal(EDITION, 'kfgqpc-hafs-v30');
  });
  it('reports the marks that stand alone so a new release is noticed', () => {
    const notes = reportScriptCoverage(['كلمة ۝١', 'كلمة ۞', 'كلمة']);
    assert.match(notes[0] ?? '', /^3 ayat, 3 selectable words$/);
    assert.match(notes[1] ?? '', /U\+0661×1 U\+06DE×1/);
  });
});
