/**
 * Auto-scroll focus mode for the Quran reader.
 *
 * Smoothness: while playing, the page is NOT scrolled frame by frame. Scroll positions are
 * rounded to whole pixels, so slow speeds (under one pixel per frame) moved 0,1,1,0,1… pixels
 * and visibly stuttered, and any main-thread work (saving the position, sync, GC) dropped frames
 * on long surahs. Instead <main> glides with a linear Web Animation of `transform`, which runs on
 * the compositor with sub-pixel precision; speed changes only change its playback rate. Pausing,
 * the ⏪ button, manual scrolling or a resize "commit" the glide back into a real scroll
 * position, so taps, the saved reading position and native scrolling keep working.
 *
 * The control bar lives on <body>, outside <main>, and survives re-renders and route changes within
 * the Quran section. Leaving the Quran section or pressing X / Esc ends it.
 *
 * Reciting focus mode ('voice', started from the floating mic button) shares the bar, Hafeez mode,
 * swipes and portions, but has no speed: the page follows the reciter's voice. The Recitation
 * tracker colours the words in place, the page scrolls so the current word stays at a comfortable
 * height, and it moves on to the next portion by itself when the reciter carries on past its end.
 * Exit (X / Esc) stops listening and shows the session summary.
 *
 * Focus mode deliberately does NOT request browser full screen: Chrome always shows a
 * "To exit full screen…" notice when a page enters full screen, which covered the text at start.
 * Hiding the app chrome (FOCUS_CLASS) is enough.
 */
import { clampSpeed, minutesLeft, pxPerSecond, SPEED_DEFAULT, SPEED_MAX, SPEED_MIN } from '../../core/reading/autoScroll.ts';
import type { WordStatus } from '../../core/recitation/tracker.ts';
import type { App } from '../app.ts';
import { h, replaceChildren } from '../dom.ts';
import { fmtNum, t, tn } from '../i18n/index.ts';
import { openDialog } from './dialog.ts';
import { icon } from './icons.ts';
import { ensureLive, isActive, startReciting, statusLabel, stopReciting, summaryPanel, togglePause, type RecitationLive } from './reciteSession.ts';

const SPEED_KEY = 'autoScrollSpeed';
const HAFEEZ_KEY = 'autoScrollHafeez';
const FOCUS_CLASS = 'focus-reading';
/** Pause before scrolling resumes after moving to the next portion (lets the reader see the heading). */
const RESUME_DELAY_MS = 1500;
/** Speed eases in over this time on start and resume, so motion never begins with a jolt. */
const RAMP_MS = 700;
/** After the reader scrolls by hand while playing, gliding resumes once they stop for this long. */
const MANUAL_IDLE_MS = 900;
/** Status text refresh interval (reads only cached values, never layout). */
const STATUS_MS = 500;

const smoothstep = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** The ayah at the top of the viewport and its offset, to keep the reader's place across layout changes. */
function captureAnchor(): { el: Element; top: number } | null {
  const x = window.innerWidth / 2;
  for (const y of [8, 40, 90]) {
    const el = document.elementFromPoint(x, y)?.closest('.quran [data-idx], .ref-only [data-idx]');
    if (el) return { el, top: el.getBoundingClientRect().top };
  }
  return null;
}

function restoreAnchor(a: { el: Element; top: number } | null): void {
  if (!a || !a.el.isConnected) return;
  const delta = a.el.getBoundingClientRect().top - a.top;
  if (Math.abs(delta) >= 1) window.scrollTo(0, window.scrollY + delta);
}

/** What the Quran view tells the controller about the portion on screen. */
export interface PortionInfo {
  readonly label: string;
  /** First and last ayah index of the portion (reciting mode: when to move on). */
  readonly start?: number;
  readonly end?: number;
  readonly next: { readonly hash: string; readonly label: string } | null;
  readonly prev?: { readonly hash: string; readonly label: string } | null;
}

interface WakeLockLike { release(): Promise<void> }

/** 'timed': classic auto scroll at a set speed. 'voice': reciting focus mode, the page follows the voice. */
export type ScrollMode = 'timed' | 'voice';
/** Reciting mode: the current word is kept between these fractions of the viewport height. */
const FOLLOW_BAND: readonly [number, number] = [0.2, 0.55];
const FOLLOW_AT = 0.38;
/** After the reader scrolls by hand, following the voice waits this long. */
const FOLLOW_IDLE_MS = 2500;
const RS_CLASSES = ['rs-correct', 'rs-incorrect', 'rs-skipped', 'rs-hesitation'];

/**
 * Hafeez (memorization) mode: the lower half of the screen shows only faint "ghost" words, so the
 * reader recites what comes next from memory; each line appears as it crosses the middle.
 * 'hint' additionally keeps the first word of every ayah visible.
 */
