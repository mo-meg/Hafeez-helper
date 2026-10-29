import { filterMistakes, type MistakeFilter } from '../../core/mistakes/filters.ts';
import { MISTAKE_CATEGORIES, MISTAKE_STATUSES, isUnresolved, type Mistake, type MistakeCategory, type MistakeStatus } from '../../core/model.ts';
import { effectiveDueDate, isDue } from '../../core/review/scheduler.ts';
import { scopeIntervals, type RevisionScope } from '../../core/quran/scope.ts';
import { SURAHS } from '../../core/quran/surahs.ts';
import type { App } from '../app.ts';
import { openMarkDialog, statusChip } from '../components/markDialog.ts';
import { scopePicker } from '../components/scopePicker.ts';
import { formatDate, h, relativeDays } from '../dom.ts';
import { fmtDateKey, fmtList, t, tn } from '../i18n/index.ts';
import { categoryLabel, errorText, scopeLabel, statusLabel, surahName, surahOption } from '../i18n/labels.ts';

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
      error = errorText(e);
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

/** Session title for the current filters; evaluated at render time so it follows the language. */
function describeFilter(app: App, f: FilterState): string {
  const parts: string[] = [];
  if (f.scope) parts.push(scopeLabel(f.scope, app.quran.index));
  if (f.surah) parts.push(surahName(Number(f.surah)));
  if (f.category) parts.push(categoryLabel(f.category));
  if (f.from || f.to) parts.push(t('mis.markedRange', { from: f.from ? fmtDateKey(f.from) : '…', to: f.to ? fmtDateKey(f.to) : '…' }));
  if (f.dueOnly) parts.push(t('mis.dueNowPart'));
  return parts.length ? t('mis.labelWith', { parts: fmtList(parts) }) : t('mis.title');
}

