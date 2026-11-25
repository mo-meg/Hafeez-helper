import type { RecitationState } from '../../core/recitation/controller.ts';
import type { WordStatus } from '../../core/recitation/tracker.ts';
import { fromIndex } from '../../core/quran/refs.ts';
import type { App } from '../app.ts';
import { ensureLive, isActive, startReciting, statusLabel, stopReciting, summaryPanel, togglePause, type RecitationLive } from '../components/reciteSession.ts';
import { icon } from '../components/icons.ts';
import { arabicDigits, h, replaceChildren, type Child } from '../dom.ts';
import { t, type MessageKey } from '../i18n/index.ts';
import { surahName } from '../i18n/labels.ts';

/**
 * Recitation tracker page, Quran-focused: a mic button (ring while the model loads, pulse while
 * listening), the mushaf page that follows the recitation, and the summary after Stop. No headings,
 * status line, stat tiles or legend; problems appear as toasts.
 */
let host: HTMLElement | null = null;
/** Memorisation: words not yet recited are hidden. */
let hide = false;

export function reciteView(app: App): Node {
  const l = ensureLive(app);
  if (!l) return h('div', null, h('p', { class: 'notice' }, t('rec.noText')));
  host = h('div', { class: 'recite' });
  const el = host;
  const repaint = () => {
    if (!el.isConnected) {
      l.listeners.delete(repaint);
      return;
    }
    paint(app, l, el);
  };
  l.listeners.add(repaint);
  paint(app, l, el);
  return el;
}

function paint(app: App, l: RecitationLive, el: HTMLElement): void {
  const st = l.state;
  const noKey = !app.deps.quranLabKey ? h('p', { class: 'notice warn' }, t('rec.noKey')) : null;
  const text = st ? textPanel(l, st) : null;
  const done = st && (st.status === 'stopped' || st.status === 'error') ? summaryPanel(app, l, st, () => paint(app, l, el)) : null;
  replaceChildren(el, noKey, controls(app, l, st, el), text ?? emptyStage(), done);
}

/** Placeholder for the mushaf area before the first words are located. */
function emptyStage(): HTMLElement {
  return h('div', { class: 'rec-empty' }, h('span', { class: 'rec-empty-icon' }, icon('mic')), h('p', null, t('rec.reciteAnywhere')));
}

function controls(app: App, l: RecitationLive, st: RecitationState | null, el: HTMLElement): HTMLElement {
  const active = isActive(l);
  const listening = st?.status === 'listening' && !st.paused;
  const busy = l.preparing || st?.status === 'loading' || st?.status === 'stopping';
  const label = statusLabel(l);
  const mainBtn = active
    ? h('button', { type: 'button', class: `rec-main stop${busy ? ' is-busy' : ''}${listening ? ' is-live' : ''}`, 'data-key': 'rec-stop', title: label, 'aria-label': `${t('rec.stop')} · ${label}`, disabled: l.preparing || st?.status === 'stopping', onclick: () => void stopReciting(l) },
      icon(busy ? 'mic' : 'stop'), h('span', null, busy ? label : t('rec.stop')))
    : h('button', { type: 'button', class: 'rec-main', 'data-key': 'rec-start', disabled: !app.deps.quranLabKey, onclick: () => void startReciting(app, l) }, icon('mic'), h('span', null, t('rec.start')));
  const tools = h('div', { class: 'rec-tools' },
    st?.status === 'listening'
      ? h('button', { type: 'button', class: 'quiet icon', 'data-key': 'rec-pause', 'aria-pressed': String(st.paused), 'aria-label': st.paused ? t('rec.resume') : t('rec.pause'), title: st.paused ? t('rec.resume') : t('rec.pause'), onclick: () => togglePause(l) }, icon(st.paused ? 'play' : 'pause'))
      : null,
    h('button', { type: 'button', class: 'quiet icon', 'data-key': 'rec-hide', 'aria-pressed': String(hide), 'aria-label': hide ? t('rec.show') : t('rec.hide'), title: hide ? t('rec.show') : t('rec.hide'), onclick: () => { hide = !hide; paint(app, l, el); } }, icon(hide ? 'eye' : 'eyeOff')),
  );
  return h('div', { class: 'rec-bar' }, mainBtn, h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite' }, label), tools);
}

// ------------------------------------------------------------------ text
/** Range of ayat to show: the current mushaf page (or ±8 ayat when page data is missing). */
function visibleAyat(l: RecitationLive, st: RecitationState): [number, number] | null {
  const c = st.tracker.cursor;
  if (c === null) return null;
  const flat = Math.min(c, l.corpus.size - 1);
  const ayah = l.corpus.words[flat]?.ayahIndex ?? 1;
  const page = l.corpus.pageAt(flat);
  if (page === null) return [Math.max(1, ayah - 8), Math.min(6236, ayah + 8)];
  const [a, b] = l.corpus.pageSpan(page, page);
  return [l.corpus.words[a]?.ayahIndex ?? ayah, l.corpus.words[b - 1]?.ayahIndex ?? ayah];
}

function textPanel(l: RecitationLive, st: RecitationState): HTMLElement | null {
  const range = visibleAyat(l, st);
  if (!range) return null;
  const parts: HTMLElement[] = [];
  const cursor = st.tracker.cursor;
  for (let idx = range[0]; idx <= range[1]; idx++) {
    const ref = fromIndex(idx);
    if (ref.ayah === 1) parts.push(h('div', { class: 'surah-head' }, h('span', { class: 'ar' }, surahName(ref.surah))));
    let flat = l.corpus.ayahStart(idx);
    const words: Child[] = [];
    for (const w of l.corpus.words.slice(flat, l.corpus.ayahStart(idx + 1))) {
      const status: WordStatus | undefined = st.tracker.status.get(flat);
      const veiled = hide && !status && flat !== cursor;
      words.push(h('span', { class: `rw${status ? ` st-${status}` : ''}${flat === cursor ? ' cur' : ''}${veiled ? ' veiled' : ''}`, title: status && status !== 'correct' ? t(`rec.st.${status}` as MessageKey) : undefined }, w.text), ' ');
      flat++;
    }
    parts.push(h('span', { class: 'ayah' }, words, h('span', { class: 'ayah-end rec-end' }, arabicDigits(ref.ayah)), ' '));
  }
  return h('div', { class: 'mushaf' }, h('div', { class: 'quran', lang: 'ar', dir: 'rtl' }, parts));
}