export type HafeezMode = 'off' | 'half' | 'hint' | 'all';
const HAFEEZ_NEXT: Record<HafeezMode, HafeezMode> = { off: 'half', half: 'hint', hint: 'off', all: 'off' };
/**
 * Reciting focus mode has only two states: everything shown, or 'all' — every word not yet
 * recited is a faint ghost and appears as the tracker hears it (no lower-half boundary).
 */
const VOICE_HAFEEZ_KEY = 'voiceHafeez';
const HIDDEN = 'hz-h';

/** One visual line of Quran text: its vertical centre in document coordinates and its words. */
interface HzLine {
  readonly y: number;
  readonly els: readonly HTMLElement[];
}

/** An active compositor glide: `<main>` translated up from the real scroll position `base`. */
interface Glide {
  readonly anim: Animation;
  readonly el: HTMLElement;
  readonly base: number;
}

export class AutoScrollSession {
  speed: number;
  paused = false;
  private readonly app: App;
  private readonly bar: HTMLElement;
  private readonly status: HTMLElement;
  private readonly toggleBtn: HTMLButtonElement;
  private portion: PortionInfo | null = null;
  private glide: Glide | null = null;
  private rampRaf = 0;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private manualTimer: ReturnType<typeof setTimeout> | null = null;
  private touching = false;
  /** Glide stopped because the tab was hidden; restarts when visible again. */
  private suspended = false;
  private endPrompted = false;
  hafeez: HafeezMode = 'off';
  private readonly hafeezBtn: HTMLButtonElement;
  /** Lines sorted top to bottom; lines [0, hzShown) are revealed. */
  private hzLines: HzLine[] = [];
  private hzShown = 0;
  private hzRaf = 0;
  private hzLine: HTMLElement | null = null;
  /** Distance from the top of the viewport to the hide boundary (middle of the reading area). */
  private boundary = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeLock: WakeLockLike | null = null;
  private stopped = false;
  /** True until the focus-mode layout has settled after start; nothing scrolls meanwhile. */
  private warming = true;
  /** Cached document height; refreshed on resize/content changes instead of on every frame. */
  private maxScroll = 0;
  private resizeObs: ResizeObserver | null = null;
  private readonly onResize = () => {
    this.measure();
    if (this.hafeez !== 'off') this.hzBuild();
    // The distance left changed (rotation, browser bars): re-plan the glide from here.
    if (this.glide) {
      this.commit();
      this.startGlide(false);
    }
  };
  private readonly onScroll = () => {
    if (this.glide && Math.abs(window.scrollY - this.glide.base) > 1) this.manual(); // keyboard/scrollbar
    else if (this.manualTimer) this.scheduleManualResume();
  };
  private readonly onWheel = () => this.manual();
  private readonly onTouchMove = () => {
    this.touching = true;
    this.manual();
  };
  private readonly onTouchEnd = () => {
    if (!this.touching) return;
    this.touching = false;
    if (this.manualTimer) this.scheduleManualResume();
  };
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);
  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      // The animation timeline keeps running in a background tab: do not jump ahead meanwhile.
      if (this.glide) {
        this.commit();
        this.suspended = true;
      }
    } else if (!this.paused) {
      void this.lockScreen();
      if (this.suspended) {
        this.suspended = false;
        this.startGlide(true);
      }
    }
  };

  readonly mode: ScrollMode;
  /** Reciting mode: the shared recitation session and its repaint hook. */
  private live: RecitationLive | null = null;
  private readonly onLive = () => this.liveUpdate();
  /** Reciting mode: Quran words on screen by "ayahIndex:position". */
  private wordEls = new Map<string, HTMLElement>();
  /** Reciting mode: classes applied to words, to update only what changed. */
  private painted = new Map<HTMLElement, string>();
  private curEl: HTMLElement | null = null;
  private lastFollowed = -1;
  private manualAt = 0;
  /** Reciting mode: a move to another portion is under way (wait for its render). */
  private advancing = false;

  private constructor(app: App, speed: number, mode: ScrollMode = 'timed') {
    this.app = app;
    this.mode = mode;
    this.speed = clampSpeed(speed);
    this.status = h('span', { class: 'as-status', 'aria-live': 'off' });
    this.hafeezBtn = h('button', { type: 'button', class: 'icon', 'data-key': 'as-hafeez', onclick: () => this.cycleHafeez() });
    this.toggleBtn = h('button', { type: 'button', class: 'icon', 'data-key': 'as-toggle', onclick: () => this.toggle() });
    const btn = (key: string, label: string, ic: string, fn: () => void) =>
      h('button', { type: 'button', class: 'icon', 'data-key': key, 'aria-label': label, title: label, onclick: fn }, icon(ic));
    this.bar = mode === 'voice'
      ? h(
        'div',
        { class: 'autoscroll-bar voice', role: 'toolbar', 'aria-label': t('voice.bar') },
        this.toggleBtn,
        btn('as-prev', t('voice.prev'), 'prev', () => this.stepPortion(-1)),
        this.status,
        btn('as-next', t('voice.next'), 'next', () => this.stepPortion(1)),
        this.hafeezBtn,
        btn('as-close', t('voice.close'), 'close', () => this.stop()),
      )
      : h(
        'div',
        { class: 'autoscroll-bar', role: 'toolbar', 'aria-label': t('auto.bar') },
        this.toggleBtn,
        btn('as-back', t('auto.back'), 'rewind', () => this.back()),
        btn('as-slower', t('auto.slower'), 'minus', () => this.setSpeed(this.speed - 1)),
        this.status,
        btn('as-faster', t('auto.faster'), 'plus', () => this.setSpeed(this.speed + 1)),
        this.hafeezBtn,
        btn('as-close', t('auto.close'), 'close', () => this.stop()),
      );
  }

  /**
   * Starts reciting focus mode (the floating mic button): focus layout, listening starts at once,
   * and the page follows the recitation.
   */
  static startVoice(app: App, portion: PortionInfo): AutoScrollSession | null {
    const l = ensureLive(app);
    if (!l) {
      app.toast(t('rec.noText'), 'error');
      return null;
    }
    app.autoScroll?.stop();
    const session = new AutoScrollSession(app, SPEED_DEFAULT, 'voice');
    app.autoScroll = session;
    session.portion = portion;
    session.live = l;
    const anchor = captureAnchor();
    document.body.classList.add(FOCUS_CLASS, 'reciting');
    document.body.append(session.bar);
    restoreAnchor(anchor);
    document.addEventListener('keydown', session.onKey);
    window.addEventListener('resize', session.onResize);
    window.addEventListener('wheel', session.onWheel, { passive: true });
    window.addEventListener('touchmove', session.onTouchMove, { passive: true });
    window.addEventListener('touchend', session.onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', session.onTouchEnd, { passive: true });
    session.measure();
    session.warming = false;
    session.collectWords();
    l.listeners.add(session.onLive);
    session.render();
    session.toggleBtn.focus({ preventScroll: true });
    void app.s.store.settings.get<HafeezMode>(VOICE_HAFEEZ_KEY).then((v) => {
      if (v === 'all' && !session.stopped && session.hafeez === 'off') session.setHafeez('all', false);
    }).catch(() => undefined);
    app.toast(t('voice.hint'));
    void startReciting(app, l).then((ok) => {
      if (!ok && !session.stopped) session.render();
    });
    return session;
  }

  /** Starts focus mode from the current scroll position (called from a click handler). */
  static start(app: App, portion: PortionInfo): AutoScrollSession {
    app.autoScroll?.stop();
    const session = new AutoScrollSession(app, SPEED_DEFAULT);
    app.autoScroll = session;
    session.portion = portion;
    // Hide the app chrome without losing the reader's place: the ayah at the top stays put.
    const anchor = captureAnchor();
    document.body.classList.add(FOCUS_CLASS);
    document.body.append(session.bar);
    restoreAnchor(anchor);
    document.addEventListener('keydown', session.onKey);
    document.addEventListener('visibilitychange', session.onVisibility);
    window.addEventListener('resize', session.onResize);
    window.addEventListener('scroll', session.onScroll, { passive: true });
    window.addEventListener('wheel', session.onWheel, { passive: true });
    window.addEventListener('touchmove', session.onTouchMove, { passive: true });
    window.addEventListener('touchend', session.onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', session.onTouchEnd, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      session.resizeObs = new ResizeObserver(session.onResize);
      session.resizeObs.observe(document.body);
    }
    session.measure();
    session.render();
    session.statusTimer = setInterval(() => session.renderStatus(), STATUS_MS);
    session.toggleBtn.focus({ preventScroll: true });
    // Start moving only once the new layout is done (two frames later),
    // so the first frames are not competing with a page-wide re-layout.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (session.stopped) return;
      restoreAnchor(anchor);
      session.warming = false;
      if (!session.paused) session.startGlide(true);
    }));
    void session.lockScreen();
    // Restore the reader's preferred speed (kept on this device, like the reading position).
    void app.s.store.settings.get<number>(SPEED_KEY).then((v) => {
      if (v !== undefined && v !== null && !session.stopped) {
        session.speed = clampSpeed(v);
        session.render();
      }
    }).catch(() => undefined);
    void app.s.store.settings.get<HafeezMode>(HAFEEZ_KEY).then((v) => {
      if ((v === 'half' || v === 'hint') && !session.stopped && session.hafeez === 'off') session.setHafeez(v, false);
    }).catch(() => undefined);
    app.toast(t('auto.tapHint'));
    return session;
  }

  /** Called by the Quran view on every render with the portion now on screen. */
  setPortion(p: PortionInfo): void {
    this.portion = p;
    this.endPrompted = false;
    if (this.mode === 'voice') {
      this.advancing = false;
      // The text was re-rendered: find the new word elements and paint them again.
      requestAnimationFrame(() => {
        if (this.stopped) return;
        this.collectWords();
        this.measure();
        this.liveUpdate();
      });
      return;
    }
    queueMicrotask(() => this.measure());
    // The text was re-rendered: re-measure the lines once the new layout exists.
    if (this.hafeez !== 'off') requestAnimationFrame(() => this.hzBuild());
  }

  /** The eye button: off → lower half hidden → first words shown → off (reciting: off ↔ all hidden). */
  cycleHafeez(): void {
    this.setHafeez(this.mode === 'voice' ? (this.hafeez === 'off' ? 'all' : 'off') : HAFEEZ_NEXT[this.hafeez], true);
  }

  setHafeez(mode: HafeezMode, announce: boolean): void {
    if (this.stopped) return;
    if (this.mode === 'voice' && mode !== 'off') mode = 'all';
    if (this.mode !== 'voice' && mode === 'all') mode = 'half';
    this.hafeez = mode;
    const body = document.body.classList;
    if (this.mode === 'voice') {
      body.toggle('hafeez-all', mode === 'all');
      this.render();
      if (announce) {
        this.app.toast(t(mode === 'all' ? 'voice.hafeezAllToast' : 'auto.hafeezOffToast'));
        void this.app.s.store.settings.set(VOICE_HAFEEZ_KEY, mode).catch(() => undefined);
      }
      return;
    }
    body.toggle('hafeez-hide', mode !== 'off');
    body.toggle('hafeez-hint', mode === 'hint');
    this.measure(); // the extra bottom padding changes the scrollable height
    if (mode === 'off') this.hzClear();
    else if (!this.hzLines.length) this.hzBuild();
    this.render();
    if (announce) {
      this.app.toast(t(mode === 'off' ? 'auto.hafeezOffToast' : mode === 'half' ? 'auto.hafeezHalfToast' : 'auto.hafeezHintToast'));
      void this.app.s.store.settings.set(HAFEEZ_KEY, mode).catch(() => undefined);
    }
  }

  /** Swipe navigation inside focus mode: moves to another portion and keeps playing if it was playing. */
  goToPortion(hash: string): void {
    if (this.stopped) return;
    if (this.mode === 'voice') {
      // Listening carries on; the new portion is painted when it renders.
      this.advancing = true;
      this.lastFollowed = -1;
      this.app.navigate(hash);
      return;
    }
    const wasPlaying = !this.paused;
    this.clearResumeTimer();
    this.clearManualTimer();
    this.commit();
    this.paused = true;
    this.endPrompted = false;
    this.app.navigate(hash);
    this.render();
    if (wasPlaying) {
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = null;
        if (!this.stopped) this.resume();
      }, RESUME_DELAY_MS);
    }
  }

  /** Still waiting for layout to settle after start (no scrolling yet). */
  get starting(): boolean {
    return this.warming && !this.stopped;
  }

  get active(): boolean {
    return !this.stopped;
  }

  toggle(): void {
    if (this.mode === 'voice') {
      const l = this.live;
      if (!l) return;
      if (l.state?.status === 'listening') togglePause(l);
      else if (!isActive(l)) void startReciting(this.app, l);
      this.render();
      return;
    }
    if (this.paused) this.resume();
    else this.pause();
  }

  pause(): void {
    this.clearResumeTimer();
    this.clearManualTimer();
    this.commit();
    this.paused = true;
    void this.releaseLock();
    this.render();
  }

  resume(): void {
    this.clearResumeTimer();
    this.measure();
    if (this.atEnd()) {
      this.promptEnd();
      return;
    }
    this.paused = false;
    void this.lockScreen();
    this.render();
    if (!this.warming) this.startGlide(true);
  }

  setSpeed(level: number): void {
    this.speed = clampSpeed(level);
    // A running glide just changes its rate (the ramp reads the new rate on its next frame).
    const g = this.glide;
    if (g && !this.rampRaf) {
      if (typeof g.anim.updatePlaybackRate === 'function') g.anim.updatePlaybackRate(this.rate());
      else g.anim.playbackRate = this.rate();
    }
    this.render();
    void this.app.s.store.settings.set(SPEED_KEY, this.speed).catch(() => undefined);
  }

  /** Jumps back about a third of a screen (the ⏪ button). */
  back(): void {
    const playing = !!this.glide;
    this.commit();
    window.scrollTo(0, Math.max(0, window.scrollY - window.innerHeight / 3));
    this.endPrompted = false;
    if (playing) this.startGlide(true);
    this.render();
  }

  stop(): void {
    if (this.stopped) return;
    this.commit();
    this.stopped = true;
    if (this.mode === 'voice') this.endReciting();
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.clearResumeTimer();
    this.clearManualTimer();
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('touchmove', this.onTouchMove);
    window.removeEventListener('touchend', this.onTouchEnd);
    window.removeEventListener('touchcancel', this.onTouchEnd);
    this.resizeObs?.disconnect();
    this.hzClear();
    document.body.classList.remove('hafeez-hide', 'hafeez-hint', 'hafeez-all');
    this.bar.remove();
    document.body.classList.remove(FOCUS_CLASS);
    void this.releaseLock();
    if (this.app.autoScroll === this) this.app.autoScroll = null;
    // Words marked during focus mode were updated in place; re-render so every view is consistent.
    if (this.app.route.name === 'quran') void this.app.refresh();
  }

  // ------------------------------------------------------------------ internals
  /** Playback rate of the glide: its timeline runs at 1 px per millisecond. */
  private rate(): number {
    return pxPerSecond(this.speed, this.app.prefs.fontScale) / 1000;
  }

  /** Starts gliding from the current scroll position to the end of the page. */
  private startGlide(ramp: boolean): void {
    if (this.mode === 'voice' || this.glide || this.stopped || this.paused) return;
    const el = document.getElementById('main');
    this.measure();
    const base = window.scrollY;
    const dist = this.maxScroll - base;
    if (dist <= 2 || !el || typeof el.animate !== 'function') {
      if (dist <= 2) this.reachEnd();
      return;
    }
    el.style.willChange = 'transform';
    const anim = el.animate(
      [{ transform: 'translate3d(0, 0, 0)' }, { transform: `translate3d(0, ${-dist}px, 0)` }],
      { duration: dist, easing: 'linear', fill: 'forwards' },
    );
    const glide: Glide = { anim, el, base };
    this.glide = glide;
    anim.onfinish = () => {
      if (this.glide !== glide) return;
      this.reachEnd();
    };
    if (!ramp) {
      anim.playbackRate = this.rate();
      return;
    }
    // Ease in: raise the rate over RAMP_MS (a few main-thread frames only, then it is all compositor).
    anim.playbackRate = 0;
    let from = 0;
    const step = (ts: number) => {
      if (this.glide !== glide) return;
      if (!from) from = ts;
      const k = smoothstep((ts - from) / RAMP_MS);
      anim.playbackRate = Math.max(k, 0.02) * this.rate();
      if (k < 1) this.rampRaf = requestAnimationFrame(step);
      else this.rampRaf = 0;
    };
    this.rampRaf = requestAnimationFrame(step);
  }

  /** Converts the glide into a real scroll position (same place on screen) and stops it. */
  private commit(): void {
    const g = this.glide;
    if (!g) return;
    const off = this.glideOffset();
    this.glide = null;
    cancelAnimationFrame(this.rampRaf);
    this.rampRaf = 0;
    g.anim.onfinish = null;
    // Both happen before the next paint, so the text does not move.
    g.anim.cancel();
    g.el.style.willChange = '';
    window.scrollTo(0, g.base + off);
  }

  private glideOffset(): number {
    const g = this.glide;
    if (!g) return 0;
    const ct = Number(g.anim.currentTime ?? 0);
    return Number.isFinite(ct) ? Math.max(0, ct) : 0;
  }

  private reachEnd(): void {
    this.commit();
    if (!this.paused) this.pause();
    this.promptEnd();
  }

  /** The reader is scrolling by hand: hand control back, then glide on once they stop. */
  private manual(): void {
    if (this.mode === 'voice') {
      this.manualAt = Date.now(); // following the voice waits while the reader looks around
      return;
    }
    if (this.paused || this.stopped || this.warming) return;
    if (this.glide) this.commit();
    this.scheduleManualResume();
  }

  private scheduleManualResume(): void {
    this.clearManualTimer();
    this.manualTimer = setTimeout(() => {
      this.manualTimer = null;
      if (this.touching) return this.scheduleManualResume();
      if (!this.paused && !this.stopped) {
        this.endPrompted = false;
        this.startGlide(true);
      }
    }, MANUAL_IDLE_MS);
  }

  private clearManualTimer(): void {
    if (this.manualTimer) clearTimeout(this.manualTimer);
    this.manualTimer = null;
  }

  /**
   * Measures every word line once (one layout read), hides the ones below the boundary and starts
   * the reveal loop. Each frame then only compares the reading position with the next line's
   * position, so revealing costs almost nothing and never competes with the glide.
   */
  private hzBuild(): void {
    if (this.stopped || this.hafeez === 'off' || this.hafeez === 'all') return;
    for (const l of this.hzLines) for (const el of l.els) el.classList.remove(HIDDEN);
    this.hzLines = [];
    this.hzShown = 0;
    const els = [...document.querySelectorAll<HTMLElement>('#main .quran .w, #main .quran .pause-mark')];
    const origin = window.scrollY + this.glideOffset(); // document y = viewport y + this (glide included)
    const items = els.map((el) => {
      const r = el.getBoundingClientRect();
      return { el, y: r.top + r.height / 2 + origin };
    }).sort((a, b) => a.y - b.y);
    const lines: Array<{ y: number; els: HTMLElement[] }> = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && it.y - last.y < 6) last.els.push(it.el);
      else lines.push({ y: it.y, els: [it.el] });
    }
    for (const l of lines) for (const el of l.els) el.classList.add(HIDDEN);
    this.hzLines = lines;
    this.boundary = Math.max(80, (window.innerHeight - this.bar.offsetHeight) / 2);
    if (!this.hzLine) {
      this.hzLine = h('div', { class: 'hafeez-line', 'aria-hidden': 'true' });
      document.body.append(this.hzLine);
    }
    this.hzLine.style.top = `${Math.round(this.boundary)}px`;
    cancelAnimationFrame(this.hzRaf);
    const loop = () => {
      this.hzUpdate();
      this.hzRaf = requestAnimationFrame(loop);
    };
    loop();
  }

  /** Reveals lines that rose above the boundary and re-hides lines that went back below it. */
  private hzUpdate(): void {
    const lines = this.hzLines;
    // At the very end of the page nothing can scroll further: reveal everything that is left.
    const threshold = this.maxScroll > 0 && this.atEnd() ? Infinity : this.position() + this.boundary;
    let k = this.hzShown;
    while (k < lines.length && (lines[k] as HzLine).y < threshold) {
      for (const el of (lines[k] as HzLine).els) el.classList.remove(HIDDEN);
      k++;
    }
    while (k > 0 && (lines[k - 1] as HzLine).y >= threshold) {
      k--;
      for (const el of (lines[k] as HzLine).els) el.classList.add(HIDDEN);
    }
    this.hzShown = k;
  }

  private hzClear(): void {
    cancelAnimationFrame(this.hzRaf);
    this.hzRaf = 0;
    for (const l of this.hzLines) for (const el of l.els) el.classList.remove(HIDDEN);
    this.hzLines = [];
    this.hzShown = 0;
    this.hzLine?.remove();
    this.hzLine = null;
  }

  private measure(): void {
    this.maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  }

  /** The reading position (real scroll + glide offset). */
  private position(): number {
    return this.glide ? this.glide.base + this.glideOffset() : window.scrollY;
  }

  /** True while the text is moving (for tests and diagnostics). */
  get gliding(): boolean {
    return !!this.glide;
  }

  private remainingPx(): number {
    return Math.max(0, this.maxScroll - this.position());
  }

  private atEnd(): boolean {
    return this.remainingPx() <= 2;
  }

  /** At the end of the portion: ask whether to carry on into the next one. */
  private promptEnd(): void {
    if (this.endPrompted || this.stopped) return;
    this.endPrompted = true;
    const p = this.portion;
    if (!p?.next) {
      this.app.toast(t('auto.lastPortion'));
      return;
    }
    const next = p.next;
    let go = false;
    openDialog({
      title: t('auto.endTitle'),
      body: h('p', null, t('auto.endBody', { label: p.label, next: next.label })),
      actions: (close) => [
        h('button', { type: 'button', 'data-key': 'as-stay', onclick: close }, t('auto.stay')),
        h('button', { type: 'button', class: 'primary', 'data-key': 'as-continue', onclick: () => { go = true; close(); } }, t('auto.continue', { next: next.label })),
      ],
      onClose: () => {
        if (!go || this.stopped) {
          this.toggleBtn.focus({ preventScroll: true });
          return;
        }
        this.app.navigate(next.hash);
        this.endPrompted = false;
        this.toggleBtn.focus({ preventScroll: true });
        this.resumeTimer = setTimeout(() => {
          this.resumeTimer = null;
          if (!this.stopped) this.resume();
        }, RESUME_DELAY_MS);
      },
    });
  }

  private handleKey(e: KeyboardEvent): void {
    if (document.querySelector('dialog[open]')) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    let handled = true;
    if (this.mode === 'voice' && e.key !== ' ' && e.key !== 'Spacebar' && e.key !== 'Escape') return;
    if (e.key === ' ' || e.key === 'Spacebar') {
      if (target?.tagName === 'BUTTON' && this.bar.contains(target)) return; // let the focused button act
      this.toggle();
    } else if (e.key === '+' || e.key === '=' || e.key === 'ArrowUp') this.setSpeed(this.speed + 1);
    else if (e.key === '-' || e.key === 'ArrowDown') this.setSpeed(this.speed - 1);
    else if (e.key === 'Escape') this.stop();
    else handled = false;
    if (handled) e.preventDefault();
  }

  private render(): void {
    if (this.mode === 'voice') return this.renderVoice();
    const label = this.paused ? t('auto.resume') : t('auto.pause');
    this.toggleBtn.setAttribute('aria-label', label);
    this.toggleBtn.title = label;
    replaceChildren(this.toggleBtn, icon(this.paused ? 'play' : 'pause'));
    this.bar.classList.toggle('paused', this.paused);
    const hz = this.hafeez === 'off' ? t('auto.hafeezOff') : this.hafeez === 'half' ? t('auto.hafeezHalf') : t('auto.hafeezHint');
    this.hafeezBtn.setAttribute('aria-label', hz);
    this.hafeezBtn.title = hz;
    this.hafeezBtn.setAttribute('aria-pressed', String(this.hafeez !== 'off'));
    this.hafeezBtn.dataset.mode = this.hafeez;
    replaceChildren(this.hafeezBtn, icon(this.hafeez === 'off' ? 'eye' : this.hafeez === 'half' ? 'eyeOff' : 'eyeHint'));
    for (const [key, disabled] of [['as-slower', this.speed <= SPEED_MIN], ['as-faster', this.speed >= SPEED_MAX]] as const) {
      const b = this.bar.querySelector<HTMLButtonElement>(`[data-key="${key}"]`);
      if (b) b.disabled = disabled;
    }
    this.renderStatus();
  }

  private renderStatus(): void {
    if (this.mode === 'voice') return;
    const mins = minutesLeft(this.remainingPx(), pxPerSecond(this.speed, this.app.prefs.fontScale));
    const time = tn('auto.minutes', mins);
    // Long form ("26 minutes | 15") and a compact one for narrow phones; CSS shows one of them.
    replaceChildren(
      this.status,
      h('span', { class: 'as-long' }, t('auto.status', { time, speed: fmtNum(this.speed) })),
      h('span', { class: 'as-short', 'aria-hidden': 'true' }, t('auto.status', { time: t('auto.minutesShort', { count: mins }), speed: fmtNum(this.speed) })),
    );
    this.status.title = t('auto.statusLong', { time, speed: fmtNum(this.speed), max: fmtNum(SPEED_MAX) });
    this.status.dataset.speed = String(this.speed);
    this.status.dataset.minutes = String(mins);
  }

  // ------------------------------------------------------------------ reciting (voice) mode
  private renderVoice(): void {
    const l = this.live;
    const st = l?.state;
    const listening = st?.status === 'listening';
    const busy = !!l && (l.preparing || st?.status === 'loading' || st?.status === 'stopping');
    const label = listening ? (st.paused ? t('rec.resume') : t('rec.pause')) : t('rec.start');
    this.toggleBtn.setAttribute('aria-label', label);
    this.toggleBtn.title = label;
    this.toggleBtn.disabled = busy;
    this.toggleBtn.classList.toggle('is-busy', busy);
    this.toggleBtn.classList.toggle('is-live', listening && !st.paused && !st.silent);
    replaceChildren(this.toggleBtn, icon(listening ? (st.paused ? 'mic' : 'pause') : 'mic'));
    this.bar.classList.toggle('paused', !listening || st.paused);
    const hz = this.hafeez === 'all' ? t('voice.hafeezAll') : t('voice.hafeezOff');
    this.hafeezBtn.setAttribute('aria-label', hz);
    this.hafeezBtn.title = hz;
    this.hafeezBtn.setAttribute('aria-pressed', String(this.hafeez !== 'off'));
    this.hafeezBtn.dataset.mode = this.hafeez;
    replaceChildren(this.hafeezBtn, icon(this.hafeez === 'all' ? 'eyeOff' : 'eye'));
    for (const [key, disabled] of [['as-prev', !this.portion?.prev], ['as-next', !this.portion?.next]] as const) {
      const b = this.bar.querySelector<HTMLButtonElement>(`[data-key="${key}"]`);
      if (b) b.disabled = disabled;
    }
    this.status.textContent = l ? statusLabel(l) : '';
  }

  private stepPortion(dir: 1 | -1): void {
    const dest = dir > 0 ? this.portion?.next : this.portion?.prev;
    if (dest) this.goToPortion(dest.hash);
  }

  /** Indexes the Quran words now on screen. */
  private collectWords(): void {
    this.wordEls = new Map();
    this.painted = new Map();
    this.curEl = null;
    for (const el of document.querySelectorAll<HTMLElement>('#main .quran button.w')) this.wordEls.set(`${el.dataset.a}:${el.dataset.p}`, el);
  }

  /** A new recitation state: colour words, follow the current word, move on at the portion's end. */
  private liveUpdate(): void {
    if (this.stopped || this.mode !== 'voice') return;
    const l = this.live;
    const st = l?.state;
    this.render();
    if (!l || !st) return;
    const words = l.corpus.words;
    const want = new Map<HTMLElement, string>();
    for (const [flat, status] of st.tracker.status as ReadonlyMap<number, WordStatus>) {
      const w = words[flat];
      const el = w ? this.wordEls.get(`${w.ayahIndex}:${w.position}`) : undefined;
      if (el) want.set(el, `rs-${status}`);
    }
    for (const [el, cls] of this.painted) if (want.get(el) !== cls) el.classList.remove(cls);
    for (const [el, cls] of want) if (this.painted.get(el) !== cls) el.classList.add(cls);
    this.painted = want;
    const cursor = st.tracker.cursor;
    const at = cursor === null ? null : words[Math.min(cursor, words.length - 1)];
    const cur = at ? this.wordEls.get(`${at.ayahIndex}:${at.position}`) ?? null : null;
    if (cur !== this.curEl) {
      this.curEl?.classList.remove('rs-cur');
      cur?.classList.add('rs-cur');
      this.curEl = cur;
    }
    if (!at || cursor === null || this.advancing) return;
    const p = this.portion;
    if (p?.end !== undefined && p.start !== undefined && (at.ayahIndex > p.end || at.ayahIndex < p.start)) {
      // The reciter carried on past the portion (or is somewhere else): show where they are.
      if (at.ayahIndex === p.end + 1 && p.next) this.goToPortion(p.next.hash);
      else {
        const page = l.corpus.pageAt(Math.min(cursor, words.length - 1));
        if (page !== null) this.goToPortion(`#/quran?page=${page}&focus=${at.ayahIndex}`);
      }
      return;
    }
    if (cur && cursor !== this.lastFollowed) {
      this.lastFollowed = cursor;
      this.follow(cur);
    }
  }

  /** Scrolls so the current word sits a little above the middle (only when it left the band). */
  private follow(el: HTMLElement): void {
    if (Date.now() - this.manualAt < FOLLOW_IDLE_MS || this.touching) return;
    const r = el.getBoundingClientRect();
    const hgt = window.innerHeight;
    if (r.top >= hgt * FOLLOW_BAND[0] && r.bottom <= hgt * FOLLOW_BAND[1]) return;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: Math.max(0, window.scrollY + r.top - hgt * FOLLOW_AT), behavior: reduce ? 'auto' : 'smooth' });
  }

  /** Exit: stop listening, unpaint, and show the summary so mistakes can be saved. */
  private endReciting(): void {
    const l = this.live;
    document.body.classList.remove('reciting');
    for (const el of this.wordEls.values()) el.classList.remove(...RS_CLASSES, 'rs-cur');
    if (!l) return;
    l.listeners.delete(this.onLive);
    const app = this.app;
    void stopReciting(l).then(() => {
      const st = l.state;
      if (!st || st.status === 'idle' || (!st.tracker.recitedWords && !st.tracker.findings.length)) return;
      const box = h('div');
      const paint = () => replaceChildren(box, summaryPanel(app, l, st, paint));
      paint();
      openDialog({
        title: t('rec.summary'),
        body: box,
        actions: (close) => [h('button', { type: 'button', 'data-key': 'voice-done', onclick: close }, t('voice.done'))],
      });
    });
  }

  /** Keeps the screen on while scrolling (supported on most mobile browsers). */
  private async lockScreen(): Promise<void> {
    const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockLike> } }).wakeLock;
    if (!wl || this.wakeLock || this.stopped) return;
    try {
      this.wakeLock = await wl.request('screen');
      if (this.stopped || this.paused) await this.releaseLock();
    } catch {
      this.wakeLock = null;
    }
  }

  private async releaseLock(): Promise<void> {
    const l = this.wakeLock;
    this.wakeLock = null;
    try {
      await l?.release();
    } catch {
      /* already released */
    }
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }
}
