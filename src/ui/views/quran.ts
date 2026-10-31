import { isUnresolved, suggestedCategory, type Mistake } from '../../core/model.ts';
import { DivisionUnavailableError } from '../../core/quran/divisions.ts';
import { nextPortion, portionQuery, type NextPortion } from '../../core/reading/autoScroll.ts';
import { fromIndex, surahEndIndex, surahStartIndex, toIndex } from '../../core/quran/refs.ts';
import { SURAHS, surahInfo } from '../../core/quran/surahs.ts';
import type { AyahRef, DivisionKind, DivisionRange } from '../../core/quran/types.ts';
import { DEFAULT_PREFERENCES } from '../../core/settings/preferences.ts';
import type { App } from '../app.ts';
import { AutoScrollSession, type PortionInfo } from '../components/autoScroll.ts';
import { openDialog } from '../components/dialog.ts';
import { icon } from '../components/icons.ts';
import { openMarkDialog, statusChip } from '../components/markDialog.ts';
import { arabicDigits, h, type Child } from '../dom.ts';
import { dir, fmtNum, t, tn } from '../i18n/index.ts';
import { categoryLabel, divisionLabel, errorText, kindName, refLabel, surahName, surahOption } from '../i18n/labels.ts';

const KINDS: DivisionKind[] = ['juz', 'hizb', 'quarter', 'eighth', 'page'];

interface ViewRange {
  readonly start: number;
  readonly end: number;
  readonly division: DivisionRange | null;
  readonly surah: number | null;
}

function resolveRange(app: App): { range: ViewRange; problem: string | null } {
  const p = app.route.params;
  const index = app.quran.index;
  for (const kind of KINDS) {
    const v = p.get(kind);
    if (v === null) continue;
    try {
      const d = index.range(kind, Number(v));
      return { range: { start: d.startIndex, end: d.endIndex, division: d, surah: null }, problem: null };
    } catch (e) {
      const msg = e instanceof DivisionUnavailableError ? errorText(e) : t('error.divisionMissing', { label: divisionLabel(kind, Number(v)) });
      const s = app.readingPosition?.surah ?? 1;
      return { range: { start: surahStartIndex(s), end: surahEndIndex(s), division: null, surah: s }, problem: msg };
    }
  }
  const s = Number(p.get('surah') ?? app.readingPosition?.surah ?? 1);
  const surah = s >= 1 && s <= 114 ? s : 1;
  return { range: { start: surahStartIndex(surah), end: surahEndIndex(surah), division: null, surah }, problem: null };
}

function mistakeMaps(mistakes: readonly Mistake[]) {
  const byWord = new Map<string, Mistake>();
  const byAyah = new Map<number, Mistake[]>();
  for (const m of mistakes) {
    byWord.set(`${m.globalIndex}:${m.word?.position ?? 'a'}`, m);
    byAyah.set(m.globalIndex, [...(byAyah.get(m.globalIndex) ?? []), m]);
  }
  return { byWord, byAyah };
}

