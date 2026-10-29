import { effectiveDueDate } from '../../core/review/scheduler.ts';
import { MISTAKE_CATEGORIES, suggestedCategory, type Mistake, type MistakeCategory, type Severity } from '../../core/model.ts';
import { shouldSuggestResolve } from '../../core/review/policy.ts';
import { parseRef } from '../../core/quran/refs.ts';
import type { AyahRef } from '../../core/quran/types.ts';
import type { App } from '../app.ts';
import { formatDate, h } from '../dom.ts';
import { confirmDialog, openDialog } from './dialog.ts';
import { fmtNum, t, tn } from '../i18n/index.ts';
import { categoryLabel, LocalizedError, refLabel, statusLabel } from '../i18n/labels.ts';

export interface MarkTarget {
  readonly ref: AyahRef;
  /** Word position + verbatim token; null for an ayah-level mark. */
  readonly word: { readonly position: number; readonly tokenText: string } | null;
}

export function statusChip(m: Mistake): HTMLElement {
  return h('span', { class: `chip status-${m.status}` }, statusLabel(m.status));
}

function details(m: Mistake): HTMLElement {
  const due = effectiveDueDate(m);
  return h(
    'dl',
    { class: 'kv' },
    h('dt', null, t('mark.dStatus')), h('dd', null, statusChip(m), m.demo ? [' ', h('span', { class: 'chip demo' }, t('common.demo'))] : null),
    h('dt', null, t('mark.dCategory')), h('dd', null, categoryLabel(m.category)),
    h('dt', null, t('mark.dFirst')), h('dd', null, formatDate(m.createdAt)),
    h('dt', null, t('mark.dLast')), h('dd', null, formatDate(m.lastReviewedAt)),
    h('dt', null, t('mark.dCount')), h('dd', null, fmtNum(m.reviewCount)),
    h('dt', null, t('mark.dAgain')), h('dd', null, tn('mark.dAgainValue', m.lapseCount), m.reopenCount ? t('mark.dReopened', { count: m.reopenCount }) : ''),
    h('dt', null, t('mark.dConfidence')), h('dd', null, m.confidence ? t('mark.confidenceOf5', { n: m.confidence }) : t('mark.notSet')),
    h('dt', null, t('mark.dNext')), h('dd', null, due ? formatDate(due.toISOString()) : t('mark.dNotScheduled'), m.schedule.manualNextReviewAt ? t('mark.dManual') : ''),
  );
}

