import { effectiveDueDate } from '../../core/review/scheduler.ts';
import { CATEGORY_LABELS, MISTAKE_CATEGORIES, STATUS_LABELS, suggestedCategory, type Mistake, type MistakeCategory, type Severity } from '../../core/model.ts';
import { shouldSuggestResolve } from '../../core/review/policy.ts';
import { formatRef, parseRef } from '../../core/quran/refs.ts';
import type { AyahRef } from '../../core/quran/types.ts';
import type { App } from '../app.ts';
import { formatDate, h } from '../dom.ts';
import { confirmDialog, openDialog } from './dialog.ts';

export interface MarkTarget {
  readonly ref: AyahRef;
  /** Word position + verbatim token; null for an ayah-level mark. */
  readonly word: { readonly position: number; readonly tokenText: string } | null;
}

export function statusChip(m: Mistake): HTMLElement {
  return h('span', { class: `chip status-${m.status}` }, STATUS_LABELS[m.status]);
}

function details(m: Mistake): HTMLElement {
  const due = effectiveDueDate(m);
  return h(
    'dl',
    { class: 'kv' },
    h('dt', null, 'Status'), h('dd', null, statusChip(m), m.demo ? [' ', h('span', { class: 'chip demo' }, 'Demo')] : null),
    h('dt', null, 'Category'), h('dd', null, CATEGORY_LABELS[m.category]),
    h('dt', null, 'First marked'), h('dd', null, formatDate(m.createdAt)),
    h('dt', null, 'Last reviewed'), h('dd', null, formatDate(m.lastReviewedAt)),
    h('dt', null, 'Times reviewed'), h('dd', null, String(m.reviewCount)),
    h('dt', null, 'Occurred again'), h('dd', null, `${m.lapseCount} time${m.lapseCount === 1 ? '' : 's'}${m.reopenCount ? `, reopened ${m.reopenCount}×` : ''}`),
    h('dt', null, 'Your confidence'), h('dd', null, m.confidence ? `${m.confidence} of 5` : 'Not set'),
    h('dt', null, 'Next review'), h('dd', null, due ? formatDate(due.toISOString()) : 'Not scheduled (resolved)', m.schedule.manualNextReviewAt ? ' (set by you)' : ''),
  );
}