function navigator(app: App, range: ViewRange): HTMLElement {
  const index = app.quran.index;
  const go = (q: string) => app.navigate(`#/quran?${q}`);
  const surahSel = h(
    'select',
    { id: 'nav-surah', onchange: () => surahSel.value && go(`surah=${surahSel.value}`) },
    range.surah === null ? h('option', { value: '', selected: true }, t('common.choose')) : null,
    SURAHS.map((s) => h('option', { value: String(s.number), selected: range.surah === s.number }, surahOption(s.number))),
  );
  const ayahInput = h('input', { id: 'nav-ayah', type: 'number', min: '1', placeholder: t('quran.ayahPlaceholder'), style: { width: '5.5rem' } });
  const goAyah = () => {
    const s = Number(surahSel.value);
    const a = Number(ayahInput.value);
    if (!Number.isInteger(a) || a < 1 || a > surahInfo(s).ayahCount) {
      app.toast(t('quran.ayahCount', { name: surahName(s), count: surahInfo(s).ayahCount }), 'error');
      return;
    }
    go(`surah=${s}&focus=${toIndex({ surah: s, ayah: a })}`);
  };
  const divisionSelect = (kind: DivisionKind) => {
    const n = index.count(kind);
    const current = range.division?.kind === kind ? range.division.number : null;
    const label = (i: number) => {
      if (kind === 'quarter') return t('division.optionQuarter', { n: i, hizb: Math.ceil(i / 4), within: ((i - 1) % 4) + 1 });
      if (kind === 'eighth') return t('division.optionEighth', { n: i, hizb: Math.ceil(i / 8), within: ((i - 1) % 8) + 1 });
      return fmtNum(i);
    };
    const sel = h(
      'select',
      { id: `nav-${kind}`, disabled: n === 0, onchange: () => go(`${kind}=${sel.value}`) },
      h('option', { value: '' }, n === 0 ? t('common.notLoaded') : t('common.choose')),
      Array.from({ length: n }, (_, i) => h('option', { value: String(i + 1), selected: current === i + 1 }, label(i + 1))),
    );
    return h('label', { class: 'field' }, h('span', null, kindName(kind)), sel);
  };
  return h(
    'div',
    { class: 'navigator panel' },
    h('label', { class: 'field' }, h('span', null, t('common.surah')), surahSel),
    h('label', { class: 'field' }, h('span', null, t('common.ayah')), h('div', { class: 'row' }, ayahInput, h('button', { type: 'button', onclick: goAyah }, t('common.go')))),
    KINDS.map(divisionSelect),
  );
}

function stepLinks(app: App, range: ViewRange): HTMLElement {
  const d = range.division;
  if (d) {
    const max = app.quran.index.count(d.kind);
    return h(
      'div',
      { class: 'row spread step-links' },
      h('button', { type: 'button', disabled: d.number <= 1, onclick: () => app.navigate(`#/quran?${d.kind}=${d.number - 1}`) }, t('quran.prevDivision', { kind: kindName(d.kind) })),
      h('strong', null, divisionLabel(d.kind, d.number)),
      h('button', { type: 'button', disabled: d.number >= max, onclick: () => app.navigate(`#/quran?${d.kind}=${d.number + 1}`) }, t('quran.nextDivision', { kind: kindName(d.kind) })),
    );
  }
  const s = range.surah ?? 1;
  return h(
    'div',
    { class: 'row spread step-links' },
    h('button', { type: 'button', disabled: s <= 1, onclick: () => app.navigate(`#/quran?surah=${s - 1}`) }, t('quran.prevSurah')),
    h('strong', null, t('quran.surahHeading', { name: surahName(s), count: surahInfo(s).ayahCount })),
    h('button', { type: 'button', disabled: s >= 114, onclick: () => app.navigate(`#/quran?surah=${s + 1}`) }, t('quran.nextSurah')),
  );
}

/** Marker shown inside the text where a quarter/eighth/hizb starts. */
function divisionMarker(app: App, idx: number): HTMLElement | null {
  const index = app.quran.index;
  const startsAt = (kind: DivisionKind) => {
    const n = index.numberAt(kind, idx);
    return n !== null && index.range(kind, n).startIndex === idx ? n : null;
  };
  const juz = startsAt('juz');
  const hizb = startsAt('hizb');
  const quarter = startsAt('quarter');
  const eighth = startsAt('eighth');
  const parts: string[] = [];
  if (juz) parts.push(t('division.markerJuz', { n: juz }));
  if (hizb) parts.push(t('division.markerHizb', { n: hizb }));
  else if (quarter) parts.push(t('division.markerQuarter', { hizb: Math.ceil(quarter / 4), q: ((quarter - 1) % 4) + 1 }));
  else if (eighth) parts.push(t('division.markerEighth', { hizb: Math.ceil(eighth / 8), e: ((eighth - 1) % 8) + 1 }));
  return parts.length ? h('span', { class: 'division-marker', role: 'note', dir: dir() }, parts.join(t('common.listSep'))) : null;
}

