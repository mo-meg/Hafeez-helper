import { DEFAULT_ASR_ENDPOINT, LocalAsrEngine } from '../../browser/localAsrEngine.ts';
import { MicError, startMicrophone, type MicSession } from '../../browser/micCapture.ts';
import { RecitationController, type RecitationState } from '../../core/recitation/controller.ts';
import { RecitationCorpus } from '../../core/recitation/corpus.ts';
import { isLocalEndpoint } from '../../core/recitation/engine.ts';
import { categoryFor, DEFAULT_SAVE_KINDS, RecitationMistakeBridge } from '../../core/recitation/mistakeBridge.ts';
import { RecitationTracker, type Finding, type WordStatus } from '../../core/recitation/tracker.ts';
import { fromIndex } from '../../core/quran/refs.ts';
import type { App } from '../app.ts';
import { arabicDigits, h, replaceChildren, type Child } from '../dom.ts';
import { fmtNum, t, type MessageKey } from '../i18n/index.ts';
import { categoryLabel, errorText, refLabel, surahName } from '../i18n/labels.ts';

const ENDPOINT_KEY = 'recitation.endpoint';

/** Live recitation state kept outside renders (the view may re-render at any time). */
interface Live {
  corpus: RecitationCorpus;
  controller: RecitationController | null;
  mic: MicSession | null;
  state: RecitationState | null;
  bridge: RecitationMistakeBridge | null;
  selected: Set<string>;
  endpoint: string;
  host: HTMLElement | null;
  /** Memorisation mode: words not yet recited are hidden. */
  hide: boolean;
}
let live: Live | null = null;

