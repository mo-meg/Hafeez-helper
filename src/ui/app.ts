import type { AudioCache } from '../browser/audioCache.ts';
import { notificationsSupported, shouldNotify } from '../browser/reminders.ts';
import { PlaybackController, type AudioBackend, type TimerApi } from '../core/audio/playbackController.ts';
import { BUILTIN_RECITERS, findReciter, type ReciterSource } from '../core/audio/reciters.ts';
import type { QuranDataState } from '../core/data/quranDataService.ts';
import type { DailyPlan, Mistake, RecallOutcome, ReviewEvent, RevisionSession } from '../core/model.ts';
import type { DivisionDataset } from '../core/quran/divisions.ts';
import type { QuranTextDataset } from '../core/quran/text.ts';
import type { AyahRef } from '../core/quran/types.ts';
import type { AppServices } from '../core/services.ts';
import { buildSession, type BuiltSession, type SessionConfig } from '../core/session/sessionBuilder.ts';
import type { Preferences } from '../core/settings/preferences.ts';
import { localDateKey } from '../core/util/ids.ts';
import { dir, getLocale, setLocale, t, type Locale, type MessageKey } from './i18n/index.ts';
import { errorText, refLabel, scopeLabel } from './i18n/labels.ts';
import type { AutoScrollSession } from './components/autoScroll.ts';
import { icon } from './components/icons.ts';
import { languageSwitch as languageSwitchControl } from './components/languageSwitch.ts';
import { syncStatusText, type AccountController } from './auth/account.ts';
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
  /** Persistent notices shown on every page (already localized by the caller). */
  readonly notices?: readonly string[];
  /** Set when IndexedDB could not be opened; shown as a localized notice on every page. */
  readonly storageError?: string;
  /** Signed-in account with cloud sync; absent in local-only and guest mode. */
  readonly account?: AccountController;
  /** Shows the sign-in screen again after continuing as a guest. */
  readonly guestSignIn?: () => void;
  /** Called when the interface language changes (remembered for the sign-in screen). */
  readonly onLanguageChange?: (l: Locale) => void;
  /** Synthetic data for the browser test harness only. */
  readonly fixture?: { readonly text: QuranTextDataset | null; readonly divisions: DivisionDataset };
  readonly enableReminders?: boolean;
}

export type RouteName = 'dashboard' | 'quran' | 'revision' | 'mistakes' | 'test' | 'session' | 'progress' | 'settings';
const NAV: ReadonlyArray<{ name: RouteName; label: MessageKey; icon: string }> = [
  { name: 'dashboard', label: 'nav.dashboard', icon: 'dashboard' },
  { name: 'quran', label: 'nav.quran', icon: 'quran' },
  { name: 'revision', label: 'nav.revision', icon: 'revision' },
  { name: 'mistakes', label: 'nav.mistakes', icon: 'mistakes' },
  { name: 'test', label: 'nav.test', icon: 'test' },
  { name: 'progress', label: 'nav.progress', icon: 'progress' },
  { name: 'settings', label: 'nav.settings', icon: 'settings' },
];

/** A session title that is computed at render time, so it follows the interface language. */
export type Title = () => string;