/**
 * Full-width band where a mushaf page begins (e.g. "Page 155"). Also shown at the top of the view
 * when the portion starts mid-page, so the reader always knows which page they are on.
 */
function pageMarker(app: App, idx: number, atRangeStart: boolean): HTMLElement | null {
  const index = app.quran.index;
  if (!index.has('page')) return null;
  const n = index.numberAt('page', idx);
  if (n === null) return null;
  if (!atRangeStart && index.range('page', n).startIndex !== idx) return null;
  return h('div', { class: 'page-marker', role: 'note', dir: dir(), dataset: { page: n } }, t('division.markerPage', { n }));
}

function ayahActions(app: App, ref: AyahRef, ms: readonly Mistake[]) {
  const idx = toIndex(ref);
  openDialog({
    title: refLabel(ref),
    body: [
      ms.length
        ? h('ul', { class: 'sub-list' }, ms.map((m) => h('li', null, h('button', { type: 'button', onclick: () => void openMarkDialog(app, { ref, word: m.word }) }, h('span', null, m.word ? t('common.word', { n: m.word.position }) : t('common.wholeAyah')), statusChip(m)))))
        : h('p', { class: 'muted' }, t('quran.noMistakesOnAyah')),
    ],
    actions: (close) => [
      h('button', { type: 'button', onclick: () => { close(); void app.setReadingPosition(ref).then(() => app.toast(t('quran.positionSet', { ref: refLabel(ref) }))); } }, t('quran.setPosition')),
      h('button', {
        type: 'button',
        onclick: () => {
          close();
          const p = app.prefs ?? DEFAULT_PREFERENCES;
          app.prepare({
            mode: ms.some((m) => isUnresolved(m.status)) ? 'mistakes' : 'full',
            scope: { type: 'range', start: ref, end: ref },
            planId: null,
            label: `${ref.surah}:${ref.ayah}`,
            options: { contextBefore: p.contextBefore, contextAfter: p.contextAfter, contextAcrossSurahs: p.contextAcrossSurahs, wordPractice: p.wordPractice },
            repeat: p.repeat,
            portionAyahRepeat: p.repeat.ayahRepeat,
            reciterId: p.reciterId,
          }, () => refLabel(ref));
        },
      }, t('quran.listen')),
      h('button', { type: 'button', class: 'primary', 'data-key': `markayah-${idx}`, onclick: () => { close(); void openMarkDialog(app, { ref, word: null }); } }, ms.some((m) => !m.word) ? t('quran.openAyahMistake') : t('quran.markAyah')),
    ],
  });
}

