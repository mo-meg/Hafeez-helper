import { fromIndex } from '../../core/quran/refs.ts';
import { describeScope, scopeIntervals, type RevisionScope } from '../../core/quran/scope.ts';
import { surahInfo } from '../../core/quran/surahs.ts';
import { buildTestCards, type TestCard } from '../../core/test/testBuilder.ts';
import type { App } from '../app.ts';
import { icon } from '../components/icons.ts';
import { arabicDigits, h, type Child } from '../dom.ts';
import { dir, fmtNum, t, tn } from '../i18n/index.ts';
import { refLabel, scopeLabel, surahName } from '../i18n/labels.ts';

/**
 * "Write from memory": the same mistake ayat as the Test, one card per ayah. The previous ayah is
 * shown clearly as the cue; the whole ayah with the mistake is faint (Hafeez-style ghost text, ayah
 * number clear) and the user writes it over the text with a stylus. There is no handwriting
 * recognition and no grading: Reveal shows the text under the ink to compare. Writing is practice
 * only. It counts as revising the ayah for the day (session evidence) but never changes a
 * mistake's status, schedule or score. The ink lives in memory and is dropped with each card.
 */

interface Stroke {
  /** x, y, width triplets in CSS pixels relative to the writing surface. */
  readonly pts: number[];
}

export interface ActiveWrite {
  readonly sessionId: string;
  readonly scope: RevisionScope;
  /** Stable English label (for records); the UI shows `scopeLabel(scope)`. */
  readonly label: string;
  readonly cards: readonly TestCard[];
  index: number;
  revealed: boolean;
  /** Global indexes of the ayat written (Next after Reveal). */
  readonly written: Set<number>;
  finished: boolean;
  ink: Stroke[];
  tool: 'pen' | 'eraser';
}

export interface WriteOptions {
  readonly includeResolved?: boolean;
  readonly shuffle?: boolean;
}

// ---------------------------------------------------------------- remembered tool settings
const SCALE_KEY = 'writeScale';
const GHOST_KEY = 'writeGhost';
const FINGER_KEY = 'writeFinger';
export const WRITE_SCALE = { min: 1.5, max: 1.9, step: 0.1, default: 1.7 } as const;
export const WRITE_GHOST_MAX = 7;
const wp = { scale: WRITE_SCALE.default as number, ghost: WRITE_GHOST_MAX as number, finger: false, loaded: false };

export const clampWriteScale = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(WRITE_SCALE.max, Math.max(WRITE_SCALE.min, v)) * 10) / 10 : WRITE_SCALE.default;
export const clampWriteGhost = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(WRITE_GHOST_MAX, Math.max(0, v))) : fallback;

async function loadWritePrefs(app: App): Promise<void> {
  if (wp.loaded) return;
  const get = <T>(k: string) => app.s.store.settings.get<T>(k).catch(() => undefined);
  const [scale, ghost, finger] = await Promise.all([get<number>(SCALE_KEY), get<number>(GHOST_KEY), get<boolean>(FINGER_KEY)]);
  wp.scale = clampWriteScale(scale);
  wp.ghost = clampWriteGhost(ghost, app.prefs.hafeezGhost);
  wp.finger = finger === true;
  wp.loaded = true;
}

const saveSetting = (app: App, key: string, value: unknown) => void app.s.store.settings.set(key, value).catch(() => undefined);

// ---------------------------------------------------------------- start / finish
/** Starts writing over the mistake ayat of a portion. Returns false when there is nothing to write. */
export async function startWrite(app: App, scope: RevisionScope, options: WriteOptions = {}): Promise<boolean> {
  const index = app.quran.index;
  const cards = buildTestCards(app.data.mistakes, scopeIntervals(scope, index), {
    includeResolved: options.includeResolved ?? false,
    shuffle: options.shuffle ?? false,
    seed: Date.now() % 100000,
  });
  if (!cards.length || !app.quran.text) return false;
  return app.act(async () => {
    await loadWritePrefs(app);
    const session = await app.s.plans.startSession({
      planId: null, mode: 'write', scope, reciterId: app.prefs.reciterId, repeat: app.prefs.repeat,
      mistakeAyahIndexes: cards.map((c) => c.globalIndex).sort((a, b) => a - b), plannedSteps: cards.length,
    });
    app.write = { sessionId: session.id, scope, label: describeScope(scope, index), cards, index: 0, revealed: false, written: new Set(), finished: false, ink: [], tool: 'pen' };
    await app.refresh();
  });
}

