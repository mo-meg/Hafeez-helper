import { toIndex } from '../quran/refs.ts';
import type { AyahRef } from '../quran/types.ts';

/**
 * Per-ayah audio sources. NOTHING is bundled: files are streamed from the configured host, or
 * from the local offline cache if the user explicitly downloaded them.
 *
 * Template placeholders: {surah} {ayah} {surah3} {ayah3} (zero-padded) {global} (1..6236).
 *
 * `verification` records what was confirmed during development (the build environment had no
 * direct network access): 'documented' = URL pattern/folder confirmed in public documentation or
 * projects using it; 'unverified' = believed correct but not confirmed — use "Test source".
 */
export interface ReciterSource {
  readonly id: string;
  readonly name: string;
  readonly nameArabic: string;
  readonly style: 'murattal' | 'mujawwad';
  readonly host: 'everyayah' | 'islamic-network' | 'custom';
  readonly urlTemplate: string;
  readonly verification: 'documented' | 'unverified' | 'user';
  readonly attribution: string;
}

const EVERYAYAH_ATTR =
  'Audio streamed from EveryAyah.com. Recordings belong to the reciters and their publishers; no open licence is stated, so files are streamed (not redistributed) and offline copies are for personal use only.';
const ISLAMIC_NETWORK_ATTR =
  'Audio streamed from the Islamic Network CDN used by AlQuran.cloud. Recordings belong to the reciters and their publishers; personal use only.';

const ea = (folder: string) => `https://everyayah.com/data/${folder}/{surah3}{ayah3}.mp3`;
const isn = (edition: string) => `https://cdn.islamic.network/quran/audio/128/${edition}/{global}.mp3`;

export const BUILTIN_RECITERS: readonly ReciterSource[] = [
  { id: 'husary-murattal-everyayah', name: 'Mahmoud Khalil Al-Husary (Murattal)', nameArabic: 'محمود خليل الحصري (مرتل)', style: 'murattal', host: 'everyayah', urlTemplate: ea('Husary_128kbps'), verification: 'documented', attribution: EVERYAYAH_ATTR },
  { id: 'husary-mujawwad-everyayah', name: 'Mahmoud Khalil Al-Husary (Mujawwad)', nameArabic: 'محمود خليل الحصري (مجود)', style: 'mujawwad', host: 'everyayah', urlTemplate: ea('Husary_128kbps_Mujawwad'), verification: 'documented', attribution: EVERYAYAH_ATTR },
  { id: 'husary-islamic-network', name: 'Mahmoud Khalil Al-Husary (Islamic Network CDN)', nameArabic: 'محمود خليل الحصري', style: 'murattal', host: 'islamic-network', urlTemplate: isn('ar.husary'), verification: 'unverified', attribution: ISLAMIC_NETWORK_ATTR },
  { id: 'hudhaify-everyayah', name: 'Ali Al-Hudhaify', nameArabic: 'علي الحذيفي', style: 'murattal', host: 'everyayah', urlTemplate: ea('Hudhaify_128kbps'), verification: 'documented', attribution: EVERYAYAH_ATTR },
  { id: 'ayyoub-everyayah', name: 'Muhammad Ayyoub', nameArabic: 'محمد أيوب', style: 'murattal', host: 'everyayah', urlTemplate: ea('Muhammad_Ayyoub_128kbps'), verification: 'documented', attribution: EVERYAYAH_ATTR },
  { id: 'minshawy-murattal-everyayah', name: 'Mohamed Siddiq Al-Minshawi (Murattal)', nameArabic: 'محمد صديق المنشاوي (مرتل)', style: 'murattal', host: 'everyayah', urlTemplate: ea('Minshawy_Murattal_128kbps'), verification: 'unverified', attribution: EVERYAYAH_ATTR },
  { id: 'abdulbasit-murattal-everyayah', name: 'Abdul Basit Abdus Samad (Murattal)', nameArabic: 'عبد الباسط عبد الصمد (مرتل)', style: 'murattal', host: 'everyayah', urlTemplate: ea('Abdul_Basit_Murattal_192kbps'), verification: 'unverified', attribution: EVERYAYAH_ATTR },
  { id: 'alafasy-everyayah', name: 'Mishary Rashid Alafasy', nameArabic: 'مشاري راشد العفاسي', style: 'murattal', host: 'everyayah', urlTemplate: ea('Alafasy_128kbps'), verification: 'unverified', attribution: EVERYAYAH_ATTR },
];

export const DEFAULT_RECITER_ID = 'husary-murattal-everyayah';

/**
 * Isti'adha recordings. EveryAyah serves a general file at /data/audhubillah.mp3 and some reciter
 * folders contain their own audhubillah.mp3 (not all). Best first: the reciter's own folder, then
 * the general file. Other hosts only get the general file (a different voice).
 */
export const ISTIADHA_GENERAL_URL = 'https://everyayah.com/data/audhubillah.mp3';

export function istiadhaUrls(template: string): string[] {
  const m = /^(https?:\/\/(?:www\.)?everyayah\.com\/data\/[^/]+\/)\{surah3\}\{ayah3\}\.mp3$/.exec(template);
  return m ? [`${m[1]}audhubillah.mp3`, ISTIADHA_GENERAL_URL] : [ISTIADHA_GENERAL_URL];
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

const PLACEHOLDER = /\{(surah3|ayah3|surah|ayah|global)\}/g;

export function validateTemplate(template: string): void {
  let url: URL;
  try {
    url = new URL(template.replace(PLACEHOLDER, '1'));
  } catch {
    throw new TemplateError('The URL template is not a valid absolute URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TemplateError('Only http(s) audio URLs are supported.');
  const ids: string[] = [...(template.match(PLACEHOLDER) ?? [])];
  const hasGlobal = ids.includes('{global}');
  const hasSurah = ids.some((p) => p.startsWith('{surah'));
  const hasAyah = ids.some((p) => p.startsWith('{ayah'));
  if (!hasGlobal && !(hasSurah && hasAyah)) {
    throw new TemplateError('The template must identify the ayah: use {global}, or both a surah and an ayah placeholder.');
  }
}

export function resolveAudioUrl(template: string, ref: AyahRef): string {
  const pad = (n: number) => String(n).padStart(3, '0');
  return template.replace(PLACEHOLDER, (_, key: string) => {
    switch (key) {
      case 'surah3':
        return pad(ref.surah);
      case 'ayah3':
        return pad(ref.ayah);
      case 'surah':
        return String(ref.surah);
      case 'ayah':
        return String(ref.ayah);
      default:
        return String(toIndex(ref));
    }
  });
}

export function findReciter(id: string, custom: readonly ReciterSource[] = []): ReciterSource | undefined {
  return [...BUILTIN_RECITERS, ...custom].find((r) => r.id === id);
}
