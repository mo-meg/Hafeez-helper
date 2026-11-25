import { MicError, startMicrophone, type MicSession } from '../../browser/micCapture.ts';
import { engineErrorText, TajweedFormerEngine } from '../../browser/tajweedEngine.ts';
import { RecitationController, type RecitationState } from '../../core/recitation/controller.ts';
import { RecitationCorpus } from '../../core/recitation/corpus.ts';
import { categoryFor, DEFAULT_SAVE_KINDS, RecitationMistakeBridge } from '../../core/recitation/mistakeBridge.ts';
import { RecitationTracker, trackerConfigFor, type Finding } from '../../core/recitation/tracker.ts';
import { buildUnitCorpus } from '../../core/recitation/unitCorpus.ts';
import type { App } from '../app.ts';
import { h } from '../dom.ts';
import { fmtNum, t, type MessageKey } from '../i18n/index.ts';
import { categoryLabel, errorText, refLabel } from '../i18n/labels.ts';

/**
 * One recitation session shared by the Recitation tracker page and the Quran section's reciting
 * focus mode (one engine per page: the SDK allows one client). Views subscribe for repaints.
 */
export interface RecitationLive {
  /** Canonical words for display (Arabic comparison forms). */
  corpus: RecitationCorpus;
  /** Same words with the model's sound units as comparison forms (built once, after the model loads). */
  unitCorpus: RecitationCorpus | null;
  engine: TajweedFormerEngine;
  controller: RecitationController | null;
  mic: MicSession | null;
  state: RecitationState | null;
  /** Set while the model downloads / the comparison text is prepared, before a controller exists. */
  preparing: boolean;
  /** Model download share (0–1) on the first start, else null. */
  progress: number | null;
  bridge: RecitationMistakeBridge | null;
  selected: Set<string>;
  /** Repaint callbacks of the views showing this session. */
  readonly listeners: Set<() => void>;
  /** Error already shown as a toast (shown once). */
  toasted: string | null;
}

let live: RecitationLive | null = null;

export function ensureLive(app: App): RecitationLive | null {
  const text = app.quran.text;
  if (!text) return null;
  if (!live || live.corpus.edition !== text.edition) {
    live = {
      corpus: new RecitationCorpus(text, app.quran.index),
      unitCorpus: null,
      engine: live?.engine ?? new TajweedFormerEngine(app.deps.quranLabKey ?? ''),
      controller: null, mic: null, state: null, preparing: false, progress: null, bridge: null, selected: new Set(),
      listeners: live?.listeners ?? new Set(), toasted: null,
    };
  }
  return live;
}

function notify(l: RecitationLive): void {
  syncScreenLock(l);
  for (const fn of [...l.listeners]) fn();
}

// ------------------------------------------------------------------ keep the screen on
interface WakeLockSentinelLike {
  release(): Promise<void>;
}
let screenLock: WakeLockSentinelLike | null = null;
let screenLockWanted = false;
let screenLockBusy = false;

/**
 * Keeps the screen on for the whole reciting session (loading, listening, paused), on the
 * Recitation tracker page and in the Quran section alike. The browser drops the lock when the page
 * is hidden; it is taken again when the page becomes visible.
 */
function syncScreenLock(l: RecitationLive): void {
  screenLockWanted = isActive(l) || l.state?.status === 'listening';
  void applyScreenLock();
}

async function applyScreenLock(): Promise<void> {
  if (typeof navigator === 'undefined' || screenLockBusy) return;
  const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
  if (!wl) return;
  screenLockBusy = true;
  let failed = false;
  try {
    if (screenLockWanted && !screenLock && document.visibilityState === 'visible') {
      const s = await wl.request('screen');
      screenLock = s;
      (s as WakeLockSentinelLike & { addEventListener?: (t: string, f: () => void) => void }).addEventListener?.('release', () => {
        if (screenLock === s) screenLock = null;
      });
    } else if (!screenLockWanted && screenLock) {
      const s = screenLock;
      screenLock = null;
      await s.release();
    }
  } catch {
    failed = true; // not allowed (e.g. battery saver) or already released: try again on the next change
  } finally {
    screenLockBusy = false;
  }
  // The wish may have changed while the request was running.
  if (!failed && screenLockWanted !== !!screenLock && !(screenLockWanted && document.visibilityState !== 'visible')) void applyScreenLock();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void applyScreenLock();
  });
}

/** Listening, loading or stopping: the session is in use. */
export function isActive(l: RecitationLive): boolean {
  const st = l.state?.status;
  return l.preparing || st === 'listening' || st === 'loading' || st === 'stopping';
}

/** Short status for the mic button's label/title (the page shows no status line). */
export function statusLabel(l: RecitationLive): string {
  const st = l.state;
  if (l.preparing || st?.status === 'loading') {
    return l.progress !== null && l.progress < 1 ? t('rec.loadingPct', { pct: fmtNum(Math.floor(l.progress * 100)) }) : t('rec.status.loading');
  }
  if (!st) return t('rec.status.idle');
  if (st.status === 'listening' && st.paused) return t('rec.status.paused');
  if (st.status === 'listening') return st.silent ? t('rec.status.waiting') : t('rec.status.listening');
  return t(`rec.status.${st.status}` as MessageKey);
}

