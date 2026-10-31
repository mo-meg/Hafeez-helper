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
 * Focus mode deliberately does NOT request browser full screen: Chrome always shows a
 * "To exit full screen…" notice when a page enters full screen, which covered the text at start.
 * Hiding the app chrome (FOCUS_CLASS) is enough.
 */
import { clampSpeed, minutesLeft, pxPerSecond, SPEED_DEFAULT, SPEED_MAX, SPEED_MIN } from '../../core/reading/autoScroll.ts';
import type { App } from '../app.ts';
import { h, replaceChildren } from '../dom.ts';
import { fmtNum, t, tn } from '../i18n/index.ts';
import { openDialog } from './dialog.ts';
import { icon } from './icons.ts';

const SPEED_KEY = 'autoScrollSpeed';
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
  readonly next: { readonly hash: string; readonly label: string } | null;
}

interface WakeLockLike { release(): Promise<void> }

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

  private constructor(app: App, speed: number) {
    this.app = app;
    this.speed = clampSpeed(speed);
    this.status = h('span', { class: 'as-status', 'aria-live': 'off' });
    this.toggleBtn = h('button', { type: 'button', class: 'icon', 'data-key': 'as-toggle', onclick: () => this.toggle() });
    const btn = (key: string, label: string, ic: string, fn: () => void) =>
      h('button', { type: 'button', class: 'icon', 'data-key': key, 'aria-label': label, title: label, onclick: fn }, icon(ic));
    this.bar = h(
      'div',
      { class: 'autoscroll-bar', role: 'toolbar', 'aria-label': t('auto.bar') },
      this.toggleBtn,
      btn('as-back', t('auto.back'), 'rewind', () => this.back()),
      btn('as-slower', t('auto.slower'), 'minus', () => this.setSpeed(this.speed - 1)),
      this.status,
      btn('as-faster', t('auto.faster'), 'plus', () => this.setSpeed(this.speed + 1)),
      btn('as-close', t('auto.close'), 'close', () => this.stop()),
    );
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
    app.toast(t('auto.tapHint'));
    return session;
  }

  /** Called by the Quran view on every render with the portion now on screen. */
  setPortion(p: PortionInfo): void {
    this.portion = p;
    this.endPrompted = false;
    queueMicrotask(() => this.measure());
  }

  /** Still waiting for layout to settle after start (no scrolling yet). */
  get starting(): boolean {
    return this.warming && !this.stopped;
  }

  get active(): boolean {
    return !this.stopped;
  }

  toggle(): void {
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
    if (this.glide || this.stopped || this.paused) return;
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
    const label = this.paused ? t('auto.resume') : t('auto.pause');
    this.toggleBtn.setAttribute('aria-label', label);
    this.toggleBtn.title = label;
    replaceChildren(this.toggleBtn, icon(this.paused ? 'play' : 'pause'));
    this.bar.classList.toggle('paused', this.paused);
    for (const [key, disabled] of [['as-slower', this.speed <= SPEED_MIN], ['as-faster', this.speed >= SPEED_MAX]] as const) {
      const b = this.bar.querySelector<HTMLButtonElement>(`[data-key="${key}"]`);
      if (b) b.disabled = disabled;
    }
    this.renderStatus();
  }

  private renderStatus(): void {
    const mins = minutesLeft(this.remainingPx(), pxPerSecond(this.speed, this.app.prefs.fontScale));
    const time = tn('auto.minutes', mins);
    this.status.textContent = t('auto.status', { time, speed: fmtNum(this.speed) });
    this.status.title = t('auto.statusLong', { time, speed: fmtNum(this.speed), max: fmtNum(SPEED_MAX) });
    this.status.dataset.speed = String(this.speed);
    this.status.dataset.minutes = String(mins);
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