function row(app: App, m: Mistake): HTMLElement {
  const now = app.now();
  const due = effectiveDueDate(m);
  const text = app.quran.text;
  const mismatch = m.word && text && (m.edition !== text.edition || text.wordAt(m, m.word.position) !== m.word.tokenText);
  return h(
    'div',
    { class: 'mistake-row' },
    h('div', null, h('div', { class: 'ref', dir: 'ltr', style: { 'text-align': 'start' } }, `${m.surah}:${m.ayah}`), h('small', { class: 'muted' }, surahName(m.surah)), m.word ? h('div', { class: `word-ar${m.status === 'resolved' ? ' resolved' : ''}`, lang: 'ar', dir: 'rtl' }, m.word.tokenText) : h('div', null, h('small', null, t('mis.wholeAyah')))),
    h(
      'div',
      null,
      h('div', { class: 'chips' }, statusChip(m), h('span', { class: 'chip cat' }, categoryLabel(m.category)), m.demo ? h('span', { class: 'chip demo' }, t('common.demo')) : null, mismatch ? h('span', { class: 'chip status-under_review', title: t('mis.editionChangedHint') }, t('mis.editionChanged')) : null),
      h('small', { class: 'muted' }, [t('mis.summaryMarked', { date: formatDate(m.createdAt) }), t('mis.summaryReviewed', { count: m.reviewCount, when: relativeDays(m.lastReviewedAt, now) }), m.confidence ? t('mis.summaryConfidence', { n: m.confidence }) : '', due ? (due <= now ? t('mis.summaryDue') : t('mis.summaryNext', { when: relativeDays(due.toISOString(), now) })) : ''].filter(Boolean).join(' ')),
      m.note ? h('p', { class: 'note', dir: 'auto' }, m.note) : null,
    ),
    h(
      'div',
      { class: 'row' },
      h('a', { class: 'btn', href: `#/quran?surah=${m.surah}&focus=${m.globalIndex}` }, t('mis.openReader')),
      h('button', { type: 'button', 'data-key': `details-${m.id}`, onclick: () => void openMarkDialog(app, { ref: m, word: m.word }) }, t('mis.details')),
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
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('mis.title')), h('p', { class: 'muted' }, t('mis.intro')))),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, t('mis.choose')),
      h(
        'div',
        { class: 'fields' },
        sel('status', [['unresolved', t('mis.fUnresolved')], ['all', t('mis.fAll')], ...MISTAKE_STATUSES.map((s) => [s, statusLabel(s)] as [string, string])], t('common.status')),
        sel('category', [['', t('mis.fAllTypes')], ...MISTAKE_CATEGORIES.map((c) => [c, categoryLabel(c)] as [string, string])], t('common.type')),
        sel('surah', [['', t('mis.fAllSurahs')], ...SURAHS.map((s) => [String(s.number), surahOption(s.number)] as [string, string])], t('common.surah')),
        h('label', { class: 'field' }, h('span', null, t('mis.fFrom')), h('input', { type: 'date', value: state.from, 'data-key': 'f-from', onchange: (e: Event) => { state.from = (e.target as HTMLInputElement).value; rerender(); } })),
        h('label', { class: 'field' }, h('span', null, t('mis.fTo')), h('input', { type: 'date', value: state.to, 'data-key': 'f-to', onchange: (e: Event) => { state.to = (e.target as HTMLInputElement).value; rerender(); } })),
        sel('minConfidence', [['', t('mis.fAnyConfidence')], ...[1, 2, 3, 4].map((n) => [String(n), t('mis.fConfidenceMin', { n })] as [string, string]), ['5', '5']], t('mis.fConfidence')),
      ),
      h('label', { class: 'choice' }, h('input', { type: 'checkbox', checked: state.dueOnly, 'data-key': 'f-due', onchange: (e: Event) => { state.dueOnly = (e.target as HTMLInputElement).checked; rerender(); } }), h('span', null, t('mis.fDue'))),
      h(
        'fieldset',
        { style: { 'margin-top': '0.5rem' } },
        h('legend', null, t('common.portion')),
        h('p', { class: 'muted', style: { margin: '0 0 0.5rem' } }, state.scope ? t('mis.limited', { portion: scopeLabel(state.scope, app.quran.index) }) : t('mis.allQuran')),
        picker.el,
        h(
          'div',
          { class: 'row', style: { 'margin-top': '0.5rem' } },
          h('button', { type: 'button', onclick: () => { const r = picker.read(); if ('error' in r) app.toast(r.error, 'error'); else { state.scope = r.scope.type === 'all' ? null : r.scope; rerender(); } } }, t('mis.apply')),
          todayPlan ? h('button', { type: 'button', onclick: () => { state.scope = todayPlan.scope; rerender(); } }, t('mis.todayPortion', { portion: scopeLabel(todayPlan.scope, app.quran.index) })) : null,
          state.scope ? h('button', { type: 'button', class: 'quiet', onclick: () => { state.scope = null; rerender(); } }, t('mis.wholeQuran')) : null,
        ),
      ),
      error ? h('p', { role: 'alert', style: { color: 'var(--mistake)' } }, error) : null,
      h(
        'div',
        { class: 'row spread', style: { 'margin-top': '1rem' } },
        h('strong', null, tn('mis.count', list.length, { ayat: tn('mis.ayatCount', ayat) })),
        h('button', {
          type: 'button', class: 'primary', disabled: list.length === 0, 'data-key': 'revise-these',
          onclick: () => {
            const p = app.prefs;
            const snapshot: FilterState = { ...state };
            app.prepare({
              mode: 'mistakes',
              scope: state.scope ?? { type: 'all' },
              planId: null,
              label: 'My mistakes',
              options: { mistakeIds: list.map((m) => m.id), statuses: statusesForSession, contextBefore: p.contextBefore, contextAfter: p.contextAfter, contextAcrossSurahs: p.contextAcrossSurahs, wordPractice: p.wordPractice },
              repeat: p.repeat,
              portionAyahRepeat: p.portionAyahRepeat,
              reciterId: p.reciterId,
            }, () => describeFilter(app, snapshot));
          },
        }, t('mis.listen')),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      list.length === 0
        ? h('div', { class: 'empty' }, h('p', null, app.data.mistakes.length ? t('mis.noMatch') : t('mis.none')), app.data.mistakes.length ? null : h('a', { class: 'btn primary', href: '#/quran' }, t('common.openQuran')))
        : [...bySurah.entries()].map(([s, ms]) => h('div', null, h('h3', { style: { 'margin-top': '0.75rem' } }, surahOption(s)), ms.map((m) => row(app, m)))),
    ),
  );
}
