/**
 * Quran browser: a bar at the top of the Quran section showing the portion on screen. Its arrow
 * opens a panel with the places read last, quick links and tabbed lists (surah, page, juz, hizb).
 * Each row shows where the portion starts and its first words; juz and hizb rows expand to their
 * quarters, surah rows to a "go to ayah" field.
 *
 * The panel is built only when opened, so it costs nothing while reading. Its state (open, tab,
 * expanded rows) lives in this module and survives re-renders of the Quran view.
 */
import { fromIndex, toIndex } from '../../core/quran/refs.ts';
import { SURAHS, surahInfo } from '../../core/quran/surahs.ts';
import type { DivisionKind, DivisionRange } from '../../core/quran/types.ts';
import type { App } from '../app.ts';
import { h, replaceChildren, type Child } from '../dom.ts';
import { fmtNum, t } from '../i18n/index.ts';
import { divisionLabel, kindName, refLabel, surahName } from '../i18n/labels.ts';
import { icon } from './icons.ts';

export type BrowseTab = 'surah' | 'page' | 'juz' | 'hizb';
const TABS: readonly BrowseTab[] = ['surah', 'page', 'juz', 'hizb'];

/** What the Quran view shows right now. */
export interface BrowseCurrent {
  readonly surah: number | null;
  readonly division: DivisionRange | null;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly label: string;
}

/** Surahs and ayat people often open directly. */
type QuickKey = 'mulk' | 'kahf' | 'kursi' | 'yasin' | 'waqiah' | 'baqarahEnd';
const QUICK_LINKS: ReadonlyArray<{ readonly key: QuickKey; readonly surah: number; readonly ayah?: number }> = [
  { key: 'mulk', surah: 67 },
  { key: 'kahf', surah: 18 },
  { key: 'kursi', surah: 2, ayah: 255 },
  { key: 'yasin', surah: 36 },
  { key: 'waqiah', surah: 56 },
  { key: 'baqarahEnd', surah: 2, ayah: 285 },
];

const state = {
  open: false,
  tab: null as BrowseTab | null,
  query: '',
  expanded: new Set<string>(),
};

const surahHash = (s: number, ayah?: number) => (ayah ? `#/quran?surah=${s}&focus=${toIndex({ surah: s, ayah })}` : `#/quran?surah=${s}`);

function defaultTab(cur: BrowseCurrent): BrowseTab {
  const k = cur.division?.kind;
  if (k === 'juz' || k === 'page' || k === 'hizb') return k;
  if (k === 'quarter') return 'hizb';
  return 'surah';
}

function startWords(app: App, idx: number): string | null {
  const a = app.quran.text?.ayahAt(idx);
  if (!a) return null;
  return a.tokens.filter((x) => x.position !== null).slice(0, 3).map((x) => x.text).join(' ') || null;
}

