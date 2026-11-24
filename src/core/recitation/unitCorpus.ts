import type { DivisionIndex } from '../quran/divisions.ts';
import { fromIndex } from '../quran/refs.ts';
import { TOTAL_AYAT } from '../quran/surahs.ts';
import type { QuranText } from '../quran/text.ts';
import { RecitationCorpus } from './corpus.ts';
import { wordForms, type RecitationEngine } from './engine.ts';

/**
 * Builds the comparison corpus from the model's reference table: the canonical words stay the
 * same (display, positions, mistake snapshots), only their comparison form becomes the sound units
 * the model expects for that word. Reads all 6236 ayat once (after the engine has loaded).
 */
export async function buildUnitCorpus(text: QuranText, index: DivisionIndex | null, engine: RecitationEngine, batch = 128): Promise<RecitationCorpus> {
  const forms: (string[] | null)[] = [null];
  for (let i = 1; i <= TOTAL_AYAT; i += batch) {
    const ids = Array.from({ length: Math.min(batch, TOTAL_AYAT - i + 1) }, (_, k) => i + k);
    const res = await Promise.all(ids.map((id) => {
      const r = fromIndex(id);
      return engine.ayahUnits(r.surah, r.ayah).then((a) => wordForms(a, engine.separators));
    }));
    forms.push(...res);
  }
  return new RecitationCorpus(text, index, (i) => forms[i] ?? null);
}