/** From Daily revision: write the portion's mistake ayat now, or open the Test page set to the portion if there are none. */
export async function openWrite(app: App, scope: RevisionScope, setTestPortion: (scope: RevisionScope) => void): Promise<void> {
  if (app.write && !app.write.finished) {
    app.navigate('#/test');
    return;
  }
  app.write = null;
  const started = await startWrite(app, scope);
  if (!started) setTestPortion(scope);
  app.navigate('#/test');
}

async function finish(app: App, w: ActiveWrite) {
  w.finished = true;
  w.ink = [];
  await app.act(() => (w.written.size > 0 ? app.s.plans.completeSession(w.sessionId) : app.s.plans.abandonSession(w.sessionId)));
  await app.refresh();
  window.scrollTo(0, 0);
}

async function advance(app: App, w: ActiveWrite) {
  if (w.index + 1 >= w.cards.length) {
    await finish(app, w);
    return;
  }
  w.index++;
  w.revealed = false;
  w.ink = [];
  w.tool = 'pen';
  await app.refresh();
  document.querySelector<HTMLElement>('.write-card')?.scrollIntoView({ block: 'start' });
}

async function next(app: App, w: ActiveWrite, card: TestCard) {
  const ok = await app.act(async () => {
    await app.s.plans.recordWritten(w.sessionId, card.globalIndex);
    w.written.add(card.globalIndex);
  });
  if (ok) await advance(app, w);
}

// ---------------------------------------------------------------- text
/** One ayah's words, pause marks and its (always clear) end-of-ayah number. */
function ayahNodes(app: App, idx: number, marked: ReadonlySet<number> | null): Child {
  const ayah = app.quran.text?.ayahAt(idx);
  if (!ayah) return null;
  return [
    ayah.tokens.map((tk) =>
      tk.position === null
        ? [h('span', { class: 'pause-mark' }, tk.text), ' ']
        : [h('span', { class: `w${marked?.has(tk.position) ? ' marked' : ''}` }, tk.text), ' ']),
    h('span', { class: 'ayah-end', 'aria-label': refLabel(ayah.ref) }, arabicDigits(ayah.ref.ayah)),
  ];
}

// ---------------------------------------------------------------- ink surface
let redrawInk: (() => void) | null = null;

function inkWidth(e: PointerEvent): number {
  const base = 2.1 * wp.scale;
  return e.pointerType === 'pen' && e.pressure > 0 ? base * (0.55 + 0.9 * e.pressure) : base;
}

