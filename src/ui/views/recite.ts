import { MicError, startMicrophone, type MicSession } from '../../browser/micCapture.ts';
import { engineErrorText, TajweedFormerEngine } from '../../browser/tajweedEngine.ts';
import { RecitationController, type RecitationState } from '../../core/recitation/controller.ts';
import { RecitationCorpus } from '../../core/recitation/corpus.ts';
import { categoryFor, DEFAULT_SAVE_KINDS, RecitationMistakeBridge } from '../../core/recitation/mistakeBridge.ts';
import { RecitationTracker, type Finding, type WordStatus } from '../../core/recitation/tracker.ts';
import { buildUnitCorpus } from '../../core/recitation/unitCorpus.ts';
import { fromIndex } from '../../core/quran/refs.ts';
import type { App } from '../app.ts';
import { icon } from '../components/icons.ts';
import { arabicDigits, h, replaceChildren, type Child } from '../dom.ts';
import { fmtNum, t, type MessageKey } from '../i18n/index.ts';
import { categoryLabel, errorText, refLabel, surahName } from '../i18n/labels.ts';

/** Live recitation state kept outside renders (the view may re-render at any time). */
interface Live {
  /** Canonical words for display (Arabic comparison forms). */
  corpus: RecitationCorpus;
  /** Same words with the model's sound units as comparison forms (built once, after the model loads). */
  unitCorpus: RecitationCorpus | null;
  engine: TajweedFormerEngine;
  controller: RecitationController | null;
  mic: MicSession | null;
  state: RecitationState | null;
  /** Shown while the model downloads / the comparison text is prepared, before a controller exists. */
  preparing: string | null;
  bridge: RecitationMistakeBridge | null;
  selected: Set<string>;
  host: HTMLElement | null;
  /** Memorisation mode: words not yet recited are hidden. */
  hide: boolean;
}
let live: Live | null = null;

function ensureLive(app: App): Live | null {
  const text = app.quran.text;
  if (!text) return null;
  if (!live || live.corpus.edition !== text.edition) {
    live = { corpus: new RecitationCorpus(text, app.quran.index), unitCorpus: null, engine: live?.engine ?? new TajweedFormerEngine(app.deps.quranLabKey ?? ''), controller: null, mic: null, state: null, preparing: null, bridge: null, selected: new Set(), host: null, hide: false };
  }
  return live;
}

export function reciteView(app: App): Node {
  const l = ensureLive(app);
  const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('rec.title')), h('p', { class: 'muted' }, t('rec.intro'))));
  if (!l) return h('div', null, head, h('p', { class: 'notice' }, t('rec.noText')));
  l.host = h('div', { class: 'recite' });
  paint(app, l);
  return h('div', null, head, l.host);
}

function paint(app: App, l: Live): void {
  if (!l.host) return;
  const st = l.state;
  const noKey = !app.deps.quranLabKey ? h('p', { class: 'notice warn' }, t('rec.noKey')) : null;
  const text = st ? textPanel(l, st) : null;
  replaceChildren(l.host, noKey, controls(app, l, st), text ?? emptyStage(), text ? legend() : null, st && (st.status === 'stopped' || st.status === 'error') ? summary(app, l, st) : null);
}

/** Placeholder for the mushaf area before the first words are located. */
function emptyStage(): HTMLElement {
  return h('div', { class: 'rec-empty' }, h('span', { class: 'rec-empty-icon' }, icon('mic')), h('p', null, t('rec.reciteAnywhere')));
}

// ------------------------------------------------------------------ controls
function statusText(l: Live, st: RecitationState | null): string {
  if (l.preparing) return l.preparing;
  if (!st) return t('rec.status.idle');
  if (st.status === 'error' && st.error) return t(`rec.err.${st.error.kind}` as MessageKey, { detail: st.error.detail });
  if (st.status === 'loading' && st.progress && st.progress.bytesTotal > 0 && st.progress.bytesDone < st.progress.bytesTotal) return progressText(st.progress.bytesDone, st.progress.bytesTotal);
  if (st.status === 'listening' && st.paused) return t('rec.status.paused');
  if (st.status === 'listening') return st.silent ? t('rec.status.waiting') : t('rec.status.listening');
  return t(`rec.status.${st.status}` as MessageKey);
}

const mb = (b: number) => fmtNum(Math.round(b / 1e5) / 10);
const progressText = (done: number, total: number) => t('rec.loadingProgress', { done: mb(done), total: mb(total) });