/** Lower-case, without diacritics, apostrophes, hyphens and spaces (for matching surah names). */
function norm(s: string): string {
  return s.normalize('NFKD')
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670\u06d6-\u06ed]/g, '')
    .replace(/[\s'`\-\u2018\u2019\u2010\u02bf\u02be]/g, '')
    .toLowerCase()
    .replace(/^(al|an|ad|ar|as|at|az|ash)(?=.)/, '')
    .replace(/^\u0627\u0644/, '');
}

export function quranBrowser(app: App, cur: BrowseCurrent): HTMLElement {
  if (!state.tab) state.tab = defaultTab(cur);
  const panel = h('div', { class: 'qb-panel', id: 'qb-panel', hidden: !state.open, role: 'region', 'aria-label': t('qb.panel') });
  const chev = h('span', { class: 'qb-chev', 'aria-hidden': 'true' }, icon('chevronDown'));
  const startRef = fromIndex(cur.startIndex);
  const endRef = fromIndex(cur.endIndex);
  const head = h(
    'button',
    {
      type: 'button', class: 'qb-head', 'data-key': 'qb-toggle', 'aria-expanded': String(state.open), 'aria-controls': 'qb-panel',
      title: t('qb.toggle'),
      onclick: () => setOpen(!state.open),
    },
    h('span', { class: 'qb-title' }, h('span', { class: 'qb-label' }, cur.label), h('small', { class: 'qb-range' }, t('qb.range', { from: refLabel(startRef), to: refLabel(endRef) }))),
    chev,
  );
  const root = h('div', { class: `qb${state.open ? ' open' : ''}` }, h('h1', { class: 'qb-h1' }, head), panel);

  const go = (hash: string) => {
    setOpen(false);
    state.query = '';
    state.expanded.clear();
    app.navigate(hash);
  };

  function setOpen(open: boolean): void {
    state.open = open;
    root.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open) {
      build();
      queueMicrotask(() => scrollToCurrent());
    } else replaceChildren(panel);
  }

  // ------------------------------------------------------------------ panel
  const list = h('div', { class: 'qb-list', role: 'tabpanel' });
  const tabsBar = h('div', { class: 'qb-tabs', role: 'tablist', 'aria-label': t('qb.tabs') });
  const search = h('input', {
    type: 'search', class: 'qb-search', 'data-key': 'qb-search', placeholder: t('qb.search'), 'aria-label': t('qb.search'),
    enterkeyhint: 'go', autocomplete: 'off', value: state.query,
    oninput: () => { state.query = search.value; state.expanded.clear(); renderList(); },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const ref = parseRef(state.query);
        if (ref) return go(surahHash(ref.surah, ref.ayah));
        const first = list.querySelector<HTMLAnchorElement>('a.qb-link');
        if (first) go(first.getAttribute('href') ?? '');
      }
    },
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      head.focus();
    }
  });

  function chip(label: string, hash: string, key: string): HTMLElement {
    return h('a', { class: 'qb-chip', href: hash, 'data-key': key, onclick: (e: Event) => { e.preventDefault(); go(hash); } }, label);
  }

  function build(): void {
    const recent = app.recentReads.length ? app.recentReads : app.readingPosition ? [app.readingPosition] : [];
    replaceChildren(
      panel,
      h('div', { class: 'qb-section-title' }, t('qb.lastRead')),
      h('div', { class: 'qb-chips' }, recent.length
        ? recent.map((r, i) => chip(refLabel(r), surahHash(r.surah, r.ayah), `qb-recent-${i}`))
        : h('span', { class: 'muted qb-empty' }, t('qb.noRecent'))),
      h('div', { class: 'qb-section-title' }, t('qb.quickLinks')),
      h('div', { class: 'qb-chips' }, QUICK_LINKS.map((q) => chip(t(`qb.quick.${q.key}`), surahHash(q.surah, q.ayah), `qb-quick-${q.key}`))),
      h('div', { class: 'qb-tools' }, tabsBar, h('label', { class: 'qb-search-wrap' }, icon('search'), search)),
      list,
    );
    renderTabs();
    renderList();
  }

  function renderTabs(): void {
    replaceChildren(tabsBar, TABS.map((tab) => h('button', {
      type: 'button', role: 'tab', class: 'qb-tab', 'data-key': `qb-tab-${tab}`, 'aria-selected': String(state.tab === tab),
      onclick: () => {
        state.tab = tab;
        state.expanded.clear();
        renderTabs();
        renderList();
        scrollToCurrent();
      },
    }, tab === 'surah' ? t('common.surah') : kindName(tab))));
  }

  function parseRef(q: string): { surah: number; ayah: number } | null {
    const m = /^\s*(\d{1,3})\s*[:.\/\u060c,\s]\s*(\d{1,3})\s*$/.exec(toLatinDigits(q));
    if (!m) return null;
    const s = Number(m[1]);
    const a = Number(m[2]);
    return s >= 1 && s <= 114 && a >= 1 && a <= surahInfo(s).ayahCount ? { surah: s, ayah: a } : null;
  }

  /** One row: title (+ arrow to expand), where it starts, and its first words. */
  function row(opts: { key: string; title: string; sub: string; hash: string; startIndex: number; current: boolean; expand?: () => Child }): HTMLElement {
    const open = !!opts.expand && state.expanded.has(opts.key);
    const words = startWords(app, opts.startIndex);
    const exp = opts.expand
      ? h('button', {
        type: 'button', class: 'qb-exp icon', 'data-key': `qb-exp-${opts.key}`, 'aria-expanded': String(open),
        'aria-label': t(open ? 'qb.collapse' : 'qb.expand', { name: opts.title }),
        onclick: () => {
          if (state.expanded.has(opts.key)) state.expanded.delete(opts.key);
          else state.expanded.add(opts.key);
          li.replaceWith(row(opts));
        },
      }, icon('chevronDown'))
      : null;
    // The whole line opens the portion; the title is the accessible link, the arrow only expands.
    const line = h(
      'div',
      {
        class: 'qb-go',
        onclick: (e: Event) => {
          if ((e.target as HTMLElement).closest('.qb-exp')) return;
          e.preventDefault();
          go(opts.hash);
        },
      },
      h('span', { class: 'qb-tcell' }, h('a', { class: 'qb-link qb-t', href: opts.hash, 'data-key': `qb-row-${opts.key}`, 'aria-current': opts.current ? 'true' : null }, opts.title), exp),
      opts.sub ? h('small', { class: 'qb-s' }, opts.sub) : null,
      words ? h('span', { class: 'qb-w', lang: 'ar', dir: 'rtl', 'aria-hidden': 'true' }, words) : null,
    );
    const li = h('li', { class: `qb-row${opts.current ? ' current' : ''}${open ? ' expanded' : ''}`, dataset: { key: opts.key } }, line, open && opts.expand ? h('div', { class: 'qb-sub' }, opts.expand()) : null);
    return li;
  }

  function quarterRows(parent: DivisionRange): HTMLElement {
    const index = app.quran.index;
    const curQ = index.numberAt('quarter', cur.startIndex);
    return h('ul', { class: 'qb-sublist' }, index.children(parent, 'quarter').map((q) => {
      const within = ((q.number - 1) % 4) + 1;
      const hizb = Math.ceil(q.number / 4);
      const hash = within === 1 ? `#/quran?hizb=${hizb}&focus=${q.startIndex}` : `#/quran?quarter=${q.number}&focus=${q.startIndex}`;
      const words = startWords(app, q.startIndex);
      return h('li', null, h('a', {
        class: `qb-go qb-link small${q.number === curQ && cur.division?.kind === 'quarter' ? ' current' : ''}`, href: hash, 'data-key': `qb-q-${q.number}`,
        onclick: (e: Event) => { e.preventDefault(); go(hash); },
      },
      h('span', { class: 'qb-t' }, within === 1 ? divisionLabel('hizb', hizb) : t('division.quarterOfHizb', { q: within, hizb })),
      h('small', { class: 'qb-s' }, refLabel(q.start)),
      words ? h('span', { class: 'qb-w', lang: 'ar', dir: 'rtl' }, words) : null));
    }));
  }

  function ayahJump(s: number): HTMLElement {
    const input = h('input', { type: 'number', min: '1', max: String(surahInfo(s).ayahCount), inputmode: 'numeric', placeholder: t('quran.ayahPlaceholder'), 'aria-label': t('qb.ayahIn', { name: surahName(s) }), 'data-key': `qb-ayah-${s}` });
    const submit = () => {
      const a = Number(toLatinDigits(input.value));
      if (!Number.isInteger(a) || a < 1 || a > surahInfo(s).ayahCount) {
        app.toast(t('quran.ayahCount', { name: surahName(s), count: surahInfo(s).ayahCount }), 'error');
        return;
      }
      go(surahHash(s, a));
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    queueMicrotask(() => input.focus({ preventScroll: true }));
    return h('div', { class: 'qb-ayah row' }, input, h('button', { type: 'button', class: 'primary', onclick: submit }, t('common.go')), h('small', { class: 'muted' }, t('qb.ayahRange', { count: surahInfo(s).ayahCount })));
  }

  function renderList(): void {
    const tab = state.tab ?? 'surah';
    const index = app.quran.index;
    const q = state.query.trim();
    const nq = norm(toLatinDigits(q));
    const num = /^\d+$/.test(toLatinDigits(q)) ? Number(toLatinDigits(q)) : null;
    const items: HTMLElement[] = [];
    const ref = parseRef(q);
    if (ref) {
      items.push(row({ key: `ref-${ref.surah}-${ref.ayah}`, title: t('qb.goTo', { ref: refLabel(ref) }), sub: '', hash: surahHash(ref.surah, ref.ayah), startIndex: toIndex(ref), current: false }));
    }
    if (tab === 'surah') {
      const curS = cur.surah ?? fromIndex(cur.startIndex).surah;
      for (const s of SURAHS) {
        if (q && !ref && !(num !== null ? String(s.number).startsWith(String(num)) : norm(s.nameTransliterated).includes(nq) || norm(s.nameArabic).includes(nq) || norm(surahName(s.number)).includes(nq))) continue;
        items.push(row({
          key: `s-${s.number}`, title: `${fmtNum(s.number)}. ${surahName(s.number)}`, sub: t('qb.ayatCount', { count: fmtNum(s.ayahCount) }),
          hash: surahHash(s.number), startIndex: toIndex({ surah: s.number, ayah: 1 }), current: s.number === curS && !cur.division,
          expand: () => ayahJump(s.number),
        }));
      }
    } else {
      const kind: DivisionKind = tab;
      if (!index.has(kind)) {
        replaceChildren(list, h('p', { class: 'muted qb-empty' }, t('qb.notLoaded', { kind: kindName(kind) }), ' ', h('a', { href: '#/settings?section=data' }, t('common.downloadQuranData'))));
        return;
      }
      const curN = index.numberAt(kind, cur.startIndex);
      const exact = cur.division?.kind === kind || (kind === 'hizb' && cur.division?.kind === 'quarter');
      for (const r of index.all(kind)) {
        if (q && !ref && (num === null || !String(r.number).startsWith(String(num)))) continue;
        items.push(row({
          key: `${kind}-${r.number}`, title: divisionLabel(kind, r.number), sub: refLabel(r.start),
          hash: `#/quran?${kind}=${r.number}`, startIndex: r.startIndex, current: exact && r.number === curN,
          ...(kind === 'juz' || kind === 'hizb' ? (index.has('quarter') ? { expand: () => quarterRows(r) } : {}) : {}),
        }));
      }
    }
    replaceChildren(list, items.length ? h('ul', { class: 'qb-rows' }, items) : h('p', { class: 'muted qb-empty' }, t('qb.noMatch')));
  }

  function scrollToCurrent(): void {
    const el = list.querySelector<HTMLElement>('.qb-row.current');
    list.scrollTop = el ? Math.max(0, el.offsetTop - list.clientHeight / 3) : 0;
  }

  if (state.open) {
    build();
    queueMicrotask(() => scrollToCurrent());
  }
  return root;
}

/** Arabic-Indic and Persian digits → ASCII, so Arabic-digit references work in the search field. */
function toLatinDigits(s: string): string {
  return s.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}