/** Transparent canvas over `content`. The stylus (or mouse) draws; a finger scrolls unless finger drawing is on. */
function inkSurface(w: ActiveWrite, content: HTMLElement, label: string): HTMLElement {
  const canvas = h('canvas', { class: `ink${w.tool === 'eraser' ? ' erasing' : ''}`, role: 'img', 'aria-label': label });
  const wrap = h('div', { class: 'write-surface' }, content, canvas);
  const ctx = canvas.getContext('2d');
  let cssW = 0;
  let cssH = 0;

  const color = () => getComputedStyle(canvas).color || '#1b5e4a';
  const segment = (x0: number, y0: number, w0: number, x1: number, y1: number, w1: number) => {
    if (!ctx) return;
    ctx.lineWidth = (w0 + w1) / 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  const prepare = () => {
    if (!ctx) return;
    ctx.strokeStyle = color();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  };
  const drawStroke = (s: Stroke) => {
    if (!ctx) return;
    const p = s.pts;
    if (p.length === 3) {
      ctx.beginPath();
      ctx.arc(p[0] as number, p[1] as number, (p[2] as number) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (let i = 3; i < p.length; i += 3) segment(p[i - 3] as number, p[i - 2] as number, p[i - 1] as number, p[i] as number, p[i + 1] as number, p[i + 2] as number);
  };
  const redraw = () => {
    if (!ctx) return;
    ctx.clearRect(0, 0, cssW, cssH);
    prepare();
    for (const s of w.ink) drawStroke(s);
  };
  const resize = () => {
    const r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    cssW = r.width;
    cssH = r.height;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  };
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (!wrap.isConnected) {
        if (redrawInk === redraw) redrawInk = null;
        return ro.disconnect();
      }
      resize();
    });
    ro.observe(wrap);
  } else {
    requestAnimationFrame(resize);
  }
  redrawInk = redraw;

  // Pointer handling. touch-action is none on the canvas, so the page never scrolls by itself here;
  // in stylus-only mode a finger scrolls the page by hand (and is ignored while the pen writes).
  let drawing: { id: number; stroke: Stroke | null } | null = null;
  let scrolling: { id: number; y: number } | null = null;
  let lastPen = 0;
  const pos = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const draws = (e: PointerEvent) => e.pointerType !== 'touch' || wp.finger;
  const erasing = (e: PointerEvent) => w.tool === 'eraser' || (e.buttons & 32) !== 0;
  const eraseAt = (x: number, y: number) => {
    const r2 = (10 + wp.scale * 4) ** 2;
    const before = w.ink.length;
    w.ink = w.ink.filter((s) => {
      for (let i = 0; i < s.pts.length; i += 3) if (((s.pts[i] as number) - x) ** 2 + ((s.pts[i + 1] as number) - y) ** 2 <= r2) return false;
      return true;
    });
    if (w.ink.length !== before) redraw();
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen') lastPen = Date.now();
    if (!draws(e)) {
      if (!drawing && Date.now() - lastPen > 700) scrolling = { id: e.pointerId, y: e.clientY };
      return;
    }
    if (drawing) return; // one stroke at a time; a resting palm is ignored
    scrolling = null;
    e.preventDefault();
    try {
      canvas.setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic or already released pointer */
    }
    const [x, y] = pos(e);
    if (erasing(e)) {
      drawing = { id: e.pointerId, stroke: null };
      eraseAt(x, y);
      return;
    }
    const stroke: Stroke = { pts: [x, y, inkWidth(e)] };
    w.ink.push(stroke);
    drawing = { id: e.pointerId, stroke };
    prepare();
    drawStroke(stroke);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (scrolling && e.pointerId === scrolling.id) {
      if (drawing) {
        scrolling = null;
        return;
      }
      window.scrollBy(0, scrolling.y - e.clientY);
      scrolling.y = e.clientY;
      return;
    }
    if (!drawing || e.pointerId !== drawing.id) return;
    if (e.pointerType === 'pen') lastPen = Date.now();
    e.preventDefault();
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ce of events.length ? events : [e]) {
      const [x, y] = pos(ce);
      const s = drawing.stroke;
      if (!s) {
        eraseAt(x, y);
        continue;
      }
      const n = s.pts.length;
      const px = s.pts[n - 3] as number;
      const py = s.pts[n - 2] as number;
      if ((x - px) ** 2 + (y - py) ** 2 < 0.5) continue;
      const wd = inkWidth(ce);
      s.pts.push(x, y, wd);
      segment(px, py, s.pts[n - 1] as number, x, y, wd);
    }
  });
  const end = (e: PointerEvent) => {
    if (scrolling && e.pointerId === scrolling.id) scrolling = null;
    if (drawing && e.pointerId === drawing.id) drawing = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', end);
  return wrap;
}