function controls(app: App, l: Live, st: RecitationState | null): HTMLElement {
  const active = !!l.preparing || st?.status === 'listening' || st?.status === 'loading' || st?.status === 'stopping';
  const live = st?.status === 'listening' && !st.paused;
  const busy = !!l.preparing || st?.status === 'loading' || st?.status === 'stopping';
  const mainBtn = active
    ? h('button', { type: 'button', class: 'rec-main stop', 'data-key': 'rec-stop', disabled: !!l.preparing || st?.status === 'stopping', onclick: () => void stop(app, l) }, icon('stop'), h('span', null, t('rec.stop')))
    : h('button', { type: 'button', class: 'rec-main', 'data-key': 'rec-start', disabled: !app.deps.quranLabKey, onclick: () => void start(app, l) }, icon('mic'), h('span', null, t('rec.start')));
  const tools = h('div', { class: 'rec-tools' },
    st?.status === 'listening'
      ? h('button', { type: 'button', class: 'quiet', 'data-key': 'rec-pause', 'aria-pressed': String(st.paused), onclick: () => (st.paused ? l.controller?.resume() : l.controller?.pause()) }, icon(st.paused ? 'play' : 'pause'), st.paused ? t('rec.resume') : t('rec.pause'))
      : null,
    h('button', { type: 'button', class: 'quiet', 'data-key': 'rec-hide', 'aria-pressed': String(l.hide), onclick: () => { l.hide = !l.hide; paint(app, l); } }, icon(l.hide ? 'eye' : 'eyeOff'), l.hide ? t('rec.show') : t('rec.hide')),
  );
  return h(
    'section',
    { class: `panel rec-console${live ? ' is-live' : ''}${busy ? ' is-busy' : ''}` },
    h('div', { class: 'rec-console-top' },
      mainBtn,
      h('div', { class: 'rec-status' },
        h('div', { class: 'rec-status-line' },
          h('span', { class: `rec-dot ${st?.status === 'listening' && !st.paused ? (st.silent ? 'idle' : 'on') : ''}`, 'aria-hidden': 'true' }),
          h('span', { role: 'status', 'aria-live': 'polite', class: st?.status === 'error' ? 'rec-error' : '' }, statusText(l, st))),
        st ? locationLine(st) : null),
      tools),
    st ? stats(st) : null,
    h('p', { class: 'rec-notice' }, t('rec.notice')),
  );
}

async function start(app: App, l: Live): Promise<void> {
  const setPreparing = (msg: string | null) => {
    l.preparing = msg;
    paint(app, l);
  };
  // First start: download/open the model, then build the sound-unit comparison text once.
  if (!l.unitCorpus) {
    l.state = null;
    setPreparing(t('rec.status.loading'));
    try {
      await l.engine.load((p) => setPreparing(p.bytesTotal > 0 && p.bytesDone < p.bytesTotal ? progressText(p.bytesDone, p.bytesTotal) : t('rec.status.loading')));
      setPreparing(t('rec.preparing'));
      const text = app.quran.text;
      if (!text) throw new Error(t('rec.noText'));
      l.unitCorpus = await buildUnitCorpus(text, app.quran.index, l.engine);
      if (l.unitCorpus.mismatchedAyat.length) console.info(`Recitation tracker: ${l.unitCorpus.mismatchedAyat.length} ayat have a different word count in the model's reference table.`);
    } catch (e) {
      setPreparing(null);
      app.toast(t('rec.err.model', { detail: engineErrorText(e) }), 'error');
      return;
    }
    setPreparing(null);
  }
  const tracker = new RecitationTracker(l.unitCorpus);
  const controller = new RecitationController({
    engine: l.engine,
    tracker,
    onUpdate: (s) => {
      l.state = s;
      if (s.status === 'error') {
        l.mic?.stop();
        l.mic = null;
      }
      paint(app, l);
    },
  });
  l.controller = controller;
  l.bridge = new RecitationMistakeBridge(app.s.mistakes, l.corpus.edition, `rec-${app.now().toISOString()}`);
  l.selected = new Set();
  if (!(await controller.start())) return;
  try {
    l.mic = await startMicrophone((pcm) => controller.feed(pcm), (e) => void controller.interrupt(e.message));
  } catch (e) {
    await controller.interrupt(e instanceof MicError ? t(`rec.mic.${e.kind}` as MessageKey) : errorText(e));
  }
}

async function stop(_app: App, l: Live): Promise<void> {
  l.mic?.stop();
  l.mic = null;
  await l.controller?.stop();
}

// ------------------------------------------------------------------ location + text
function locationLine(st: RecitationState): HTMLElement {
  const loc = st.tracker.location;
  const focused = st.tracker.mode === 'focused' && !!loc;
  const mode = focused ? t('rec.mode.focused', { page: loc.page ?? '—' }) : t('rec.mode.searching');
  return h(
    'div',
    { class: 'rec-location' },
    h('span', { class: `chip ${focused ? 'status-improved' : 'status-under_review'}` }, mode),
    loc ? h('span', null, t('rec.location', { surah: surahName(loc.ref.surah), ayah: fmtNum(loc.ref.ayah), page: loc.page === null ? '—' : fmtNum(loc.page), word: fmtNum(loc.position) })) : null,
  );
}