export async function openMarkDialog(app: App, target: MarkTarget): Promise<void> {
  const existing = await app.s.mistakes.findByKey(target.ref, target.word?.position ?? null);
  const where = () => (target.word ? t('mark.where', { ref: refLabel(target.ref), n: target.word.position }) : t('mark.whereAyah', { ref: refLabel(target.ref) }));
  const suggested = existing ? null : suggestedCategory(target.word?.position ?? null);
  let category: MistakeCategory = existing?.category ?? suggested ?? 'forgotten';
  const catRadios = h(
    'div',
    { class: 'cat-grid', role: 'radiogroup', 'aria-label': t('mark.typeGroup') },
    MISTAKE_CATEGORIES.map((c) =>
      h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'cat', value: c, checked: c === category, onchange: () => { category = c; } }), h('span', null, categoryLabel(c))),
    ),
  );
  const severity = h('select', null, ([1, 2, 3] as const).map((v) => h('option', { value: String(v), selected: (existing?.severity ?? 2) === v }, t(`severity.${v}`))));
  const confidence = h('select', null, h('option', { value: '' }, t('mark.notSet')), [1, 2, 3, 4, 5].map((v) => h('option', { value: String(v), selected: existing?.confidence === v }, t('mark.confidenceOf5', { n: v }))));
  const note = h('textarea', { maxlength: '2000', placeholder: t('mark.notePlaceholder'), dir: 'auto' }, existing?.note ?? '');
  const confused = h('input', { class: 'ltr', dir: 'ltr', placeholder: t('common.refPlaceholder', { ref: '2:58' }), value: existing?.confusedWith ? `${existing.confusedWith.surah}:${existing.confusedWith.ayah}` : '' });

  const read = () => {
    const c = confused.value.trim();
    const confusedWith = c ? parseRef(c) : null;
    if (c && !confusedWith) throw new LocalizedError(t('mark.confusedError'));
    return {
      category,
      severity: Number(severity.value) as Severity,
      note: note.value,
      confidence: confidence.value ? Number(confidence.value) : null,
      confusedWith,
    };
  };

  const done = async (msg: string, close: () => void) => {
    close();
    app.toast(msg);
    await app.refresh();
  };

  openDialog({
    title: existing ? t('mark.titleExisting') : t('mark.titleNew'),
    body: [
      h('p', { class: 'muted' }, where()),
      target.word ? h('div', { class: `dialog-word${existing?.status === 'resolved' ? ' resolved' : ''}`, lang: 'ar', dir: 'rtl' }, target.word.tokenText) : null,
      target.word ? h('p', { class: 'muted' }, t('mark.wordAudioNote')) : null,
      existing ? details(existing) : null,
      existing && shouldSuggestResolve(existing.status, existing.successStreak)
        ? h('div', { class: 'notice info' }, t('mark.suggestResolve', { count: existing.successStreak }))
        : null,
      suggested
        ? h('div', { class: 'notice info', role: 'note' }, t('mark.transitionNote'))
        : null,
      h('fieldset', null, h('legend', null, t('mark.typeLegend')), catRadios),
      h(
        'div',
        { class: 'fields', style: { 'margin-top': '0.75rem' } },
        h('label', { class: 'field' }, h('span', null, t('mark.severity')), severity),
        h('label', { class: 'field' }, h('span', null, t('mark.confidence')), confidence),
        h('label', { class: 'field' }, h('span', null, t('mark.confusedWith')), confused),
      ),
      h('label', { class: 'field', style: { 'margin-top': '0.75rem' } }, h('span', null, t('mark.note')), note),
    ],
    actions: (close) =>
      existing
        ? [
            h('button', {
              type: 'button', class: 'danger quiet',
              onclick: async () => {
                if (await confirmDialog(t('mark.deleteTitle'), t('mark.deleteBody'), t('common.delete'), true)) {
                  await app.act(() => app.s.mistakes.deletePermanently(existing.id));
                  await done(t('mark.deleted'), close);
                }
              },
            }, t('common.delete')),
            existing.status === 'resolved'
              ? h('button', { type: 'button', onclick: async () => { if (await app.act(() => app.s.mistakes.reopen(existing.id))) await done(t('mark.reopened'), close); } }, t('mark.reopen'))
              : h('button', { type: 'button', onclick: async () => { if (await app.act(() => app.s.mistakes.resolve(existing.id))) await done(t('mark.resolvedToast'), close); } }, t('mark.resolve')),
            h('button', {
              type: 'button',
              onclick: async () => {
                if (await app.act(async () => {
                  const v = read();
                  await (target.word
                    ? app.s.mistakes.markWord(target.ref, { ...target.word, edition: existing.edition ?? app.quran.text?.edition ?? 'unknown' }, { category: v.category, note: v.note, severity: v.severity })
                    : app.s.mistakes.markAyah(target.ref, { category: v.category, note: v.note, severity: v.severity }));
                })) await done(t('mark.againToast'), close);
              },
            }, t('mark.again')),
            h('button', { type: 'button', class: 'primary', onclick: async () => { if (await app.act(() => app.s.mistakes.update(existing.id, read()))) await done(t('mark.saved'), close); } }, t('mark.save')),
          ]
        : [
            h('button', { type: 'button', onclick: close }, t('common.cancel')),
            h('button', {
              type: 'button', class: 'primary',
              onclick: async () => {
                const ok = await app.act(async () => {
                  const v = read();
                  const input = { category: v.category, note: v.note, severity: v.severity, confidence: v.confidence, confusedWith: v.confusedWith };
                  if (target.word) {
                    const edition = app.quran.text?.edition;
                    if (!edition) throw new LocalizedError(t('error.wordNeedsText'));
                    await app.s.mistakes.markWord(target.ref, { ...target.word, edition }, input);
                  } else {
                    await app.s.mistakes.markAyah(target.ref, input);
                  }
                });
                if (ok) await done(t('mark.marked', { where: where() }), close);
              },
            }, t('mark.submit')),
          ],
  });
}
