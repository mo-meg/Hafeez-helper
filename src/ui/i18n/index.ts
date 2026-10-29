/**
 * Interface localization (Arabic and English).
 *
 * Only interface strings live here. Quran text is never passed through this module: it is
 * rendered verbatim from the verified dataset, in every language.
 */
import { ar } from './locales/ar.ts';
import { en, type MessageKey } from './locales/en.ts';
import type { Message, PluralMessage } from './types.ts';

export type { MessageKey } from './locales/en.ts';
export type Locale = 'ar' | 'en';
export const LOCALES: readonly Locale[] = ['ar', 'en'];
export const DEFAULT_LOCALE: Locale = 'ar';

const CATALOGS: Record<Locale, Record<MessageKey, Message>> = { en, ar };

let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<(l: Locale) => void>();

export function isLocale(v: unknown): v is Locale {
  return v === 'ar' || v === 'en';
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  for (const l of listeners) l(locale);
}

export function onLocaleChange(fn: (l: Locale) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function dir(locale: Locale = current): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

/** BCP 47 tag used for Intl formatting (CLDR defaults decide the digit shapes). */
export function intlTag(locale: Locale = current): string {
  return locale === 'ar' ? 'ar' : 'en';
}

export type Params = Record<string, string | number>;

function interpolate(template: string, params: Params | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params[name];
    if (v === undefined) return m;
    return typeof v === 'number' ? fmtNum(v) : v;
  });
}

function lookup(key: MessageKey, locale: Locale): Message {
  return CATALOGS[locale][key] ?? en[key];
}

/** Translates an interface string. `{name}` placeholders are filled from `params`. */
export function t(key: MessageKey, params?: Params): string {
  const m = lookup(key, current);
  if (typeof m === 'string') return interpolate(m, params);
  return interpolate(m.other, params);
}

/** Translates a plural-aware string; `{count}` is filled with the locale-formatted count. */
export function tn(key: MessageKey, count: number, params?: Params): string {
  const m = lookup(key, current);
  const all = { ...params, count };
  if (typeof m === 'string') return interpolate(m, all);
  return interpolate(selectPlural(m, count, current), all);
}

export function selectPlural(m: PluralMessage, count: number, locale: Locale): string {
  // Arabic uses a distinct form for exactly zero; Intl only reports it when the rules say so.
  const cat = new Intl.PluralRules(intlTag(locale)).select(count) as keyof PluralMessage;
  return m[cat] ?? m.other;
}

// ------------------------------------------------------------------ formatting

export function fmtNum(n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlTag(), opts).format(n);
}

export function fmtDate(iso: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(intlTag(), opts);
}

/** Formats a local calendar key (YYYY-MM-DD) without timezone drift. */
export function fmtDateKey(key: string, opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  return new Date(y, m - 1, d).toLocaleDateString(intlTag(), opts);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(intlTag(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtRelativeDays(iso: string | null, now: Date): string {
  if (!iso) return t('time.never');
  const days = Math.round((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  return new Intl.RelativeTimeFormat(intlTag(), { numeric: 'auto' }).format(-days, 'day');
}

export function fmtDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return t('time.underMinute');
  if (totalMin < 60) return tn('time.aboutMinutes', totalMin);
  return t('time.aboutHours', { h: Math.floor(totalMin / 60), m: totalMin % 60 });
}

/** Joins items with the locale's list conventions ("a, b and c" / "أ، ب و ج"). */
export function fmtList(items: readonly string[], type: 'conjunction' | 'unit' = 'unit'): string {
  return new Intl.ListFormat(intlTag(), { style: 'long', type }).format(items);
}

/** "2 minutes ago" / "منذ دقيقتين", choosing minutes, hours or days. */
export function fmtRelativeTime(iso: string, now: Date): string {
  const rtf = new Intl.RelativeTimeFormat(intlTag(), { numeric: 'auto' });
  const min = Math.round((new Date(iso).getTime() - now.getTime()) / 60_000);
  if (Math.abs(min) < 60) return rtf.format(min, 'minute');
  const hours = Math.round(min / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}
