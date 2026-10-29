import { z } from 'zod';
import { DEFAULT_RECITER_ID } from '../audio/reciters.ts';
import { MISTAKE_CATEGORIES, type RepeatConfig } from '../model.ts';
import { REPEAT_LIMITS } from '../playlist/sequence.ts';

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const RepeatConfigSchema = z.object({
  ayahRepeat: int(1, REPEAT_LIMITS.maxRepeat),
  groupRepeat: int(1, REPEAT_LIMITS.maxRepeat),
  playlistRepeat: int(1, REPEAT_LIMITS.maxRepeat),
  repeatContext: z.boolean(),
  pauseBetweenRepetitionsMs: z.number().min(0).max(REPEAT_LIMITS.maxPauseMs),
  pauseBetweenAyatMs: z.number().min(0).max(REPEAT_LIMITS.maxPauseMs),
  playbackRate: z.number().min(REPEAT_LIMITS.minRate).max(REPEAT_LIMITS.maxRate),
});

export const CustomReciterSchema = z.object({
  id: z.string().regex(/^custom-[a-z0-9-]+$/),
  name: z.string().min(1).max(80),
  nameArabic: z.string().max(80),
  style: z.enum(['murattal', 'mujawwad']),
  host: z.literal('custom'),
  urlTemplate: z.string().min(8).max(500),
  verification: z.literal('user'),
  attribution: z.string().max(400),
});

export const PreferencesSchema = z.object({
  version: z.literal(1),
  reciterId: z.string(),
  customReciters: z.array(CustomReciterSchema),
  repeat: RepeatConfigSchema,
  /** Plays per ayah when listening to a complete portion. */
  portionAyahRepeat: int(1, REPEAT_LIMITS.maxRepeat),
  contextBefore: int(0, 5),
  contextAfter: int(0, 5),
  contextAcrossSurahs: z.boolean(),
  wordPractice: z.enum(['grouped', 'per_word']),
  categories: z.array(z.enum(MISTAKE_CATEGORIES)),
  pauseForAssessment: z.boolean(),
  theme: z.enum(['system', 'light', 'dark']),
  fontScale: z.number().min(0.8).max(2.5),
  reminder: z.object({ enabled: z.boolean(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

export const DEFAULT_REPEAT: RepeatConfig = {
  ayahRepeat: 3,
  groupRepeat: 1,
  playlistRepeat: 1,
  repeatContext: false,
  pauseBetweenRepetitionsMs: 1500,
  pauseBetweenAyatMs: 2500,
  playbackRate: 1,
};

export const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  reciterId: DEFAULT_RECITER_ID,
  customReciters: [],
  repeat: DEFAULT_REPEAT,
  portionAyahRepeat: 1,
  contextBefore: 0,
  contextAfter: 0,
  contextAcrossSurahs: false,
  wordPractice: 'grouped',
  categories: [],
  pauseForAssessment: true,
  theme: 'system',
  fontScale: 1.2,
  reminder: { enabled: false, time: '07:00' },
};

/** Merges stored (possibly older/partial) preferences onto defaults; invalid fields fall back. */
export function normalizePreferences(raw: unknown): Preferences {
  if (!raw || typeof raw !== 'object') return DEFAULT_PREFERENCES;
  const r = raw as Record<string, unknown>;
  const merged = {
    ...DEFAULT_PREFERENCES,
    ...r,
    version: 1,
    repeat: { ...DEFAULT_PREFERENCES.repeat, ...((r.repeat as object) ?? {}) },
    reminder: { ...DEFAULT_PREFERENCES.reminder, ...((r.reminder as object) ?? {}) },
  };
  const parsed = PreferencesSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  // Drop only the invalid top-level keys.
  const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
  const repaired: Record<string, unknown> = { ...merged };
  for (const k of bad) repaired[k] = (DEFAULT_PREFERENCES as Record<string, unknown>)[k];
  const second = PreferencesSchema.safeParse(repaired);
  return second.success ? second.data : DEFAULT_PREFERENCES;
}
