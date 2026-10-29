import { filterMistakes, type MistakeFilter } from '../../core/mistakes/filters.ts';
import { CATEGORY_LABELS, MISTAKE_CATEGORIES, MISTAKE_STATUSES, STATUS_LABELS, isUnresolved, type Mistake, type MistakeCategory, type MistakeStatus } from '../../core/model.ts';
import { effectiveDueDate, isDue } from '../../core/review/scheduler.ts';
import { describeScope, scopeIntervals, type RevisionScope } from '../../core/quran/scope.ts';
import { SURAHS, surahInfo } from '../../core/quran/surahs.ts';
import type { App } from '../app.ts';
import { openMarkDialog, statusChip } from '../components/markDialog.ts';
import { scopePicker } from '../components/scopePicker.ts';
import { formatDate, h, relativeDays } from '../dom.ts';

interface FilterState {
  status: 'unresolved' | 'all' | MistakeStatus;
  category: '' | MistakeCategory;
  surah: string;
  from: string;
  to: string;
  minConfidence: string;
  scope: RevisionScope | null;
  dueOnly: boolean;
}

const state: FilterState = { status: 'unresolved', category: '', surah: '', from: '', to: '', minConfidence: '', scope: null, dueOnly: false };

function toFilter(app: App): { filter: MistakeFilter; error: string | null } {
  let scope;
  let error: string | null = null;
  if (state.scope) {
    try {
      scope = scopeIntervals(state.scope, app.quran.index);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const statuses: MistakeStatus[] | undefined = state.status === 'all' ? undefined : state.status === 'unresolved' ? MISTAKE_STATUSES.filter(isUnresolved) : [state.status];
  return {
    error,
    filter: {
      ...(statuses ? { statuses } : {}),
      ...(state.category ? { categories: [state.category] } : {}),
      ...(state.surah ? { surahs: [Number(state.surah)] } : {}),
      ...(state.from ? { createdFrom: state.from } : {}),
      ...(state.to ? { createdTo: state.to } : {}),
      ...(state.minConfidence ? { minConfidence: Number(state.minConfidence) } : {}),
      ...(scope ? { scope } : {}),
    },
  };
}

function describeFilter(app: App): string {
  const parts: string[] = [];
  if (state.scope) parts.push(describeScope(state.scope, app.quran.index));
  if (state.surah) parts.push(surahInfo(Number(state.surah)).nameTransliterated);
  if (state.category) parts.push(CATEGORY_LABELS[state.category].toLowerCase());
  if (state.from || state.to) parts.push(`marked ${state.from || '…'} to ${state.to || '…'}`);
  if (state.dueOnly) parts.push('due now');
  return parts.length ? `My mistakes: ${parts.join(', ')}` : 'My mistakes';
}

function row(app: App, m: Mistake): HTMLElement {
  const now = app.now();
  const due = effectiveDueDate(m);
  const text = app.quran.text;
  const mismatch = m.word && text && (m.edition !== text.edition || text.wordAt(m, m.word.position) !== m.word.tokenText);
  return h(
    'div',
    { class: 'mistake-row' },
    h('div', null, h('div', { class: 'ref' }, `${m.surah}:${m.ayah}`), h('small', { class: 'muted' }, surahInfo(m.surah).nameTransliterated), m.word ? h('div', { class: 'word-ar', lang: 'ar', dir: 'rtl' }, m.word.tokenText) : h('div', null, h('small', null, 'Whole ayah'))),
    h(
      'div',
      null,
      h('div', { class: 'chips' }, statusChip(m), h('span', { class: 'chip cat' }, CATEGORY_LABELS[m.category]), m.demo ? h('span', { class: 'chip demo' }, 'Demo') : null, mismatch ? h('span', { class: 'chip status-under_review', title: 'The loaded text edition differs from the one used when this word was marked.' }, 'Edition changed') : null),
      h('small', { class: 'muted' }, `Marked ${formatDate(m.createdAt)}. Reviewed ${m.reviewCount}× (last ${relativeDays(m.lastReviewedAt, now)}). ${m.confidence ? `Confidence ${m.confidence}/5. ` : ''}${due ? (due <= now ? 'Due now.' : `Next review ${relativeDays(due.toISOString(), now)}.`) : ''}`),
      m.note ? h('p', { class: 'note' }, m.note) : null,
    ),
    h(
      'div',
      { class: 'row' },
      h('a', { class: 'btn', href: `#/quran?surah=${m.surah}&focus=${m.globalIndex}` }, 'Open in reader'),
      h('button', { type: 'button', 'data-key': `details-${m.id}`, onclick: () => void openMarkDialog(app, { ref: m, word: m.word }) }, 'Details'),
    ),
  );
}

export function mistakesView(app: App): Node {
  const { filter, error } = toFilter(app);
  const now = app.now();
  let list = filterMistakes(app.data.mistakes, filter, app.quran.index);
  if (state.dueOnly) list = list.filter((m) => isDue(m, now));
  const ayat = new Set(list.map((m) => m.globalIndex)).size;
  const rerender = () => app.render(true);
  const sel = (key: keyof FilterState, options: Array<[string, string]>, label: string) =>
    h('label', { class: 'field' }, h('span', null, label), h('select', { 'data-key': `f-${key}`, onchange: (e: Event) => { (state as unknown as Record<string, string>)[key] = (e.target as HTMLSelectElement).value; rerender(); } }, options.map(([v, l]) => h('option', { value: v, selected: String(state[key] ?? '') === v }, l))));
  const picker = scopePicker(app.quran.index, state.scope, { idPrefix: 'mf', allowAll: true });
  const todayPlan = app.data.plans.find((p) => p.date === app.today() && p.kind === 'revision');

  const bySurah = new Map<number, Mistake[]>();
  for (const m of list) bySurah.set(m.surah, [...(bySurah.get(m.surah) ?? []), m]);
  const statusesForSession: MistakeStatus[] = state.status === 'all' ? [...MISTAKE_STATUSES] : state.status === 'unresolved' ? MISTAKE_STATUSES.filter(isUnresolved) : [state.status];

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'My mistakes'), h('p', { class: 'muted' }, 'Everything you have marked, in Quran order. Resolved mistakes stay in your history.'))),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'Choose what to revise'),
      h(
        'div',
        { class: 'fields' },
        sel('status', [['unresolved', 'Unresolved'], ['all', 'All, including resolved'], ...MISTAKE_STATUSES.map((s) => [s, STATUS_LABELS[s]] as [string, string])], 'Status'),
        sel('category', [['', 'All types'], ...MISTAKE_CATEGORIES.map((c) => [c, CATEGORY_LABELS[c]] as [string, string])], 'Type'),
        sel('surah', [['', 'All surahs'], ...SURAHS.map((s) => [String(s.number), `${s.number}. ${s.nameTransliterated}`] as [string, string])], 'Surah'),
        h('label', { class: 'field' }, h('span', null, 'Marked from'), h('input', { type: 'date', value: state.from, 'data-key': 'f-from', onchange: (e: Event) => { state.from = (e.target as HTMLInputElement).value; rerender(); } })),
        h('label', { class: 'field' }, h('span', null, 'Marked until'), h('input', { type: 'date', value: state.to, 'data-key': 'f-to', onchange: (e: Event) => { state.to = (e.target as HTMLInputElement).value; rerender(); } })),
        sel('minConfidence', [['', 'Any confidence'], ['1', '1 or more'], ['2', '2 or more'], ['3', '3 or more'], ['4', '4 or more'], ['5', '5']], 'Confidence'),
      ),
      h('label', { class: 'choice' }, h('input', { type: 'checkbox', checked: state.dueOnly, 'data-key': 'f-due', onchange: (e: Event) => { state.dueOnly = (e.target as HTMLInputElement).checked; rerender(); } }), h('span', null, 'Only mistakes due for review now')),
      h(
        'fieldset',
        { style: { 'margin-top': '0.5rem' } },
        h('legend', null, 'Portion'),
        h('p', { class: 'muted', style: { margin: '0 0 0.5rem' } }, state.scope ? `Limited to ${describeScope(state.scope, app.quran.index)}.` : 'All of the Quran.'),
        picker.el,
        h(
          'div',
          { class: 'row', style: { 'margin-top': '0.5rem' } },
          h('button', { type: 'button', onclick: () => { const r = picker.read(); if ('error' in r) app.toast(r.error, 'error'); else { state.scope = r.scope.type === 'all' ? null : r.scope; rerender(); } } }, 'Apply portion'),
          todayPlan ? h('button', { type: 'button', onclick: () => { state.scope = todayPlan.scope; rerender(); } }, `Today’s portion (${describeScope(todayPlan.scope, app.quran.index)})`) : null,
          state.scope ? h('button', { type: 'button', class: 'quiet', onclick: () => { state.scope = null; rerender(); } }, 'Whole Quran') : null,
        ),
      ),
      error ? h('p', { role: 'alert', style: { color: 'var(--mistake)' } }, error) : null,
      h(
        'div',
        { class: 'row spread', style: { 'margin-top': '1rem' } },
        h('strong', null, `${list.length} mistake${list.length === 1 ? '' : 's'} on ${ayat} ayah${ayat === 1 ? '' : 's'}`),
        h('button', {
          type: 'button', class: 'primary', disabled: list.length === 0, 'data-key': 'revise-these',
          onclick: () => {
            const p = app.prefs;
            app.prepare({
              mode: 'mistakes',
              scope: state.scope ?? { type: 'all' },
              planId: null,
              label: describeFilter(app),
              options: { mistakeIds: list.map((m) => m.id), statuses: statusesForSession, contextBefore: p.contextBefore, contextAfter: p.contextAfter, contextAcrossSurahs: p.contextAcrossSurahs, wordPractice: p.wordPractice },
              repeat: p.repeat,
              portionAyahRepeat: p.portionAyahRepeat,
              reciterId: p.reciterId,
            });
          },
        }, 'Listen to these mistakes'),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      list.length === 0
        ? h('div', { class: 'empty' }, h('p', null, app.data.mistakes.length ? 'No mistakes match these filters.' : 'You have not marked any mistakes yet. While reading, tap a word or an ayah number to mark it.'), app.data.mistakes.length ? null : h('a', { class: 'btn primary', href: '#/quran' }, 'Open the Quran'))
        : [...bySurah.entries()].map(([s, ms]) => h('div', null, h('h3', { style: { 'margin-top': '0.75rem' } }, `${s}. ${surahInfo(s).nameTransliterated} `, h('span', { lang: 'ar', class: 'muted' }, surahInfo(s).nameArabic)), ms.map((m) => row(app, m)))),
    ),
  );
}
