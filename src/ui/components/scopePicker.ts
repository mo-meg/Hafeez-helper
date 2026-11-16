import type { DivisionIndex } from '../../core/quran/divisions.ts';
import { parseRef } from '../../core/quran/refs.ts';
import { divisionRangeScope, divisionSpan, type RevisionScope } from '../../core/quran/scope.ts';
import { SURAHS } from '../../core/quran/surahs.ts';
import type { DivisionKind } from '../../core/quran/types.ts';
import { h } from '../dom.ts';
import { t } from '../i18n/index.ts';
import { kindName, surahName } from '../i18n/labels.ts';

type PickerKind = DivisionKind | 'surahs' | 'range' | 'all';

const label = (k: PickerKind): string => t(`kindLong.${k}`);

export interface ScopePicker {
  readonly el: HTMLElement;
  /** Returns the chosen scope, or an error message. */
  read(): { scope: RevisionScope } | { error: string };
  /** Shows a scope (e.g. to copy one day's portion to another). */
  set(scope: RevisionScope | null): void;
}

export function scopePicker(index: DivisionIndex, initialScope: RevisionScope | null, opts: { idPrefix: string; allowAll?: boolean }): ScopePicker {
  // A range that covers whole divisions (Hizb 2 to 3) is edited as that division span.
  const span = initialScope ? divisionSpan(initialScope, index) : null;
  const initial: RevisionScope | null = span ? { type: 'division', kind: span.kind, number: span.from } : initialScope;
  const kinds: PickerKind[] = ['hizb', 'quarter', 'juz', 'page', 'surahs', 'range', ...(opts.allowAll ? (['all'] as const) : [])];
  const available = (k: PickerKind) => (k === 'surahs' || k === 'range' || k === 'all' ? true : index.has(k));
  let kind: PickerKind = initial ? (initial.type === 'division' ? initial.kind : initial.type) : index.has('hizb') ? 'hizb' : 'juz';
  if (!available(kind)) kind = 'juz';

  const kindSel = h(
    'select',
    { id: `${opts.idPrefix}-kind`, onchange: () => { kind = kindSel.value as PickerKind; sync(); } },
    kinds.map((k) => h('option', { value: k, selected: k === kind, disabled: !available(k) }, available(k) ? label(k) : t('common.dataNotLoaded', { label: label(k) }))),
  );
  const num = h('input', { id: `${opts.idPrefix}-num`, type: 'number', min: '1', inputmode: 'numeric', value: initial?.type === 'division' ? String(initial.number) : '1' });
  const numTo = h('input', { id: `${opts.idPrefix}-num-to`, type: 'number', min: '1', inputmode: 'numeric', placeholder: t('picker.toOptional'), value: span ? String(span.to) : '' });
  const surahSel = h(
    'select',
    { id: `${opts.idPrefix}-surahs`, multiple: true, size: 5 },
    SURAHS.map((s) => h('option', { value: String(s.number), selected: initial?.type === 'surahs' && initial.surahs.includes(s.number) }, `${s.number}. ${surahName(s.number)}`)),
  );
  const from = h('input', { id: `${opts.idPrefix}-from`, class: 'ltr', dir: 'ltr', inputmode: 'numeric', placeholder: t('common.refPlaceholder', { ref: '2:253' }), value: initial?.type === 'range' ? `${initial.start.surah}:${initial.start.ayah}` : '' });
  const to = h('input', { id: `${opts.idPrefix}-to`, class: 'ltr', dir: 'ltr', inputmode: 'numeric', placeholder: t('common.refPlaceholder', { ref: '3:14' }), value: initial?.type === 'range' ? `${initial.end.surah}:${initial.end.ayah}` : '' });

  const numField = h('div', { class: 'row', style: { 'align-items': 'flex-end' } }, h('label', { class: 'field' }, h('span', null, t('common.number')), num), h('label', { class: 'field' }, h('span', null, t('picker.toNumber')), numTo));
  const surahField = h('label', { class: 'field' }, h('span', null, t('picker.surahsHelp')), surahSel);
  const rangeFields = h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', null, t('common.from')), from), h('label', { class: 'field' }, h('span', null, t('common.to')), to));

  function sync() {
    const isDiv = kind !== 'surahs' && kind !== 'range' && kind !== 'all';
    numField.hidden = !isDiv;
    surahField.hidden = kind !== 'surahs';
    rangeFields.hidden = kind !== 'range';
    if (isDiv) num.max = numTo.max = String(index.count(kind as DivisionKind) || 1);
  }
  sync();

  function set(scope: RevisionScope | null) {
    if (!scope) return;
    const sp = divisionSpan(scope, index);
    const sc: RevisionScope = sp ? { type: 'division', kind: sp.kind, number: sp.from } : scope;
    kind = sc.type === 'division' ? sc.kind : sc.type;
    if (!available(kind) || !kinds.includes(kind)) return;
    kindSel.value = kind;
    num.value = sc.type === 'division' ? String(sc.number) : '1';
    numTo.value = sp ? String(sp.to) : '';
    for (const o of surahSel.options) o.selected = sc.type === 'surahs' && sc.surahs.includes(Number(o.value));
    from.value = sc.type === 'range' ? `${sc.start.surah}:${sc.start.ayah}` : '';
    to.value = sc.type === 'range' ? `${sc.end.surah}:${sc.end.ayah}` : '';
    sync();
  }

  return {
    set,
    el: h('div', { class: 'row', style: { 'align-items': 'flex-end' } }, h('label', { class: 'field' }, h('span', null, t('picker.kind')), kindSel), numField, surahField, rangeFields),
    read() {
      if (kind === 'all') return { scope: { type: 'all' } };
      if (kind === 'surahs') {
        const surahs = [...surahSel.selectedOptions].map((o) => Number(o.value));
        return surahs.length ? { scope: { type: 'surahs', surahs } } : { error: t('picker.selectSurah') };
      }
      if (kind === 'range') {
        const a = parseRef(from.value);
        const b = parseRef(to.value);
        if (!a || !b) return { error: t('picker.rangeError') };
        return { scope: { type: 'range', start: a, end: b } };
      }
      const n = Number(num.value);
      const max = index.count(kind);
      if (!Number.isInteger(n) || n < 1 || n > max) return { error: t('error.divisionOutOfRange', { kind: kindName(kind), max }) };
      if (numTo.value.trim() === '') return { scope: { type: 'division', kind, number: n } };
      const m = Number(numTo.value);
      if (!Number.isInteger(m) || m < n || m > max) return { error: t('picker.toError', { kind: kindName(kind), from: n, max }) };
      return { scope: divisionRangeScope(kind, n, m, index) };
    },
  };
}