export interface ActiveSession {
  readonly id: string;
  readonly config: SessionConfig;
  readonly built: BuiltSession;
  readonly title: Title;
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
  pendingTitle: Title | null = null;
  active: ActiveSession | null = null;
  test: ActiveTest | null = null;
  readingPosition: AyahRef | null = null;
  /** Quran auto-scroll focus mode, while it is on. */
  autoScroll: AutoScrollSession | null = null;
  private main!: HTMLElement;
  private dock!: HTMLElement;
  private toastRegion!: HTMLElement;
  private nav!: HTMLElement;
  private topbar!: HTMLElement;
  private skipLink!: HTMLAnchorElement;
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
    this.applyAppearance();
    this.buildShell(root);
    this.player.setRate(this.prefs.repeat.playbackRate);
    this.player.setPauseForAssessment(this.prefs.pauseForAssessment);
    this.player.subscribe(() => {
      if (this.route.name === 'session' && this.active) this.render(true);
      else this.renderDock();
    });
    this.player.onStepCompleted((step) => void this.onStepCompleted(step.item.globalIndex));
    this.setupMediaSession();
    const account = this.deps.account;
    if (account) {
      account.sync.subscribe(() => this.updateSyncStatus());
      account.sync.onRemoteChange = () => void this.reloadFromRemote();
      account.onSessionEnded(() => this.renderChrome());
    }
    window.addEventListener('hashchange', () => this.onRoute());
    this.onRoute();
    if (this.deps.enableReminders !== false) this.startReminderLoop();
  }

  private buildShell(root: HTMLElement) {
    this.nav = h('nav', { class: 'rail' });
    this.topbar = h('header', { class: 'topbar' });
    this.noticeHost = h('div');
    this.main = h('main', { id: 'main', tabindex: '-1' });
    this.dock = h('section', { class: 'dock', hidden: true });
    this.toastRegion = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    this.skipLink = h('a', { class: 'skip-link', href: '#main', onclick: (e: Event) => { e.preventDefault(); this.main.focus(); } });
    replaceChildren(root, this.skipLink, this.topbar, h('div', { class: 'shell' }, this.nav, h('div', null, this.noticeHost, this.main)), this.dock, this.toastRegion);
    this.renderChrome();
  }

  /** (Re)renders the language-dependent shell: navigation, top bar, notices. */
  private renderChrome(): void {
    const brand = () => h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'ح'), h('span', { class: 'brand-name' }, t('app.name'), h('span', { class: 'brand-sub' }, t('app.tagline'))));
    this.nav.setAttribute('aria-label', t('app.navLabel'));
    replaceChildren(
      this.nav,
      brand(),
      NAV.map((n) => h('a', { class: 'nav-link', href: `#/${n.name}`, dataset: { route: n.name } }, icon(n.icon), h('span', null, t(n.label)))),
      h('div', { class: 'rail-foot' }, this.languageSwitch(), this.deps.account ? this.accountMini() : this.deps.guestSignIn ? h('button', { type: 'button', class: 'quiet', onclick: this.deps.guestSignIn }, t('acct.signIn')) : h('span', null, t('app.privacyFoot'))),
    );
    replaceChildren(this.topbar, brand(), h('div', { class: 'row', style: { 'flex-wrap': 'nowrap' } }, this.deps.account ? h('a', { class: 'sync-dot', href: '#/settings?section=account' }) : null, this.languageSwitch()));
    this.skipLink.textContent = t('app.skip');
    this.dock.setAttribute('aria-label', t('app.playerLabel'));
    const notices = [...(this.deps.notices ?? [])];
    if (this.deps.storageError) notices.push(t('app.storageFallback', { detail: this.deps.storageError }));
    if (this.quran.text?.dataset.synthetic || this.quran.divisions.synthetic) notices.push(t('app.syntheticNotice'));
    const account = this.deps.account;
    const ended = account?.sessionEnded
      ? h('div', { class: 'notice warn', role: 'alert' }, h('p', null, t('acct.sessionEnded')), h('button', { type: 'button', class: 'primary', onclick: () => account.signInAgain() }, t('acct.signInAgain')))
      : null;
    replaceChildren(this.noticeHost, notices.length || ended ? h('div', { class: 'shell-notices stack' }, ended, notices.map((n) => h('div', { class: 'notice warn', role: 'note' }, n))) : null);
    this.updateSyncStatus();
  }

  /** Email and live sync status in the sidebar footer. */
  private accountMini(): HTMLElement {
    const email = this.deps.account?.email ?? '';
    return h('a', { class: 'account-mini', href: '#/settings?section=account' }, h('span', { class: 'acct-email', dir: 'ltr', title: email }, email), h('span', { class: 'sync-status' }));
  }

  /** Updates every live sync-status element without re-rendering (keeps form input intact). */
  updateSyncStatus(): void {
    const account = this.deps.account;
    if (!account) return;
    const s = account.sync.status;
    const text = syncStatusText(s, this.now());
    for (const el of document.querySelectorAll<HTMLElement>('.sync-status')) {
      el.textContent = text;
      el.dataset.state = s.state;
    }
    for (const el of document.querySelectorAll<HTMLElement>('.sync-dot')) {
      el.dataset.state = s.state;
      el.title = text;
      el.setAttribute('aria-label', `${t('sync.label')}: ${text}`);
    }
  }

  /** Remote changes arrived: reload preferences and data, keeping the current screen. */
  private async reloadFromRemote(): Promise<void> {
    const before = this.prefs.language;
    this.prefs = await this.s.preferences.load();
    this.readingPosition = (await this.s.store.settings.get<AyahRef>('readingPosition')) ?? this.readingPosition;
    this.applyAppearance();
    this.player.setPauseForAssessment(this.prefs.pauseForAssessment);
    if (before !== this.prefs.language) {
      this.deps.onLanguageChange?.(this.prefs.language);
      this.renderChrome();
    }
    await this.refresh();
  }

  /** Arabic / English segmented control. Each option is labelled in its own language. */
  languageSwitch(): HTMLElement {
    return languageSwitchControl(getLocale(), (l) => void this.setLanguage(l));
  }

  /** Switches the interface language. Data, route, session and playback are untouched. */
  async setLanguage(locale: Locale): Promise<void> {
    if (locale === this.prefs.language) return;
    await this.act(() => this.savePrefs({ ...this.prefs, language: locale }));
    this.toast(t('lang.changed'));
    document.querySelector<HTMLElement>(`[data-key="lang-${locale}"]`)?.focus({ preventScroll: true });
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
    if (name !== 'quran') this.autoScroll?.stop();
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
      view = h('div', { class: 'notice error', role: 'alert' }, h('p', null, t('app.pageError', { detail: errorText(e) })));
    }
    replaceChildren(this.main, view);
    const navItem = NAV.find((n) => n.name === this.route.name);
    document.title = t('app.titleSuffix', { page: t(navItem ? navItem.label : 'nav.session') });
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
  toast(message: string, kind: 'info' | 'error' = 'info', action?: { readonly label: string; readonly key?: string; readonly run: () => void }): void {
    const t = h(
      'div',
      { class: `toast${kind === 'error' ? ' error' : ''}${action ? ' has-action' : ''}`, role: kind === 'error' ? 'alert' : 'status' },
      h('span', null, message),
      action ? h('button', { type: 'button', class: 'toast-action', 'data-key': action.key ?? null, onclick: () => { t.remove(); action.run(); } }, action.label) : null,
    );
    this.toastRegion.append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 8000 : action ? 6000 : 3500);
  }

  /** Runs a user action, reporting failures clearly. */
  async act(fn: () => Promise<unknown>, success?: string): Promise<boolean> {
    try {
      await fn();
      if (success) this.toast(success);
      return true;
    } catch (e) {
      this.toast(errorText(e), 'error');
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
    const languageChanged = p.language !== this.prefs.language;
    this.prefs = await this.s.preferences.save(p);
    this.applyAppearance();
    if (languageChanged) this.deps.onLanguageChange?.(this.prefs.language);
    if (languageChanged && this.main) {
      this.renderChrome();
      this.render(true);
    }
    this.player.setRate(this.prefs.repeat.playbackRate);
    this.player.setPauseForAssessment(this.prefs.pauseForAssessment);
  }

  applyAppearance(): void {
    const dark = this.prefs.theme === 'dark' || (this.prefs.theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.setProperty('--quran-scale', String(this.prefs.fontScale));
    setLocale(this.prefs.language);
    document.documentElement.lang = this.prefs.language;
    document.documentElement.dir = dir(this.prefs.language);
  }

  async setReadingPosition(ref: AyahRef): Promise<void> {
    this.readingPosition = ref;
    await this.s.store.settings.set('readingPosition', ref);
  }

  // ---------------------------------------------------------------- sessions
  /**
   * Opens the session preview. `title` is evaluated at render time so it follows the interface
   * language; `config.label` keeps a stable English label for stored records.
   */
  prepare(config: SessionConfig, title?: Title): void {
    if (this.active && !this.active.ended) {
      this.toast(t('ses.finishFirst'), 'error');
      this.navigate('#/session');
      return;
    }
    const scope = config.scope;
    this.pendingTitle = title ?? (() => scopeLabel(scope, this.quran.index));
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
      this.toast(t('ses.nothing'), 'error');
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
    const scope = config.scope;
    const title = this.pendingTitle ?? (() => scopeLabel(scope, this.quran.index));
    this.active = { id: session.id, config, built, title, outcomes: new Map(), plays: new Map(), ended: false };
    this.pending = null;
    this.pendingTitle = null;
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
    }, t('ses.recordedFor', { ref: refLabel(ref) }));
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
    }, completed ? t('ses.completedToast') : t('ses.endedToast'));
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
    const pct = st.steps.length ? Math.round((100 * Math.min(st.completedSteps, st.steps.length)) / st.steps.length) : 0;
    replaceChildren(
      this.dock,
      h('div', { class: 'progress-track', role: 'progressbar', 'aria-label': t('ses.progress'), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('span', { style: { width: `${pct}%` } })),
      h('div', { class: 'info' }, h('strong', null, cur ? refLabel(cur.item.ref) : t('dock.revision')), h('span', { class: 'muted' }, cur ? t('ses.repetition', { n: cur.repetition, total: cur.repetitions }) : '', st.status === 'error' ? t('dock.audioProblem') : '')),
      h('button', { class: 'icon quiet', 'aria-label': t('player.prev'), title: t('player.prev'), onclick: () => void this.player.prev() }, icon('prev')),
      h('button', { class: 'icon primary', 'aria-label': playing ? t('player.pause') : t('player.play'), title: playing ? t('player.pause') : t('player.play'), onclick: () => void this.player.togglePlay() }, icon(playing ? 'pause' : 'play')),
      h('button', { class: 'icon quiet', 'aria-label': t('player.next'), title: t('player.next'), onclick: () => void this.player.next() }, icon('next')),
      h('a', { class: 'btn', href: '#/session' }, t('dock.open')),
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
        ms.metadata = new MediaMetadata({ title: refLabel(cur.item.ref), artist: this.reciter().name, album: t('ses.repetition', { n: cur.repetition, total: cur.repetitions }) });
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
        new Notification(t('reminder.title'), { body: plan ? t('reminder.bodyPlan') : t('reminder.bodyNoPlan'), tag: 'hafeez-daily', lang: getLocale(), dir: dir() });
      }
    };
    void check();
    setInterval(() => void check(), 60_000);
  }
}