export async function openMarkDialog(app: App, target: MarkTarget): Promise<void> {
  const existing = await app.s.mistakes.findByKey(target.ref, target.word?.position ?? null);
  const where = target.word ? `${formatRef(target.ref)}, word ${target.word.position}` : `${formatRef(target.ref)}, whole ayah`;
  const suggested = existing ? null : suggestedCategory(target.word?.position ?? null);
  let category: MistakeCategory = existing?.category ?? suggested ?? 'forgotten';
  const catRadios = h(
    'div',
    { class: 'cat-grid', role: 'radiogroup', 'aria-label': 'Mistake type' },
    MISTAKE_CATEGORIES.map((c) =>
      h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'cat', value: c, checked: c === category, onchange: () => { category = c; } }), h('span', null, CATEGORY_LABELS[c])),
    ),
  );
  const severity = h('select', null, ([1, 2, 3] as const).map((v) => h('option', { value: String(v), selected: (existing?.severity ?? 2) === v }, ['Minor', 'Moderate', 'Serious'][v - 1])));
  const confidence = h('select', null, h('option', { value: '' }, 'Not set'), [1, 2, 3, 4, 5].map((v) => h('option', { value: String(v), selected: existing?.confidence === v }, `${v} of 5`)));
  const note = h('textarea', { maxlength: '2000', placeholder: 'Private note, for example what you said instead' }, existing?.note ?? '');
  const confused = h('input', { placeholder: 'e.g. 2:58', value: existing?.confusedWith ? `${existing.confusedWith.surah}:${existing.confusedWith.ayah}` : '' });

  const read = () => {
    const c = confused.value.trim();
    const confusedWith = c ? parseRef(c) : null;
    if (c && !confusedWith) throw new Error('“Confused with” must be a valid reference such as 2:58.');
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
    title: existing ? 'Recorded mistake' : 'Mark a mistake',
    body: [
      h('p', { class: 'muted' }, where),
      target.word ? h('div', { class: `dialog-word${existing?.status === 'resolved' ? ' resolved' : ''}`, lang: 'ar', dir: 'rtl' }, target.word.tokenText) : null,
      target.word ? h('p', { class: 'muted' }, 'Revision plays the whole ayah. Word-level audio positioning is not available for the configured audio sources.') : null,
      existing ? details(existing) : null,
      existing && shouldSuggestResolve(existing.status, existing.successStreak)
        ? h('div', { class: 'notice info' }, `You recalled this correctly in ${existing.successStreak} separate sessions. You can mark it resolved if you are confident.`)
        : null,
      suggested
        ? h('div', { class: 'notice info', role: 'note' }, 'This is the first word of the ayah, so “Linking ayat (transition)” was selected: the difficulty is usually connecting the previous ayah to this one. You can choose another type.')
        : null,
      h('fieldset', null, h('legend', null, 'Type of mistake'), catRadios),
      h(
        'div',
        { class: 'fields', style: { 'margin-top': '0.75rem' } },
        h('label', { class: 'field' }, h('span', null, 'Severity'), severity),
        h('label', { class: 'field' }, h('span', null, 'Your confidence'), confidence),
        h('label', { class: 'field' }, h('span', null, 'Confused with (optional)'), confused),
      ),
      h('label', { class: 'field', style: { 'margin-top': '0.75rem' } }, h('span', null, 'Note'), note),
    ],
    actions: (close) =>
      existing
        ? [
            h('button', {
              type: 'button', class: 'danger quiet',
              onclick: async () => {
                if (await confirmDialog('Delete permanently?', 'This removes the mistake and its review history from this device. Resolving keeps the history instead.', 'Delete', true)) {
                  await app.act(() => app.s.mistakes.deletePermanently(existing.id));
                  await done('Mistake deleted.', close);
                }
              },
            }, 'Delete'),
            existing.status === 'resolved'
              ? h('button', { type: 'button', onclick: async () => { if (await app.act(() => app.s.mistakes.reopen(existing.id))) await done('Mistake reopened.', close); } }, 'Reopen')
              : h('button', { type: 'button', onclick: async () => { if (await app.act(() => app.s.mistakes.resolve(existing.id))) await done('Marked as resolved. It stays in your history.', close); } }, 'Mark resolved'),
            h('button', {
              type: 'button',
              onclick: async () => {
                if (await app.act(async () => {
                  const v = read();
                  await (target.word
                    ? app.s.mistakes.markWord(target.ref, { ...target.word, edition: existing.edition ?? app.quran.text?.edition ?? 'unknown' }, { category: v.category, note: v.note, severity: v.severity })
                    : app.s.mistakes.markAyah(target.ref, { category: v.category, note: v.note, severity: v.severity }));
                })) await done('Recorded that the mistake happened again.', close);
              },
            }, 'It happened again'),
            h('button', { type: 'button', class: 'primary', onclick: async () => { if (await app.act(() => app.s.mistakes.update(existing.id, read()))) await done('Changes saved.', close); } }, 'Save changes'),
          ]
        : [
            h('button', { type: 'button', onclick: close }, 'Cancel'),
            h('button', {
              type: 'button', class: 'primary',
              onclick: async () => {
                const ok = await app.act(async () => {
                  const v = read();
                  const input = { category: v.category, note: v.note, severity: v.severity, confidence: v.confidence, confusedWith: v.confusedWith };
                  if (target.word) {
                    const edition = app.quran.text?.edition;
                    if (!edition) throw new Error('Word marks need the Quran text to be loaded.');
                    await app.s.mistakes.markWord(target.ref, { ...target.word, edition }, input);
                  } else {
                    await app.s.mistakes.markAyah(target.ref, input);
                  }
                });
                if (ok) await done(`Marked ${where}.`, close);
              },
            }, 'Mark mistake'),
          ],
  });
}
