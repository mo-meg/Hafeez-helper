import type { AudioCache } from '../browser/audioCache.ts';
import { notificationsSupported, shouldNotify } from '../browser/reminders.ts';
import { PlaybackController, type AudioBackend, type TimerApi } from '../core/audio/playbackController.ts';
import { BUILTIN_RECITERS, findReciter, type ReciterSource } from '../core/audio/reciters.ts';
import type { QuranDataState } from '../core/data/quranDataService.ts';
import type { DailyPlan, Mistake, RecallOutcome, ReviewEvent, RevisionSession } from '../core/model.ts';
import type { DivisionDataset } from '../core/quran/divisions.ts';
import { formatRef } from '../core/quran/refs.ts';
import type { QuranTextDataset } from '../core/quran/text.ts';
import type { AyahRef } from '../core/quran/types.ts';
import type { AppServices } from '../core/services.ts';
import { buildSession, type BuiltSession, type SessionConfig } from '../core/session/sessionBuilder.ts';
import type { Preferences } from '../core/settings/preferences.ts';
import { localDateKey } from '../core/util/ids.ts';
import { icon } from './components/icons.ts';
import { h, replaceChildren } from './dom.ts';
import { dashboardView } from './views/dashboard.ts';
import { mistakesView } from './views/mistakes.ts';
import { progressView } from './views/progress.ts';
import { quranView } from './views/quran.ts';
import { revisionView } from './views/revision.ts';
import { sessionView } from './views/session.ts';
import { settingsView } from './views/settings.ts';
import { testView, type ActiveTest } from './views/test.ts';

export interface AppDeps {
  readonly services: AppServices;
  readonly audioBackend: AudioBackend;
  readonly audioCache: AudioCache;
  readonly timers?: TimerApi;
  readonly isOnline: () => boolean;
  /** Persistent notices shown on every page (e.g. storage fallback, synthetic fixture). */
  readonly notices?: readonly string[];
  /** Synthetic data for the browser test harness only. */
  readonly fixture?: { readonly text: QuranTextDataset | null; readonly divisions: DivisionDataset };
  readonly enableReminders?: boolean;
}

