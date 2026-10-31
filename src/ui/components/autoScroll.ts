/**
 * Auto-scroll focus mode for the Quran reader.
 *
 * The page itself (window) scrolls, so a re-render of the Quran view keeps the position. The
 * control bar lives on <body>, outside <main>, and survives re-renders and route changes within
 * the Quran section. Leaving the Quran section, pressing X / Esc, or leaving full screen ends it.
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

/** What the Quran view tells the controller about the portion on screen. */
export interface PortionInfo {
  readonly label: string;
  readonly next: { readonly hash: string; readonly label: string } | null;
}

interface WakeLockLike { release(): Promise<void> }

export class AutoScrollSession {
  speed: number;
  paused = false;
  private readonly app: App;
  private readonly bar: HTMLElement;
  private readonly status: HTMLElement;
  private readonly toggleBtn: HTMLButtonElement;
  private portion: PortionInfo | null = null;
  private raf = 0;
  private lastTs = 0;
  /** Exact (fractional) scroll position; window.scrollY is rounded by some browsers. */
  private pos = 0;
  private lastStatusAt = 0;
  private endPrompted = false;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeLock: WakeLockLike | null = null;
  private enteredFullscreen = false;
  private stopped = false;
  private readonly onKey = (e: KeyboardEvent) => this.handleKey(e);
  private readonly onFullscreen = () => {
    if (this.enteredFullscreen && !document.fullscreenElement) {
      this.enteredFullscreen = false;
      this.stop();
    }
  };
  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible' && !this.paused) void this.lockScreen();
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

  /**
   * Starts focus mode from the current scroll position. Must be called from a click handler:
   * the full-screen request is made synchronously, before anything is awaited.
   */
  static start(app: App, portion: PortionInfo): AutoScrollSession {
    app.autoScroll?.stop();
    const session = new AutoScrollSession(app, SPEED_DEFAULT);
    app.autoScroll = session;
    session.portion = portion;
    session.enterFullscreen();
    document.body.classList.add(FOCUS_CLASS);
    document.body.append(session.bar);
    document.addEventListener('keydown', session.onKey);
    document.addEventListener('fullscreenchange', session.onFullscreen);
    document.addEventListener('visibilitychange', session.onVisibility);
    session.pos = window.scrollY;
    session.render();
    session.toggleBtn.focus({ preventScroll: true });
    session.raf = requestAnimationFrame((ts) => session.tick(ts));
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
    this.pos = window.scrollY;
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
    this.paused = true;
    void this.releaseLock();
    this.render();
  }

  resume(): void {
    this.clearResumeTimer();
    if (this.atEnd()) {
      this.promptEnd();
      return;
    }
    this.paused = false;
    this.pos = window.scrollY;
    this.lastTs = 0;
    void this.lockScreen();
    this.render();
  }

  setSpeed(level: number): void {
    this.speed = clampSpeed(level);
    this.render();
    void this.app.s.store.settings.set(SPEED_KEY, this.speed).catch(() => undefined);
  }

  /** Jumps back about a third of a screen (the ⏪ button). */
  back(): void {
    this.pos = Math.max(0, window.scrollY - window.innerHeight / 3);
    window.scrollTo(0, this.pos);
    this.endPrompted = false;
    this.render();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    this.clearResumeTimer();
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.bar.remove();
    document.body.classList.remove(FOCUS_CLASS);
    void this.releaseLock();
    if (this.enteredFullscreen && document.fullscreenElement) {
      this.enteredFullscreen = false;
      void document.exitFullscreen?.().catch(() => undefined);
    }
    if (this.app.autoScroll === this) this.app.autoScroll = null;
    // Words marked during focus mode were updated in place; re-render so every view is consistent.
    if (this.app.route.name === 'quran') void this.app.refresh();
  }

  // ------------------------------------------------------------------ internals
  private tick(ts: number): void {
    if (this.stopped) return;
    if (!this.paused) {
      // Clamp the frame gap so a backgrounded tab does not jump ahead when it returns.
      const dt = this.lastTs ? Math.min((ts - this.lastTs) / 1000, 0.1) : 0;
      // The reader scrolled by hand (touch, wheel, keyboard): continue from there.
      if (Math.abs(window.scrollY - this.pos) > 3) this.pos = window.scrollY;
      this.pos += pxPerSecond(this.speed, this.app.prefs.fontScale) * dt;
      window.scrollTo(0, this.pos);
      if (this.atEnd()) {
        this.pause();
        this.promptEnd();
      }
    }
    this.lastTs = ts;
    if (ts - this.lastStatusAt > 500) {
      this.lastStatusAt = ts;
      this.renderStatus();
    }
    this.raf = requestAnimationFrame((n) => this.tick(n));
  }

  private remainingPx(): number {
    return Math.max(0, document.documentElement.scrollHeight - window.innerHeight - window.scrollY);
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
        this.pos = window.scrollY;
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

  private enterFullscreen(): void {
    const el = document.documentElement;
    if (document.fullscreenElement || typeof el.requestFullscreen !== 'function') return;
    try {
      el.requestFullscreen({ navigationUI: 'hide' }).then(
        () => { this.enteredFullscreen = !this.stopped; },
        () => undefined, // not allowed here (e.g. iOS Safari): focus mode still hides the app chrome
      );
    } catch {
      /* unsupported */
    }
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