function textBody(app: App, range: ViewRange, maps: ReturnType<typeof mistakeMaps>): HTMLElement {
  const text = app.quran.text;
  const container = h('div', { class: 'quran', lang: 'ar', dir: 'rtl' });
  const current = app.readingPosition ? toIndex(app.readingPosition) : null;
  for (let idx = range.start; idx <= range.end; idx++) {
    const ref = fromIndex(idx);
    const ayah = text?.ayahAt(idx);
    const page = pageMarker(app, idx, idx === range.start);
    if (page) container.append(page);
    if (idx === range.start && ref.ayah !== 1) {
      const info = surahInfo(ref.surah);
      container.append(h('div', { class: 'surah-head', dir: dir() }, h('span', { class: 'tr' }, t('quran.continuing', { name: surahName(info.number), ref: `${ref.surah}:${ref.ayah}` }))));
    }
    if (ref.ayah === 1) {
      const info = surahInfo(ref.surah);
      container.append(h('div', { class: 'surah-head', dir: dir() }, h('span', { class: 'ar', lang: 'ar', dir: 'rtl' }, `سورة ${info.nameArabic}`), h('span', { class: 'tr' }, t('quran.surahInfo', { n: info.number, name: surahName(info.number), count: info.ayahCount }))));
      if (ayah?.basmalaPrefix) container.append(h('div', { class: 'basmala' }, ayah.basmalaPrefix));
    }
    const marker = divisionMarker(app, idx);
    if (marker) container.append(marker);
    const ms = maps.byAyah.get(idx) ?? [];
    const ayahMark = ms.find((m) => !m.word);
    const children: Child[] = [];
    for (const t of ayah?.tokens ?? []) {
      if (t.position === null) {
        children.push(h('span', { class: 'pause-mark', 'aria-hidden': 'true' }, t.text), ' ');
        continue;
      }
      const m = maps.byWord.get(`${idx}:${t.position}`);
      children.push(
        h(
          'button',
          {
            type: 'button',
            class: `w${m ? ' marked' : ''}${m && m.status === 'resolved' ? ' resolved' : ''}`,
            dataset: { a: idx, p: t.position, key: `w-${idx}-${t.position}` },
            'aria-describedby': m ? 'marked-desc' : null,
          },
          t.text,
        ),
        ' ',
      );
    }
    const allResolved = ms.length > 0 && ms.every((m) => m.status === 'resolved');
    children.push(
      h('button', {
        type: 'button',
        class: `ayah-end${ms.length ? ' has-mistake' : ''}${allResolved ? ' all-resolved' : ''}`,
        dataset: { end: idx, key: `end-${idx}` },
        'aria-label': tn('quran.ayahAria', ms.length, { ref: refLabel(ref) }),
      }, arabicDigits(ref.ayah)),
      ' ',
    );
    container.append(h('span', { class: `ayah${idx === current ? ' current' : ''}${ayahMark && isUnresolved(ayahMark.status) ? ' marked-ayah' : ''}`, id: `a-${idx}`, dataset: { idx } }, children));
  }
  container.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!el) return;
    if (app.autoScroll?.active) {
      // Focus mode: a tap on a word records a mistake at once; ayah numbers are inert.
      if (el.classList.contains('w')) void quickMark(app, el);
      return;
    }
    if (el.classList.contains('w')) {
      const idx = Number(el.dataset.a);
      const pos = Number(el.dataset.p);
      const ref = fromIndex(idx);
      void app.setReadingPosition(ref);
      void openMarkDialog(app, { ref, word: { position: pos, tokenText: el.textContent ?? '' } });
    } else if (el.dataset.end) {
      const idx = Number(el.dataset.end);
      ayahActions(app, fromIndex(idx), maps.byAyah.get(idx) ?? []);
    }
  });
  return container;
}

/**
 * Auto-scroll mode: marks the tapped word without opening the dialog. The type follows the same
 * rule as the dialog's suggestion: first word of an ayah = linking ayat, otherwise forgotten word.
 * The word is updated in place (no re-render) so scrolling stays smooth; Undo is offered.
 */