export type RouteName = 'dashboard' | 'quran' | 'revision' | 'mistakes' | 'test' | 'session' | 'progress' | 'settings';
const NAV: ReadonlyArray<{ name: RouteName; label: string; icon: string }> = [
  { name: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { name: 'quran', label: 'Quran', icon: 'quran' },
  { name: 'revision', label: 'Daily revision', icon: 'revision' },
  { name: 'mistakes', label: 'My mistakes', icon: 'mistakes' },
  { name: 'test', label: 'Test', icon: 'test' },
  { name: 'progress', label: 'Progress', icon: 'progress' },
  { name: 'settings', label: 'Settings', icon: 'settings' },
];

export interface ActiveSession {
  readonly id: string;
  readonly config: SessionConfig;
  readonly built: BuiltSession;
  /** Latest recall outcome recorded in this session per ayah. */
  readonly outcomes: Map<number, RecallOutcome>;
  /** Completed plays per ayah in this session (playback evidence only). */
  readonly plays: Map<number, number>;
  ended: boolean;
}

export class App {
  readonly s: AppServices;
  readonly deps: AppDeps;
  readonly player: PlaybackController;
  prefs!: Preferences;
  quran!: QuranDataState;
  data: { mistakes: Mistake[]; reviews: ReviewEvent[]; sessions: RevisionSession[]; plans: DailyPlan[] } = { mistakes: [], reviews: [], sessions: [], plans: [] };
  route: { name: RouteName; params: URLSearchParams } = { name: 'dashboard', params: new URLSearchParams() };
  pending: SessionConfig | null = null;
  active: ActiveSession | null = null;
  test: ActiveTest | null = null;
  readingPosition: AyahRef | null = null;
  private main!: HTMLElement;
  private dock!: HTMLElement;
  private toastRegion!: HTMLElement;
  private nav!: HTMLElement;
  private noticeHost!: HTMLElement;
  private lastRouteKey = '';

  constructor(deps: AppDeps) {
    this.deps = deps;
    this.s = deps.services;
    this.player = new PlaybackController({
      backend: deps.audioBackend,
      ...(deps.timers ? { timers: deps.timers } : {}),
      resolveUrl: deps.audioCache.resolver(() => this.reciter().urlTemplate, deps.isOnline),
    });
  }

  // ---------------------------------------------------------------- lifecycle
  async start(root: HTMLElement): Promise<void> {
    this.prefs = await this.s.preferences.load();
    this.quran = this.deps.fixture ? this.s.quran.useFixture(this.deps.fixture.text, this.deps.fixture.divisions) : await this.s.quran.init();
    this.readingPosition = (await this.s.store.settings.get<AyahRef>('readingPosition')) ?? null;
    await this.reloadData();
    this.buildShell(root);
    this.applyAppearance();
    this.player.setRate(this.prefs.repeat.playbackRate);
    this.player.setPauseForAssessment(this.prefs.pauseForAssessment);
    this.player.subscribe(() => {
      if (this.route.name === 'session' && this.active) this.render(true);
      else this.renderDock();
    });
    this.player.onStepCompleted((step) => void this.onStepCompleted(step.item.globalIndex));
    this.setupMediaSession();
    window.addEventListener('hashchange', () => this.onRoute());
    this.onRoute();
    if (this.deps.enableReminders !== false) this.startReminderLoop();
  }

  private buildShell(root: HTMLElement) {
    this.nav = h(
      'nav',
      { class: 'rail', 'aria-label': 'Main' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'ح'), h('span', { class: 'brand-name' }, 'Hafeez Helfer', h('span', { class: 'brand-sub' }, 'Hifz revision'))),
      NAV.map((n) => h('a', { class: 'nav-link', href: `#/${n.name}`, dataset: { route: n.name } }, icon(n.icon), h('span', null, n.label))),
      h('div', { class: 'rail-foot' }, 'Your data stays on this device.'),
    );
    this.noticeHost = h('div');
    this.main = h('main', { id: 'main', tabindex: '-1' });
    this.dock = h('section', { class: 'dock', 'aria-label': 'Revision player', hidden: true });
    this.toastRegion = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    replaceChildren(
      root,
      h('a', { class: 'skip-link', href: '#main', onclick: (e: Event) => { e.preventDefault(); this.main.focus(); } }, 'Skip to content'),
      h('div', { class: 'shell' }, this.nav, h('div', null, this.noticeHost, this.main)),
      this.dock,
      this.toastRegion,
    );
    const notices = [...(this.deps.notices ?? [])];
    if (this.quran.text?.dataset.synthetic || this.quran.divisions.synthetic) {
      notices.push('Synthetic test data is loaded. The words shown are placeholders, not Quran text, and boundaries other than the verified juz/hizb anchors are not real.');
    }
    replaceChildren(this.noticeHost, notices.map((n) => h('div', { class: 'notice warn', role: 'note', style: { margin: '1rem 2rem 0' } }, n)));
  }

  async reloadData(): Promise<void> {
    const st = this.s.store;
    const [mistakes, reviews, sessions, plans] = await Promise.all([this.s.mistakes.list(), st.reviews.getAll(), st.sessions.getAll(), st.plans.getAll()]);
    this.data = { mistakes, reviews, sessions, plans };
  }

  /** Reload persisted state and re-render, preserving scroll and keyboard focus. */
  async refresh(): Promise<void> {
    await this.reloadData();
    this.render(true);
  }

  private onRoute() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path = '', query = ''] = raw.split('?');
    const name = (NAV.some((n) => n.name === path) || path === 'session' ? path : 'dashboard') as RouteName;
    this.route = { name, params: new URLSearchParams(query) };
    this.render(false);
  }

  navigate(hash: string): void {
    if (location.hash === hash) this.onRoute();
    else location.hash = hash;
  }

  render(preserve: boolean): void {
    const key = `${this.route.name}?${this.route.params.toString()}`;
    const keep = preserve && key === this.lastRouteKey;
    const scrollY = window.scrollY;
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
    for (const a of this.nav.querySelectorAll<HTMLAnchorElement>('a.nav-link')) {
      const current = a.dataset.route === this.route.name || (this.route.name === 'session' && a.dataset.route === 'revision');
      if (current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    let view: Node;
    try {
      view = this.view();
    } catch (e) {
      view = h('div', { class: 'notice error', role: 'alert' }, h('p', null, `This page could not be displayed: ${e instanceof Error ? e.message : String(e)}`));
    }
    replaceChildren(this.main, view);
    document.title = `${NAV.find((n) => n.name === this.route.name)?.label ?? 'Revision session'} | Hafeez Helfer`;
    if (keep) {
      window.scrollTo(0, scrollY);
      if (focusKey) this.main.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    } else {
      this.lastRouteKey = key;
      const target = this.route.params.get('focus');
      if (!target) window.scrollTo(0, 0);
    }
    this.renderDock();
  }

  private view(): Node {
    switch (this.route.name) {
      case 'dashboard':
        return dashboardView(this);
      case 'quran':
        return quranView(this);
      case 'revision':
        return revisionView(this);
      case 'mistakes':
        return mistakesView(this);
      case 'session':
        return sessionView(this);
      case 'test':
        return testView(this);
      case 'progress':
        return progressView(this);
      case 'settings':
        return settingsView(this);
    }
  }

  // ---------------------------------------------------------------- helpers
  toast(message: string, kind: 'info' | 'error' = 'info'): void {
    const t = h('div', { class: `toast${kind === 'error' ? ' error' : ''}`, role: kind === 'error' ? 'alert' : 'status' }, message);
    this.toastRegion.append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 8000 : 3500);
  }

  /** Runs a user action, reporting failures clearly. */
  async act(fn: () => Promise<unknown>, success?: string): Promise<boolean> {
    try {
      await fn();
      if (success) this.toast(success);
      return true;
    } catch (e) {
      this.toast(e instanceof Error ? e.message : String(e), 'error');
      return false;
    }
  }

  now(): Date {
    return this.s.clock.now();
  }

  today(): string {
    return localDateKey(this.now());
  }

  reciters(): ReciterSource[] {
    return [...BUILTIN_RECITERS, ...this.prefs.customReciters];
  }

  reciter(): ReciterSource {
    return findReciter(this.prefs.reciterId, this.prefs.customReciters) ?? (BUILTIN_RECITERS[0] as ReciterSource);
  }

  async savePrefs(p: Preferences): Promise<void> {
    this.prefs = await this.s.preferences.save(p);
    this.applyAppearance();
    this.player.setRate(this.prefs.repeat.playbackRate);
    this.player.setPauseForAssessment(this.prefs.pauseForAssessment);
  }

  applyAppearance(): void {
    const dark = this.prefs.theme === 'dark' || (this.prefs.theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.setProperty('--quran-scale', String(this.prefs.fontScale));
  }

  async setReadingPosition(ref: AyahRef): Promise<void> {
    this.readingPosition = ref;
    await this.s.store.settings.set('readingPosition', ref);
  }

  // ---------------------------------------------------------------- sessions
  prepare(config: SessionConfig): void {
    if (this.active && !this.active.ended) {
      this.toast('Finish or end the current session before preparing a new one.', 'error');
      this.navigate('#/session');
      return;
    }
    this.pending = config;
    this.active = null;
    this.navigate('#/session');
  }

  build(config: SessionConfig): BuiltSession {
    return buildSession(config, this.data.mistakes, this.quran.index);
  }

  async startPending(): Promise<void> {
    const config = this.pending;
    if (!config) return;
    const built = this.build(config);
    if (built.steps.length === 0) {
      this.toast('There is nothing to play for this selection.', 'error');
      return;
    }
    const session = await this.s.plans.startSession({
      planId: config.planId,
      mode: config.mode,
      scope: config.scope,
      reciterId: config.reciterId,
      repeat: config.repeat,
      mistakeAyahIndexes: built.mistakeAyahIndexes,
      plannedSteps: built.steps.length,
    });
    this.active = { id: session.id, config, built, outcomes: new Map(), plays: new Map(), ended: false };
    this.pending = null;
    this.player.setRate(config.repeat.playbackRate);
    this.player.setSteps(built.steps);
    await this.reloadData();
    this.render(true);
    await this.player.start();
  }

  private async onStepCompleted(globalIndex: number) {
    const a = this.active;
    if (!a || a.ended) return;
    a.plays.set(globalIndex, (a.plays.get(globalIndex) ?? 0) + 1);
    try {
      await this.s.plans.recordPlayback(a.id, globalIndex);
    } catch {
      /* session record missing: playback still continues */
    }
  }

  async recordOutcome(ref: AyahRef, globalIndex: number, outcome: RecallOutcome): Promise<void> {
    const a = this.active;
    const ok = await this.act(async () => {
      await this.s.mistakes.recordAyahReview(ref, outcome, { sessionId: a?.id ?? null, repetitions: a?.plays.get(globalIndex) ?? 0 });
      a?.outcomes.set(globalIndex, outcome);
    }, `Recorded for ${formatRef(ref)}.`);
    if (ok && this.player.state.status === 'awaiting_assessment') await this.player.continueAfterAssessment();
    await this.refresh();
  }

  async endSession(completed: boolean): Promise<void> {
    const a = this.active;
    if (!a) return;
    this.player.stop();
    await this.act(async () => {
      if (completed) await this.s.plans.completeSession(a.id);
      else await this.s.plans.abandonSession(a.id);
    }, completed ? 'Session completed. Your mistakes keep their current status.' : 'Session ended.');
    a.ended = true;
    await this.refresh();
  }

  // ---------------------------------------------------------------- player dock
  private renderDock(): void {
    if (!this.dock) return;
    const st = this.player.state;
    const show = !!this.active && !this.active.ended && this.route.name !== 'session' && st.status !== 'idle';
    this.dock.hidden = !show;
    if (!show) return;
    const cur = st.current;
    const playing = st.status === 'playing' || st.status === 'gap' || st.status === 'loading';
    replaceChildren(
      this.dock,
      h('div', { class: 'info' }, h('strong', null, cur ? formatRef(cur.item.ref) : 'Revision'), h('span', { class: 'muted' }, cur ? `Repetition ${cur.repetition} of ${cur.repetitions}` : '', st.status === 'error' ? ' (audio problem, open the session)' : '')),
      h('button', { class: 'icon quiet', 'aria-label': 'Previous ayah', onclick: () => void this.player.prev() }, icon('prev')),
      h('button', { class: 'icon primary', 'aria-label': playing ? 'Pause' : 'Play', onclick: () => void this.player.togglePlay() }, icon(playing ? 'pause' : 'play')),
      h('button', { class: 'icon quiet', 'aria-label': 'Next ayah', onclick: () => void this.player.next() }, icon('next')),
      h('a', { class: 'btn', href: '#/session' }, 'Open session'),
    );
  }

  private setupMediaSession(): void {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!ms) return;
    try {
      ms.setActionHandler('play', () => void this.player.play());
      ms.setActionHandler('pause', () => this.player.pause());
      ms.setActionHandler('nexttrack', () => void this.player.next());
      ms.setActionHandler('previoustrack', () => void this.player.prev());
    } catch {
      /* some actions unsupported */
    }
    this.player.subscribe((st) => {
      const cur = st.current;
      if (cur && typeof MediaMetadata !== 'undefined') {
        ms.metadata = new MediaMetadata({ title: formatRef(cur.item.ref), artist: this.reciter().name, album: `Repetition ${cur.repetition}/${cur.repetitions}` });
      }
    });
  }

  // ---------------------------------------------------------------- reminders
  private startReminderLoop(): void {
    const check = async () => {
      const r = this.prefs.reminder;
      if (!r.enabled || !notificationsSupported() || Notification.permission !== 'granted') return;
      const today = this.today();
      const plan = this.data.plans.find((p) => p.date === today && p.kind === 'revision');
      const last = (await this.s.store.settings.get<string>('lastReminderDate')) ?? null;
      if (shouldNotify({ enabled: true, time: r.time, todayCompleted: plan?.status === 'completed', lastNotifiedDate: last, today, now: this.now() })) {
        await this.s.store.settings.set('lastReminderDate', today);
        new Notification('Time for your Quran revision', { body: plan ? 'Your daily assignment is waiting.' : 'Set today’s portion and start your revision.', tag: 'hafeez-daily' });
      }
    };
    void check();
    setInterval(() => void check(), 60_000);
  }
}
