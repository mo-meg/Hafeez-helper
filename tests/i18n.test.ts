import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_PREFERENCES, normalizePreferences } from '../src/core/settings/preferences.ts';
import { DEFAULT_LOCALE, dir, fmtDateKey, getLocale, setLocale, t, tn } from '../src/ui/i18n/index.ts';
import { refLabel, scopeLabel, surahName } from '../src/ui/i18n/labels.ts';
import { ar } from '../src/ui/i18n/locales/ar.ts';
import { en } from '../src/ui/i18n/locales/en.ts';
import type { Message } from '../src/ui/i18n/types.ts';

const placeholders = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const forms = (m: Message): string[] => (typeof m === 'string' ? [m] : Object.values(m).filter((v): v is string => typeof v === 'string'));
const enEntries = Object.entries(en) as Array<[keyof typeof en, Message]>;

function withLocale<T>(l: 'ar' | 'en', fn: () => T): T {
  const prev = getLocale();
  setLocale(l);
  try {
    return fn();
  } finally {
    setLocale(prev);
  }
}

describe('interface translations', () => {
  it('Arabic provides exactly the English keys, none empty', () => {
    assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort());
    for (const [k, m] of Object.entries(ar)) for (const f of forms(m)) assert.ok(f.trim().length > 0, `empty Arabic text for ${k}`);
  });

  it('Arabic uses only placeholders that the English message defines', () => {
    for (const [k, m] of enEntries) {
      const allowed = new Set(forms(m).flatMap((f) => [...placeholders(f)]));
      if (typeof m !== 'string') allowed.add('count');
      for (const f of forms(ar[k])) for (const p of placeholders(f)) assert.ok(allowed.has(p), `${k}: unknown placeholder {${p}} in Arabic`);
      if (typeof m === 'string' && typeof ar[k] === 'string') {
        assert.deepEqual([...placeholders(ar[k] as string)].sort(), [...placeholders(m)].sort(), `${k}: placeholders differ`);
      }
    }
  });

  it('defaults to Arabic, right-to-left', () => {
    assert.equal(DEFAULT_LOCALE, 'ar');
    assert.equal(DEFAULT_PREFERENCES.language, 'ar');
    assert.equal(dir('ar'), 'rtl');
    assert.equal(dir('en'), 'ltr');
  });

  it('stored preferences keep the language; old or invalid values fall back to Arabic', () => {
    assert.equal(normalizePreferences({ ...DEFAULT_PREFERENCES, language: 'en' }).language, 'en');
    const { language: _omit, ...older } = DEFAULT_PREFERENCES;
    assert.equal(normalizePreferences(older).language, 'ar');
    assert.equal(normalizePreferences({ ...DEFAULT_PREFERENCES, language: 'fr' }).language, 'ar');
  });

  it('fills placeholders and chooses Arabic plural forms', () => {
    withLocale('en', () => {
      assert.equal(t('rev.todayTitle', { portion: 'Hizb 5' }), 'Today: Hizb 5');
      assert.equal(tn('mis.ayatCount', 1), '1 ayah');
      assert.equal(tn('mis.ayatCount', 3), '3 ayat');
    });
    withLocale('ar', () => {
      assert.equal(tn('mis.ayatCount', 1), 'آية واحدة');
      assert.equal(tn('mis.ayatCount', 2), 'آيتين');
      assert.equal(tn('mis.ayatCount', 5), '5 آيات');
      assert.equal(tn('mis.ayatCount', 11), '11 آية');
      assert.equal(tn('mis.ayatCount', 100), '100 آية');
    });
  });

  it('localizes references and portions without touching the surah table', () => {
    withLocale('en', () => {
      assert.equal(refLabel({ surah: 2, ayah: 255 }), 'Al-Baqarah 2:255');
      assert.equal(scopeLabel({ type: 'division', kind: 'hizb', number: 5 }), 'Hizb 5');
    });
    withLocale('ar', () => {
      assert.equal(surahName(2), 'البقرة');
      assert.equal(refLabel({ surah: 2, ayah: 255 }), 'البقرة 2:255');
      assert.equal(scopeLabel({ type: 'division', kind: 'hizb', number: 5 }), 'الحزب 5');
      assert.equal(scopeLabel({ type: 'all' }), 'القرآن كاملًا');
    });
  });

  it('formats calendar dates for the active locale', () => {
    const enDate = withLocale('en', () => fmtDateKey('2026-10-29', { month: 'long', day: 'numeric' }));
    const arDate = withLocale('ar', () => fmtDateKey('2026-10-29', { month: 'long', day: 'numeric' }));
    assert.match(enDate, /October/);
    assert.match(arDate, /أكتوبر|تشرين/);
  });

  it('never contains Quran-text markers (interface strings only)', () => {
    // Quranic annotation signs and the ayah-end mark (U+06D6–U+06ED, U+06DD) must not appear in UI catalogs.
    const quranMarks = /[\u06D6-\u06ED]/;
    for (const [k, m] of [...Object.entries(en), ...Object.entries(ar)]) for (const f of forms(m)) assert.ok(!quranMarks.test(f), `${k} contains Quranic marks`);
  });
});
