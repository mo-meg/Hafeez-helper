// Real-data check of passage identification: plain (imla'i) spelling, as the model outputs it,
// against the canonical KFGQPC Uthmani text. Skipped when the dataset is not present.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DivisionIndex } from '../../src/core/quran/divisions.ts';
import { QuranText } from '../../src/core/quran/text.ts';
import { toHypWords } from '../../src/core/recitation/controller.ts';
import { RecitationCorpus } from '../../src/core/recitation/corpus.ts';
import { RecitationTracker } from '../../src/core/recitation/tracker.ts';

const TEXT = 'public/data/quran-text.json';
const DIV = 'public/data/divisions.json';
const have = existsSync(TEXT) && existsSync(DIV);

describe('recitation tracker on the real Quran text', { skip: !have && 'dataset missing' }, () => {
  const corpus = have ? new RecitationCorpus(new QuranText(JSON.parse(readFileSync(TEXT, 'utf8'))), new DivisionIndex(JSON.parse(readFileSync(DIV, 'utf8')))) : null;
  const locate = (phrase: string) => {
    const tr = new RecitationTracker(corpus as RecitationCorpus);
    tr.push({ words: toHypWords({ text: phrase }, 0), startMs: 0, endMs: 3000, silenceBeforeMs: 0 });
    return tr.snapshot();
  };

  it('identifies passages from plain spelling', () => {
    assert.deepEqual(locate('إذ أوى الفتية إلى الكهف فقالوا ربنا آتنا من لدنك رحمة').location?.ref, { surah: 18, ayah: 10 });
    const s = locate('الذين يؤمنون بالغيب ويقيمون الصلاة ومما رزقناهم ينفقون');
    assert.deepEqual(s.location?.ref, { surah: 2, ayah: 4 });
    assert.equal(s.location?.page, 2);
  });

  it('does not guess for a refrain that occurs many times', () => {
    assert.equal(locate('فبأي آلاء ربكما تكذبان').mode, 'searching');
    assert.deepEqual(locate('فبأي آلاء ربكما تكذبان يرسل عليكما شواظ من نار ونحاس').location?.ref, { surah: 55, ayah: 35 });
  });
});