async function quickMark(app: App, el: HTMLElement): Promise<void> {
  const idx = Number(el.dataset.a);
  const position = Number(el.dataset.p);
  const ref = fromIndex(idx);
  const where = t('mark.where', { ref: refLabel(ref), n: position });
  const edition = app.quran.text?.edition;
  if (!edition) {
    app.toast(t('error.wordNeedsText'), 'error');
    return;
  }
  await app.act(async () => {
    const existing = await app.s.mistakes.findByKey(ref, position);
    if (existing && isUnresolved(existing.status)) {
      app.toast(t('auto.alreadyMarked', { where }));
      return;
    }
    const category = existing?.category ?? suggestedCategory(position) ?? 'forgotten';
    const result = await app.s.mistakes.markWord(ref, { position, tokenText: el.textContent ?? '', edition }, { category });
    const paint = (state: 'marked' | 'resolved' | 'none') => {
      el.classList.toggle('marked', state !== 'none');
      el.classList.toggle('resolved', state === 'resolved');
      if (state === 'none') el.removeAttribute('aria-describedby');
      else el.setAttribute('aria-describedby', 'marked-desc');
    };
    paint('marked');
    el.classList.remove('just-marked');
    void el.offsetWidth; // restart the confirmation pulse
    el.classList.add('just-marked');
    await app.reloadData();
    app.toast(t('auto.marked', { cat: categoryLabel(category), where }), 'info', {
      label: t('auto.undo'),
      key: 'as-undo',
      run: () => void app.act(async () => {
        if (result.action === 'created') {
          await app.s.mistakes.deletePermanently(result.mistake.id);
          paint('none');
        } else {
          await app.s.mistakes.resolve(result.mistake.id);
          paint('resolved');
        }
        await app.reloadData();
      }, t('auto.undone')),
    });
  });
}

function refOnlyBody(app: App, range: ViewRange, maps: ReturnType<typeof mistakeMaps>): HTMLElement {
  const rows: HTMLElement[] = [];
  for (let idx = range.start; idx <= range.end; idx++) {
    const ref = fromIndex(idx);
    const ms = maps.byAyah.get(idx) ?? [];
    const page = pageMarker(app, idx, idx === range.start);
    if (page) rows.push(page);
    const marker = divisionMarker(app, idx);
    if (marker) rows.push(marker);
    rows.push(
      h(
        'div',
        { class: 'ayah-row', id: `a-${idx}`, dataset: { idx } },
        h('span', null, refLabel(ref)),
        h('span', { class: 'row' }, ms.map((m) => statusChip(m)), h('button', { type: 'button', 'data-key': `end-${idx}`, onclick: () => ayahActions(app, ref, ms) }, ms.length ? t('quran.options') : t('quran.markOrListen'))),
      ),
    );
  }
  return h('div', { class: 'ref-only' }, rows);
}

function startWords(app: App, idx: number): string | null {
  const t = app.quran.text?.ayahAt(idx);
  if (!t) return null;
  return t.tokens.filter((x) => x.position !== null).slice(0, 3).map((x) => x.text).join(' ');
}

