import type { MistakeCategory, RecallOutcome } from './model.ts';
import { MistakeService } from './mistakes/mistakeService.ts';
import type { Store } from './storage/store.ts';
import { FixedClock, type Clock, type IdGenerator } from './util/ids.ts';

/**
 * DEMO DATA — for trying the app only. Every record is flagged `demo: true`, shown with a
 * "Demo" badge, excluded from nothing silently, and removable in Settings. Demo mistakes are
 * ayah-level only (no word positions), so no Quran text is involved.
 */
const DEMO_MARKS: ReadonlyArray<{ surah: number; ayah: number; category: MistakeCategory; note: string; reviews: RecallOutcome[] }> = [
  { surah: 2, ayah: 255, category: 'hesitation', note: 'Demo: hesitated in the middle.', reviews: ['needed_prompt', 'correct_difficult', 'correct_easy'] },
  { surah: 2, ayah: 260, category: 'similar_ayah', note: 'Demo: confused with a similar opening.', reviews: ['mistake_again', 'correct_difficult'] },
  { surah: 2, ayah: 275, category: 'forgotten', note: 'Demo: forgot a word.', reviews: ['correct_easy', 'correct_easy'] },
  { surah: 2, ayah: 284, category: 'ayah_ending', note: 'Demo: wrong ending.', reviews: [] },
  { surah: 3, ayah: 7, category: 'incorrect_word', note: 'Demo: substituted a word.', reviews: ['needed_prompt'] },
  { surah: 3, ayah: 190, category: 'tajweed', note: 'Demo: madd length.', reviews: ['correct_easy'] },
  { surah: 18, ayah: 28, category: 'forgotten', note: 'Demo mistake outside Hizb 5.', reviews: ['mistake_again'] },
];

export async function seedDemoData(store: Store, clock: Clock, ids: IdGenerator): Promise<number> {
  const now = clock.now();
  const start = new FixedClock(new Date(now.getTime() - 6 * 86_400_000).toISOString());
  const svc = new MistakeService({ store, clock: start, ids });
  let count = 0;
  for (const d of DEMO_MARKS) {
    start.set(new Date(now.getTime() - 6 * 86_400_000).toISOString());
    const { mistake } = await svc.markAyah({ surah: d.surah, ayah: d.ayah }, { category: d.category, note: d.note, demo: true });
    count++;
    let day = 5;
    for (const outcome of d.reviews) {
      start.set(new Date(now.getTime() - day * 86_400_000).toISOString());
      await svc.recordAyahReview({ surah: d.surah, ayah: d.ayah }, outcome, { sessionId: `demo_session_${day}`, repetitions: 3, demo: true }, [mistake.id]);
      day -= 2;
    }
  }
  return count;
}

export async function removeDemoData(store: Store): Promise<number> {
  const demo = (await store.mistakes.getAll()).filter((m) => m.demo);
  const ids = new Set(demo.map((m) => m.id));
  for (const m of demo) await store.mistakes.delete(m.id);
  for (const r of await store.reviews.getAll()) if (r.demo || ids.has(r.mistakeId)) await store.reviews.delete(r.id);
  for (const e of await store.mistakeEvents.getAll()) if (e.demo || ids.has(e.mistakeId)) await store.mistakeEvents.delete(e.id);
  for (const s of await store.sessions.getAll()) if (s.demo) await store.sessions.delete(s.id);
  return demo.length;
}