// ---------------------------------------------------------------- toolbar
function toolbar(app: App, w: ActiveWrite): HTMLElement {
  const pct = (v: number) => `${fmtNum(Math.round(v * 100))}%`;
  const sizeOut = h('output', { class: 'write-val' }, pct(wp.scale));
  const ghostOut = h('output', { class: 'write-val' }, `${fmtNum(wp.ghost)}%`);
  const card = () => document.querySelector<HTMLElement>('.write-card');
  const toolBtn = (key: string, name: string, label: string, pressed: boolean | null, onclick: (e: Event) => void) =>
    h('button', { type: 'button', class: 'icon', 'data-key': key, title: label, 'aria-label': label, ...(pressed === null ? {} : { 'aria-pressed': String(pressed) }), onclick }, icon(name));
  const setTool = (tool: 'pen' | 'eraser') => {
    w.tool = tool;
    for (const b of document.querySelectorAll<HTMLElement>('[data-key="write-pen"], [data-key="write-eraser"]')) b.setAttribute('aria-pressed', String(b.dataset.key === `write-${tool}`));
    document.querySelector('.write-surface canvas')?.classList.toggle('erasing', tool === 'eraser');
  };
  const fingerLabel = () => (wp.finger ? t('write.fingerOn') : t('write.fingerOff'));
  return h(
    'div',
    { class: 'write-toolbar', role: 'toolbar', 'aria-label': t('write.toolbar') },
    h('label', { class: 'write-range' }, h('span', null, t('write.size')),
      h('input', {
        type: 'range', 'data-key': 'write-size', min: String(WRITE_SCALE.min * 100), max: String(WRITE_SCALE.max * 100), step: String(WRITE_SCALE.step * 100), value: String(Math.round(wp.scale * 100)),
        oninput: (e: Event) => { wp.scale = clampWriteScale(Number((e.target as HTMLInputElement).value) / 100); sizeOut.textContent = pct(wp.scale); card()?.style.setProperty('--write-scale', String(wp.scale)); },
        onchange: () => saveSetting(app, SCALE_KEY, wp.scale),
      }), sizeOut),
    h('label', { class: 'write-range' }, h('span', null, t('write.ghost')),
      h('input', {
        type: 'range', 'data-key': 'write-ghost', min: '0', max: String(WRITE_GHOST_MAX), step: '1', value: String(wp.ghost),
        oninput: (e: Event) => { wp.ghost = clampWriteGhost(Number((e.target as HTMLInputElement).value), wp.ghost); ghostOut.textContent = `${fmtNum(wp.ghost)}%`; card()?.style.setProperty('--write-ghost', `${wp.ghost}%`); },
        onchange: () => saveSetting(app, GHOST_KEY, wp.ghost),
      }), ghostOut),
    h('div', { class: 'write-tools' },
      toolBtn('write-pen', 'pen', t('write.pen'), w.tool === 'pen', () => setTool('pen')),
      toolBtn('write-eraser', 'eraser', t('write.eraser'), w.tool === 'eraser', () => setTool('eraser')),
      toolBtn('write-undo', 'undo', t('write.undo'), null, () => { w.ink.pop(); redrawInk?.(); }),
      toolBtn('write-clear', 'trash', t('write.clear'), null, () => { w.ink = []; redrawInk?.(); }),
      toolBtn('write-finger', 'finger', fingerLabel(), wp.finger, (e: Event) => {
        wp.finger = !wp.finger;
        saveSetting(app, FINGER_KEY, wp.finger);
        const b = e.currentTarget as HTMLElement;
        b.setAttribute('aria-pressed', String(wp.finger));
        b.title = fingerLabel();
        b.setAttribute('aria-label', fingerLabel());
        app.toast(fingerLabel());
      }),
    ),
  );
}