function divisionPanel(app: App, range: ViewRange): HTMLElement {
  const index = app.quran.index;
  const inRange = app.data.mistakes.filter((m) => m.globalIndex >= range.start && m.globalIndex <= range.end);
  const unresolved = inRange.filter((m) => isUnresolved(m.status)).length;
  const d = range.division;
  const startRef = fromIndex(range.start);
  const endRef = fromIndex(range.end);
  const loc = index.locate(startRef);
  const pos = app.readingPosition && toIndex(app.readingPosition) >= range.start && toIndex(app.readingPosition) <= range.end ? refLabel(app.readingPosition) : t('quran.notInPortion');

  const subItem = (r: DivisionRange, cls: string, label: string) => {
    const w = startWords(app, r.startIndex);
    const count = inRange.filter((m) => m.globalIndex >= r.startIndex && m.globalIndex <= r.endIndex && isUnresolved(m.status)).length;
    return h(
      'li',
      { class: cls },
      h(
        'button',
        { type: 'button', onclick: () => app.navigate(`#/quran?${r.kind}=${r.number}&focus=${r.startIndex}`) },
        h('span', null, h('strong', null, label), h('br'), h('small', null, t('quran.fromRef', { ref: refLabel(r.start) })), count ? h('small', { style: { color: 'var(--mistake)' } }, t('quran.openCount', { count })) : null),
        w ? h('span', { class: 'start-words', lang: 'ar', dir: 'rtl' }, w) : null,
      ),
    );
  };

  let subs: Child = null;
  if (d && (d.kind === 'hizb' || d.kind === 'juz' || d.kind === 'quarter')) {
    const quarters = d.kind === 'quarter' ? [] : index.children(d, 'quarter');
    const eighthsOf = (q: DivisionRange) => index.children(q, 'eighth');
    const items: HTMLElement[] = [];
    if (d.kind === 'quarter') {
      for (const e of eighthsOf(d)) items.push(subItem(e, 'eighth', t('division.eighthOfHizb', { e: ((e.number - 1) % 8) + 1, hizb: Math.ceil(e.number / 8) })));
    } else {
      for (const q of quarters) {
        items.push(subItem(q, 'quarter', t('division.quarterOfHizb', { q: ((q.number - 1) % 4) + 1, hizb: Math.ceil(q.number / 4) })));
        for (const e of eighthsOf(q)) items.push(subItem(e, 'eighth', t('division.eighthN', { e: ((e.number - 1) % 8) + 1 })));
      }
    }
    subs = h(
      'div',
      null,
      h('h3', { style: { 'margin-top': '1rem' } }, t('quran.subdivisions')),
      items.length ? h('ul', { class: 'sub-list' }, items) : h('p', { class: 'muted' }, t('quran.noQuarters')),
      !index.has('eighth') ? h('p', { class: 'muted', style: { 'margin-top': '0.5rem' } }, t('quran.noEighths')) : null,
    );
  }

  return h(
    'aside',
    { class: 'panel division-panel', 'aria-label': t('quran.portionDetails') },
    h('h2', null, d ? divisionLabel(d.kind, d.number) : t('scope.surah', { name: surahName(range.surah ?? 1) })),
    h(
      'dl',
      { class: 'kv' },
      h('dt', null, t('common.starts')), h('dd', null, refLabel(startRef)),
      h('dt', null, t('common.ends')), h('dd', null, refLabel(endRef)),
      h('dt', null, t('common.ayat')), h('dd', null, fmtNum(range.end - range.start + 1)),
      h('dt', null, t('common.juz')), h('dd', null, `${loc.juz ?? '—'}${index.locate(endRef).juz !== loc.juz ? `–${index.locate(endRef).juz}` : ''}`),
      index.has('hizb') ? [h('dt', null, t('common.hizb')), h('dd', null, `${loc.hizb}${index.locate(endRef).hizb !== loc.hizb ? `–${index.locate(endRef).hizb}` : ''}`)] : null,
      h('dt', null, t('quran.readingPosition')), h('dd', { id: 'reading-pos' }, pos),
      h('dt', null, t('common.markedMistakes')), h('dd', null, fmtNum(inRange.length)),
      h('dt', null, t('common.unresolved')), h('dd', null, fmtNum(unresolved)),
      h('dt', null, t('common.resolved')), h('dd', null, fmtNum(inRange.length - unresolved)),
    ),
    h(
      'div',
      { class: 'row' },
      h('button', {
        type: 'button', class: 'primary', disabled: unresolved === 0,
        onclick: () => {
          const p = app.prefs;
          const scope = d ? { type: 'division' as const, kind: d.kind, number: d.number } : { type: 'surahs' as const, surahs: [range.surah ?? 1] };
          app.prepare({ mode: 'mistakes', scope, planId: null, label: d ? `${d.kind} ${d.number}` : `surah ${range.surah ?? 1}`, options: { contextBefore: p.contextBefore, contextAfter: p.contextAfter, contextAcrossSurahs: p.contextAcrossSurahs, wordPractice: p.wordPractice, categories: p.categories }, repeat: p.repeat, portionAyahRepeat: p.portionAyahRepeat, reciterId: p.reciterId });
        },
      }, t('quran.reviseHere')),
      d ? h('button', { type: 'button', onclick: () => void app.act(async () => { await app.s.plans.setPlan(app.today(), { type: 'division', kind: d.kind, number: d.number }); await app.refresh(); }, t('quran.madeToday', { label: divisionLabel(d.kind, d.number) })) }, t('quran.makeToday')) : null,
    ),
    subs,
  );
}