/** Errors are shown as toasts (once each). */
function toastError(app: App, l: RecitationLive): void {
  const st = l.state;
  if (st?.status !== 'error' || !st.error) return;
  const msg = t(`rec.err.${st.error.kind}` as MessageKey, { detail: st.error.detail });
  if (l.toasted === msg) return;
  l.toasted = msg;
  app.toast(msg, 'error');
}

export async function startReciting(app: App, l: RecitationLive): Promise<boolean> {
  if (isActive(l)) return true;
  l.toasted = null;
  // First start: download/open the model, then build the sound-unit comparison text once.
  if (!l.unitCorpus) {
    l.state = null;
    l.preparing = true;
    notify(l);
    try {
      await l.engine.load((p) => {
        l.progress = p.bytesTotal > 0 ? p.bytesDone / p.bytesTotal : null;
        notify(l);
      });
      l.progress = null;
      const text = app.quran.text;
      if (!text) throw new Error(t('rec.noText'));
      l.unitCorpus = await buildUnitCorpus(text, app.quran.index, l.engine);
      if (l.unitCorpus.mismatchedAyat.length) console.info(`Recitation tracker: ${l.unitCorpus.mismatchedAyat.length} ayat have a different word count in the model's reference table.`);
    } catch (e) {
      l.preparing = false;
      l.progress = null;
      notify(l);
      app.toast(t('rec.err.model', { detail: engineErrorText(e) }), 'error');
      return false;
    }
    l.preparing = false;
  }
  const tracker = new RecitationTracker(l.unitCorpus, trackerConfigFor(app.prefs.recitationCheck, app.prefs.recitationSensitivity));
  l.engine.speed = app.prefs.recitationSpeed;
  const controller = new RecitationController({
    engine: l.engine,
    tracker,
    onUpdate: (s) => {
      l.state = s;
      if (s.status === 'error') {
        l.mic?.stop();
        l.mic = null;
        toastError(app, l);
      }
      notify(l);
    },
  });
  l.controller = controller;
  l.bridge = new RecitationMistakeBridge(app.s.mistakes, l.corpus.edition, `rec-${app.now().toISOString()}`);
  l.selected = new Set();
  if (!(await controller.start())) return false;
  try {
    l.mic = await startMicrophone((pcm) => controller.feed(pcm), (e) => void controller.interrupt(e.message));
  } catch (e) {
    await controller.interrupt(e instanceof MicError ? t(`rec.mic.${e.kind}` as MessageKey) : errorText(e));
    return false;
  }
  return true;
}

export async function stopReciting(l: RecitationLive): Promise<void> {
  l.mic?.stop();
  l.mic = null;
  await l.controller?.stop();
}

export function togglePause(l: RecitationLive): void {
  const st = l.state;
  if (st?.status !== 'listening') return;
  if (st.paused) l.controller?.resume();
  else l.controller?.pause();
}

// ------------------------------------------------------------------ summary + saving
/** The mistakes found in the finished session, with saving into the mistake list. */
export function summaryPanel(app: App, l: RecitationLive, st: RecitationState, repaint: () => void): HTMLElement {
  const findings = st.tracker.findings;
  if (!l.selected.size) for (const f of findings) if (DEFAULT_SAVE_KINDS.includes(f.kind) && !l.bridge?.isSaved(f)) l.selected.add(f.key);
  const save = async () => {
    const chosen = findings.filter((f) => l.selected.has(f.key));
    await app.act(async () => {
      const r = (await l.bridge?.save(chosen)) ?? [];
      await app.reloadData();
      app.toast(t('rec.saved', { count: r.length }));
      repaint();
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
    // Required by the model's licence (NPL-1.2): say that automatic feedback can be wrong.
    h('p', { class: 'rec-notice' }, t('rec.notice')),
  );
}

function findingRow(l: RecitationLive, f: Finding): HTMLElement {
  const saved = l.bridge?.isSaved(f) ?? false;
  const box = h('input', { type: 'checkbox', checked: saved || l.selected.has(f.key), disabled: saved, onchange: (e: Event) => ((e.target as HTMLInputElement).checked ? l.selected.add(f.key) : l.selected.delete(f.key)) });
  return h('li', null, h('label', null, box, ' ',
    h('span', { class: `chip rec-kind-${f.kind}` }, t(`rec.st.${f.kind}` as MessageKey)), ' ',
    refLabel(f.ref), ' · ', t('rec.word', { n: fmtNum(f.position) }), ' ',
    h('span', { class: 'rec-token', lang: 'ar', dir: 'rtl' }, f.tokenText), ' ',
    h('span', { class: 'muted' }, `→ ${categoryLabel(categoryFor(f))}`),
    saved ? h('span', { class: 'muted' }, ` (${t('rec.savedOne')})`) : null));
}
