import type { DivisionIndex } from '../../core/quran/divisions.ts';
import { parseRef } from '../../core/quran/refs.ts';
import type { RevisionScope } from '../../core/quran/scope.ts';
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
}

export function scopePicker(index: DivisionIndex, initial: RevisionScope | null, opts: { idPrefix: string; allowAll?: boolean }): ScopePicker {
  const kinds: PickerKind[] = ['hizb', 'quarter', 'eighth', 'juz', 'page', 'surahs', 'range', ...(opts.allowAll ? (['all'] as const) : [])];
  const available = (k: PickerKind) => (k === 'surahs' || k === 'range' || k === 'all' ? true : index.has(k));
  let kind: PickerKind = initial ? (initial.type === 'division' ? initial.kind : initial.type) : index.has('hizb') ? 'hizb' : 'juz';
  if (!available(kind)) kind = 'juz';

  const kindSel = h(
    'select',
    { id: `${opts.idPrefix}-kind`, onchange: () => { kind = kindSel.value as PickerKind; sync(); } },
    kinds.map((k) => h('option', { value: k, selected: k === kind, disabled: !available(k) }, available(k) ? label(k) : t('common.dataNotLoaded', { label: label(k) }))),
  );
  const num = h('input', { id: `${opts.idPrefix}-num`, type: 'number', min: '1', inputmode: 'numeric', value: initial?.type === 'division' ? String(initial.number) : '1' });
  const surahSel = h(
    'select',
    { id: `${opts.idPrefix}-surahs`, multiple: true, size: 5 },
    SURAHS.map((s) => h('option', { value: String(s.number), selected: initial?.type === 'surahs' && initial.surahs.includes(s.number) }, `${s.number}. ${surahName(s.number)}`)),
  );
  const from = h('input', { id: `${opts.idPrefix}-from`, class: 'ltr', dir: 'ltr', inputmode: 'numeric', placeholder: t('common.refPlaceholder', { ref: '2:253' }), value: initial?.type === 'range' ? `${initial.start.surah}:${initial.start.ayah}` : '' });
  const to = h('input', { id: `${opts.idPrefix}-to`, class: 'ltr', dir: 'ltr', inputmode: 'numeric', placeholder: t('common.refPlaceholder', { ref: '3:14' }), value: initial?.type === 'range' ? `${initial.end.surah}:${initial.end.ayah}` : '' });

  const numField = h('label', { class: 'field' }, h('span', null, t('common.number')), num);
  const surahField = h('label', { class: 'field' }, h('span', null, t('picker.surahsHelp')), surahSel);
  const rangeFields = h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', null, t('common.from')), from), h('label', { class: 'field' }, h('span', null, t('common.to')), to));

  function sync() {
    const isDiv = kind !== 'surahs' && kind !== 'range' && kind !== 'all';
    numField.hidden = !isDiv;
    surahField.hidden = kind !== 'surahs';
    rangeFields.hidden = kind !== 'range';
    if (isDiv) num.max = String(index.count(kind as DivisionKind) || 1);
  }
  sync();

  return {
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
      return { scope: { type: 'division', kind, number: n } };
    },
  };
}