/** Explains the colours used for marks inside the Quran text (colour is never the only cue). */
function legend(): HTMLElement {
  return h(
    'div',
    { class: 'legend', role: 'note', 'aria-label': t('quran.legend') },
    h('span', null, h('span', { class: 'swatch marked', 'aria-hidden': 'true' }), t('quran.legendMarked')),
    h('span', null, h('span', { class: 'swatch resolved', 'aria-hidden': 'true' }), t('quran.legendResolved')),
    h('span', null, h('span', { class: 'swatch ayah', 'aria-hidden': 'true' }), t('quran.legendAyah')),
  );
}

function portionName(range: ViewRange): string {
  return range.division ? divisionLabel(range.division.kind, range.division.number) : t('scope.surah', { name: surahName(range.surah ?? 1) });
}

function nextName(p: NextPortion): string {
  return p.kind === 'surah' ? t('scope.surah', { name: surahName(p.number) }) : divisionLabel(p.kind, p.number);
}

function portionInfo(app: App, range: ViewRange): PortionInfo {
  const n = nextPortion(range, (k) => app.quran.index.count(k));
  return { label: portionName(range), next: n ? { hash: `#/quran?${portionQuery(n)}`, label: nextName(n) } : null };
}

/** Floating button that starts auto-scroll focus mode from the current position. */
function autoScrollButton(app: App, range: ViewRange): HTMLElement {
  return h(
    'button',
    {
      type: 'button', class: 'autoscroll-fab', 'data-key': 'autoscroll-start',
      'aria-label': t('auto.start'), title: t('auto.start'),
      onclick: () => AutoScrollSession.start(app, portionInfo(app, range)),
    },
    icon('autoScroll'),
  );
}

export function quranView(app: App): Node {
  const { range, problem } = resolveRange(app);
  const maps = mistakeMaps(app.data.mistakes);
  const hasText = !!app.quran.text;
  const body = hasText ? textBody(app, range, maps) : refOnlyBody(app, range, maps);
  const mushaf = h('article', { class: 'mushaf', 'aria-label': t('quran.textLabel') }, body);
  app.autoScroll?.setPortion(portionInfo(app, range));

  // Scroll to a requested ayah and track the reading position while scrolling.
  const focus = Number(app.route.params.get('focus') ?? NaN);
  queueMicrotask(() => {
    if (Number.isInteger(focus)) document.getElementById(`a-${focus}`)?.scrollIntoView({ block: 'center' });
    if (typeof IntersectionObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const obs = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).map((e) => Number((e.target as HTMLElement).dataset.idx)).sort((a, b) => a - b)[0];
      if (!document.body.contains(mushaf)) {
        obs.disconnect();
        return;
      }
      if (visible === undefined) return;
      const ref = fromIndex(visible);
      const label = document.getElementById('reading-pos');
      if (label) label.textContent = refLabel(ref);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void app.setReadingPosition(ref), 800);
    }, { rootMargin: '-35% 0px -55% 0px' });
    mushaf.querySelectorAll('[data-idx]').forEach((el) => obs.observe(el));
  });

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('quran.title')), h('p', { class: 'muted' }, t('quran.intro')))),
    h('span', { id: 'marked-desc', class: 'sr-only' }, t('quran.markedDesc')),
    problem ? h('div', { class: 'notice warn', role: 'alert' }, problem) : null,
    !hasText
      ? h('div', { class: 'notice info' }, h('p', null, t('quran.noText')), h('a', { class: 'btn', href: '#/settings?section=data', 'data-key': 'download-data' }, t('common.downloadQuranData')))
      : null,
    navigator(app, range),
    h('div', { class: 'reader-layout' }, h('div', null, stepLinks(app, range), legend(), mushaf), divisionPanel(app, range)),
    hasText ? autoScrollButton(app, range) : null,
  );
}