function stats(st: RecitationState): HTMLElement {
  const mistakes = st.tracker.findings.filter((f) => f.kind !== 'repeated').length;
  const tile = (value: number, label: string, cls = '') => h('div', { class: `rec-stat${cls}` }, h('strong', null, fmtNum(value)), h('span', null, label));
  return h('div', { class: 'rec-stats', 'aria-live': 'off' },
    tile(st.tracker.recitedWords, t('rec.stat.words')),
    tile(mistakes, t('rec.stat.mistakes'), mistakes ? ' warn' : ''),
    tile(st.tracker.selfCorrections, t('rec.stat.fixes')));
}

/** Range of ayat to show: the current mushaf page (or ±8 ayat when page data is missing). */
function visibleAyat(l: Live, st: RecitationState): [number, number] | null {
  const c = st.tracker.cursor;
  if (c === null) return null;
  const flat = Math.min(c, l.corpus.size - 1);
  const ayah = l.corpus.words[flat]?.ayahIndex ?? 1;
  const page = l.corpus.pageAt(flat);
  if (page === null) return [Math.max(1, ayah - 8), Math.min(6236, ayah + 8)];
  const [a, b] = l.corpus.pageSpan(page, page);
  return [l.corpus.words[a]?.ayahIndex ?? ayah, l.corpus.words[b - 1]?.ayahIndex ?? ayah];
}

function textPanel(l: Live, st: RecitationState): HTMLElement | null {
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
      const veiled = l.hide && !status && flat !== cursor;
      words.push(h('span', { class: `rw${status ? ` st-${status}` : ''}${flat === cursor ? ' cur' : ''}${veiled ? ' veiled' : ''}`, title: status ? t(`rec.st.${status}` as MessageKey) : undefined }, w.text), ' ');
      flat++;
    }
    parts.push(h('span', { class: 'ayah' }, words, h('span', { class: 'ayah-end rec-end' }, arabicDigits(ref.ayah)), ' '));
  }
  return h('div', { class: 'mushaf' }, h('div', { class: 'quran', lang: 'ar', dir: 'rtl' }, parts));
}

function legend(): HTMLElement {
  const items: WordStatus[] = ['correct', 'pending', 'incorrect', 'skipped', 'repeated', 'hesitation', 'uncertain'];
  return h('div', { class: 'legend rec-legend', 'aria-label': t('quran.legend') }, items.map((s) => h('span', null, h('span', { class: `rec-swatch sw-${s}`, 'aria-hidden': 'true' }), t(`rec.st.${s}` as MessageKey))));
}

// ------------------------------------------------------------------ summary + saving
function summary(app: App, l: Live, st: RecitationState): HTMLElement {
  const findings = st.tracker.findings;
  if (!l.selected.size) for (const f of findings) if (DEFAULT_SAVE_KINDS.includes(f.kind) && !l.bridge?.isSaved(f)) l.selected.add(f.key);
  const save = async () => {
    const chosen = findings.filter((f) => l.selected.has(f.key));
    await app.act(async () => {
      const r = (await l.bridge?.save(chosen)) ?? [];
      await app.reloadData();
      app.toast(t('rec.saved', { count: r.length }));
      paint(app, l);
    });
  };
  return h(
    'div',
    { class: 'panel rec-summary' },
    h('h2', null, t('rec.summary')),
    h('p', { class: 'muted' }, t('rec.summaryDetail', { words: fmtNum(st.tracker.recitedWords), fixes: fmtNum(st.tracker.selfCorrections) })),
    findings.length
      ? h('ul', { class: 'rec-findings' }, findings.map((f) => findingRow(l, f)))
      : h('p', null, st.tracker.recitedWords ? t('rec.noMistakes') : t('rec.nothingHeard')),
    findings.length
      ? h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', 'data-key': 'rec-save', onclick: () => void save() }, t('rec.save')),
        h('a', { href: '#/mistakes' }, t('rec.review')))
      : null,
  );
}

function findingRow(l: Live, f: Finding): HTMLElement {
  const saved = l.bridge?.isSaved(f) ?? false;
  const box = h('input', { type: 'checkbox', checked: saved || l.selected.has(f.key), disabled: saved, onchange: (e: Event) => ((e.target as HTMLInputElement).checked ? l.selected.add(f.key) : l.selected.delete(f.key)) });
  return h('li', null, h('label', null, box, ' ',
    h('span', { class: `chip rec-kind-${f.kind}` }, t(`rec.st.${f.kind}` as MessageKey)), ' ',
    refLabel(f.ref), ' · ', t('rec.word', { n: fmtNum(f.position) }), ' ',
    h('span', { class: 'rec-token', lang: 'ar', dir: 'rtl' }, f.tokenText), ' ',
    h('span', { class: 'muted' }, `→ ${categoryLabel(categoryFor(f))}`),
    saved ? h('span', { class: 'muted' }, ` (${t('rec.savedOne')})`) : null));
}