function ensureLive(app: App): Live | null {
  const text = app.quran.text;
  if (!text) return null;
  if (!live || live.corpus.edition !== text.edition) {
    live = { corpus: new RecitationCorpus(text, app.quran.index), controller: null, mic: null, state: null, bridge: null, selected: new Set(), endpoint: DEFAULT_ASR_ENDPOINT, host: null, hide: false };
    void app.s.store.settings.get<string>(ENDPOINT_KEY).then((v) => {
      if (live && v) live.endpoint = v;
    });
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
  replaceChildren(l.host, controls(app, l, st), st ? locationBar(l, st) : null, st ? textPanel(l, st) : null, legend(), st && (st.status === 'stopped' || st.status === 'error') ? summary(app, l, st) : null, engineSettings(app, l));
}

// ------------------------------------------------------------------ controls
function statusText(st: RecitationState | null): string {
  if (!st) return t('rec.status.idle');
  if (st.status === 'error' && st.error) return t(`rec.err.${st.error.kind}` as MessageKey, { detail: st.error.detail });
  if (st.status === 'listening' && st.paused) return t('rec.status.paused');
  if (st.status === 'listening') return st.silent ? t('rec.status.waiting') : t('rec.status.listening');
  return t(`rec.status.${st.status}` as MessageKey);
}

function controls(app: App, l: Live, st: RecitationState | null): HTMLElement {
  const active = st?.status === 'listening' || st?.status === 'loading' || st?.status === 'stopping';
  return h(
    'div',
    { class: 'panel rec-controls' },
    h('div', { class: 'row' },
      active
        ? h('button', { type: 'button', class: 'primary', 'data-key': 'rec-stop', disabled: st?.status === 'stopping', onclick: () => void stop(app, l) }, t('rec.stop'))
        : h('button', { type: 'button', class: 'primary', 'data-key': 'rec-start', onclick: () => void start(app, l) }, t('rec.start')),
      h('span', { class: `rec-dot ${st?.status === 'listening' ? (st.silent ? 'idle' : 'on') : ''}`, 'aria-hidden': 'true' }),
      h('span', { role: 'status', 'aria-live': 'polite', class: st?.status === 'error' ? 'rec-error' : '' }, statusText(st)),
      st?.status === 'listening'
        ? h('button', { type: 'button', 'data-key': 'rec-pause', 'aria-pressed': String(st.paused), onclick: () => (st.paused ? l.controller?.resume() : l.controller?.pause()) }, st.paused ? t('rec.resume') : t('rec.pause'))
        : null,
      h('button', { type: 'button', 'data-key': 'rec-hide', 'aria-pressed': String(l.hide), onclick: () => { l.hide = !l.hide; paint(app, l); } }, l.hide ? t('rec.show') : t('rec.hide')),
      st && st.backlog > 1 ? h('span', { class: 'muted' }, t('rec.backlog')) : null,
    ),
    st?.heard
      ? h('p', { class: 'rec-heard', 'aria-live': 'off' },
        h('span', { class: 'muted' }, t('rec.heard')), ' ',
        h('span', { lang: 'ar', dir: 'rtl' }, `«${st.heard}»`),
        st.latencyMs !== null ? h('span', { class: 'muted rec-latency', dir: 'ltr' }, ` ${fmtNum(st.latencyMs)} ms`) : null)
      : null,
    h('p', { class: 'muted' }, t('rec.privacy')),
  );
}

async function start(app: App, l: Live): Promise<void> {
  if (!isLocalEndpoint(l.endpoint)) {
    app.toast(t('rec.endpointLocalOnly'), 'error');
    return;
  }
  const tracker = new RecitationTracker(l.corpus);
  const controller = new RecitationController({
    engine: new LocalAsrEngine(l.endpoint),
    tracker,
    onUpdate: (s) => {
      l.state = s;
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
function locationBar(_l: Live, st: RecitationState): HTMLElement {
  const loc = st.tracker.location;
  const mode = st.tracker.mode === 'focused' && loc ? t('rec.mode.focused', { page: loc.page ?? '—' }) : t('rec.mode.searching');
  return h(
    'div',
    { class: 'panel rec-location', 'aria-live': 'polite' },
    h('span', { class: `chip ${st.tracker.mode === 'focused' ? 'status-improved' : 'status-under_review'}` }, mode),
    loc
      ? h('span', null, t('rec.location', { surah: surahName(loc.ref.surah), ayah: fmtNum(loc.ref.ayah), page: loc.page === null ? '—' : fmtNum(loc.page), word: fmtNum(loc.position) }))
      : h('span', { class: 'muted' }, t('rec.reciteAnywhere')),
    h('span', { class: 'muted' }, t('rec.progress', { words: fmtNum(st.tracker.recitedWords), mistakes: fmtNum(st.tracker.findings.filter((f) => f.kind !== 'repeated').length) })),
  );
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
  return h('div', { class: 'legend row', 'aria-label': t('quran.legend') }, items.map((s) => h('span', null, h('span', { class: `rw st-${s} rec-swatch` }, '◼'), ' ', t(`rec.st.${s}` as MessageKey))));
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

// ------------------------------------------------------------------ engine settings
function engineSettings(app: App, l: Live): HTMLElement {
  const input = h('input', { type: 'url', value: l.endpoint, 'aria-label': t('rec.endpoint'), dir: 'ltr' });
  const msg = h('span', { class: 'muted', role: 'status' });
  const saveEndpoint = async () => {
    const v = input.value.trim();
    if (!isLocalEndpoint(v)) {
      msg.textContent = t('rec.endpointLocalOnly');
      return;
    }
    l.endpoint = v;
    await app.s.store.settings.set(ENDPOINT_KEY, v);
    try {
      await new LocalAsrEngine(v).load();
      msg.textContent = t('rec.engineOk');
    } catch (e) {
      msg.textContent = errorText(e);
    }
  };
  return h('details', { class: 'panel' },
    h('summary', null, t('rec.engine')),
    h('p', { class: 'muted' }, t('rec.engineHelp')),
    h('pre', { dir: 'ltr', class: 'rec-cmd' }, 'pip install "nemo_toolkit[asr]"\npython scripts/asr_server.py'),
    h('label', null, t('rec.endpoint'), ' ', input),
    h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => void saveEndpoint() }, t('rec.testEngine')), msg));
}