// ---------------------------------------------------------------- views
function cardView(app: App, w: ActiveWrite): Node {
  const card = w.cards[w.index] as TestCard;
  const info = surahInfo(card.ref.surah);
  const prompt = card.promptIndex !== null ? fromIndex(card.promptIndex) : null;
  const target = app.quran.text?.ayahAt(card.globalIndex);
  const crossesSurah = prompt !== null && prompt.surah !== card.ref.surah;
  const last = w.index + 1 >= w.cards.length;
  const text = h('div', { class: 'quran', lang: 'ar', dir: 'rtl' }, ayahNodes(app, card.globalIndex, w.revealed ? new Set(card.markedPositions) : null));
  return h(
    'div',
    null,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, t('write.title', { label: scopeLabel(w.scope, app.quran.index) })), h('p', { class: 'muted' }, t('write.pos', { n: w.index + 1, total: w.cards.length }), t('write.writtenCount', { count: w.written.size }))),
      h('button', { type: 'button', 'data-key': 'write-end', onclick: () => void finish(app, w) }, t('write.end'))),
    h('div', { class: 'progress-track', role: 'progressbar', 'aria-label': t('write.progress'), 'aria-valuemin': '0', 'aria-valuemax': String(w.cards.length), 'aria-valuenow': String(w.index) }, h('span', { style: { width: `${Math.round((100 * w.index) / w.cards.length)}%` } })),
    h(
      'section',
      { class: 'panel test-card write-card', style: { '--write-scale': String(wp.scale), '--write-ghost': `${wp.ghost}%` } },
      toolbar(app, w),
      h('p', { class: 'muted', 'aria-live': 'polite' }, w.revealed ? t('write.instructionRevealed') : t('write.instruction')),
      prompt
        ? h('div', { class: 'test-prompt', 'aria-label': t('test.prevAyah') }, h('small', { class: 'muted' }, refLabel(prompt)), h('div', { class: 'quran', lang: 'ar', dir: 'rtl' }, ayahNodes(app, card.promptIndex as number, null)))
        : h('p', { class: 'muted' }, t('test.firstAyah')),
      crossesSurah || card.ref.ayah === 1
        ? h('div', { class: 'surah-head', dir: dir() }, h('span', { class: 'ar', lang: 'ar', dir: 'rtl' }, `سورة ${info.nameArabic}`), h('span', { class: 'tr' }, `${info.number}. ${surahName(info.number)}`))
        : null,
      target?.basmalaPrefix ? h('div', { class: 'basmala' }, target.basmalaPrefix) : null,
      h('div', { class: `test-target write-target${w.revealed ? ' revealed' : ''}` },
        h('small', { class: 'muted' }, refLabel(card.ref)),
        inkSurface(w, text, t('write.surface', { ref: refLabel(card.ref) }))),
      h(
        'div',
        { class: 'controls' },
        w.revealed
          ? [
              h('button', { type: 'button', class: 'primary', 'data-key': 'write-next', onclick: () => void next(app, w, card) }, last ? t('write.finish') : t('write.next')),
              h('button', { type: 'button', 'data-key': 'write-again', onclick: () => { w.revealed = false; w.ink = []; app.render(true); } }, t('write.again')),
            ]
          : [
              h('button', { type: 'button', class: 'primary', 'data-key': 'write-reveal', onclick: () => { w.revealed = true; app.render(true); document.querySelector<HTMLElement>('[data-key="write-next"]')?.focus({ preventScroll: true }); } }, t('write.reveal')),
              h('button', { type: 'button', class: 'quiet', 'data-key': 'write-skip', onclick: () => void advance(app, w) }, t('write.skip')),
            ],
      ),
    ),
  );
}

function summaryView(app: App, w: ActiveWrite, onTest: (scope: RevisionScope) => void): Node {
  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('write.finished', { label: scopeLabel(w.scope, app.quran.index) })), h('p', { class: 'muted' }, t('write.finishedDetail', { written: w.written.size, total: tn('test.ayatToTest', w.cards.length) })))),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, t('common.ayah')), h('th', null, t('write.status')))),
        h('tbody', null, w.cards.map((c) => h('tr', null, h('td', null, h('a', { href: `#/quran?surah=${c.ref.surah}&focus=${c.globalIndex}` }, refLabel(c.ref))), h('td', null, w.written.has(c.globalIndex) ? t('write.statusWritten') : t('write.statusSkipped'))))))),
      h('div', { class: 'row', style: { 'margin-top': '1rem' } },
        h('button', { type: 'button', class: 'primary', 'data-key': 'write-test', onclick: () => { const scope = w.scope; app.write = null; onTest(scope); app.render(false); } }, t('write.testThese')),
        h('button', { type: 'button', 'data-key': 'write-new', onclick: () => { app.write = null; app.render(false); } }, t('write.new'))),
    ),
  );
}

export function writeView(app: App, w: ActiveWrite, onTest: (scope: RevisionScope) => void): Node {
  if (w.finished) return summaryView(app, w, onTest);
  return cardView(app, w);
}
