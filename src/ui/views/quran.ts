import { isUnresolved, type Mistake } from '../../core/model.ts';
import { DivisionUnavailableError } from '../../core/quran/divisions.ts';
import { formatRef, fromIndex, surahEndIndex, surahStartIndex, toIndex } from '../../core/quran/refs.ts';
import { kindLabel } from '../../core/quran/scope.ts';
import { SURAHS, surahInfo } from '../../core/quran/surahs.ts';
import type { AyahRef, DivisionKind, DivisionRange } from '../../core/quran/types.ts';
import { DEFAULT_PREFERENCES } from '../../core/settings/preferences.ts';
import type { App } from '../app.ts';
import { openDialog } from '../components/dialog.ts';
import { openMarkDialog, statusChip } from '../components/markDialog.ts';
import { arabicDigits, h, type Child } from '../dom.ts';

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
      const msg = e instanceof DivisionUnavailableError ? e.message : `${kindLabel(kind)} ${v} does not exist.`;
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
    range.surah === null ? h('option', { value: '', selected: true }, 'Choose…') : null,
    SURAHS.map((s) => h('option', { value: String(s.number), selected: range.surah === s.number }, `${s.number}. ${s.nameTransliterated}`)),
  );
  const ayahInput = h('input', { id: 'nav-ayah', type: 'number', min: '1', placeholder: 'Ayah', style: { width: '5.5rem' } });
  const goAyah = () => {
    const s = Number(surahSel.value);
    const a = Number(ayahInput.value);
    if (!Number.isInteger(a) || a < 1 || a > surahInfo(s).ayahCount) {
      app.toast(`${surahInfo(s).nameTransliterated} has ${surahInfo(s).ayahCount} ayat.`, 'error');
      return;
    }
    go(`surah=${s}&focus=${toIndex({ surah: s, ayah: a })}`);
  };
  const divisionSelect = (kind: DivisionKind) => {
    const n = index.count(kind);
    const current = range.division?.kind === kind ? range.division.number : null;
    const label = (i: number) => {
      if (kind === 'quarter') return `${i}  (Hizb ${Math.ceil(i / 4)}, ${((i - 1) % 4) + 1}/4)`;
      if (kind === 'eighth') return `${i}  (Hizb ${Math.ceil(i / 8)}, ${((i - 1) % 8) + 1}/8)`;
      return String(i);
    };
    const sel = h(
      'select',
      { id: `nav-${kind}`, disabled: n === 0, onchange: () => go(`${kind}=${sel.value}`) },
      h('option', { value: '' }, n === 0 ? 'Not loaded' : 'Choose…'),
      Array.from({ length: n }, (_, i) => h('option', { value: String(i + 1), selected: current === i + 1 }, label(i + 1))),
    );
    return h('label', { class: 'field' }, h('span', null, kindLabel(kind)), sel);
  };
  return h(
    'div',
    { class: 'navigator panel' },
    h('label', { class: 'field' }, h('span', null, 'Surah'), surahSel),
    h('label', { class: 'field' }, h('span', null, 'Ayah'), h('div', { class: 'row' }, ayahInput, h('button', { type: 'button', onclick: goAyah }, 'Go'))),
    KINDS.map(divisionSelect),
  );
}

function stepLinks(app: App, range: ViewRange): HTMLElement {
  const d = range.division;
  if (d) {
    const max = app.quran.index.count(d.kind);
    return h(
      'div',
      { class: 'row spread', style: { margin: '0 auto 0.75rem', 'max-width': '46rem' } },
      h('button', { type: 'button', disabled: d.number <= 1, onclick: () => app.navigate(`#/quran?${d.kind}=${d.number - 1}`) }, `Previous ${kindLabel(d.kind).toLowerCase()}`),
      h('strong', null, `${kindLabel(d.kind)} ${d.number}`),
      h('button', { type: 'button', disabled: d.number >= max, onclick: () => app.navigate(`#/quran?${d.kind}=${d.number + 1}`) }, `Next ${kindLabel(d.kind).toLowerCase()}`),
    );
  }
  const s = range.surah ?? 1;
  return h(
    'div',
    { class: 'row spread', style: { margin: '0 auto 0.75rem', 'max-width': '46rem' } },
    h('button', { type: 'button', disabled: s <= 1, onclick: () => app.navigate(`#/quran?surah=${s - 1}`) }, 'Previous surah'),
    h('strong', null, `${surahInfo(s).nameTransliterated} (${surahInfo(s).ayahCount} ayat)`),
    h('button', { type: 'button', disabled: s >= 114, onclick: () => app.navigate(`#/quran?surah=${s + 1}`) }, 'Next surah'),
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
  if (juz) parts.push(`Juz ${juz}`);
  if (hizb) parts.push(`Hizb ${hizb}`);
  else if (quarter) parts.push(`Hizb ${Math.ceil(quarter / 4)}, quarter ${((quarter - 1) % 4) + 1}`);
  else if (eighth) parts.push(`Hizb ${Math.ceil(eighth / 8)}, eighth ${((eighth - 1) % 8) + 1}`);
  return parts.length ? h('span', { class: 'division-marker', role: 'note' }, parts.join(', ')) : null;
}

function ayahActions(app: App, ref: AyahRef, ms: readonly Mistake[]) {
  const idx = toIndex(ref);
  openDialog({
    title: formatRef(ref),
    body: [
      ms.length
        ? h('ul', { class: 'sub-list' }, ms.map((m) => h('li', null, h('button', { type: 'button', onclick: () => void openMarkDialog(app, { ref, word: m.word }) }, h('span', null, m.word ? `Word ${m.word.position}` : 'Whole ayah'), statusChip(m)))))
        : h('p', { class: 'muted' }, 'No mistakes recorded on this ayah.'),
    ],
    actions: (close) => [
      h('button', { type: 'button', onclick: () => { close(); void app.setReadingPosition(ref).then(() => app.toast(`Reading position set to ${formatRef(ref)}.`)); } }, 'Set reading position'),
      h('button', {
        type: 'button',
        onclick: () => {
          close();
          const p = app.prefs ?? DEFAULT_PREFERENCES;
          app.prepare({
            mode: ms.some((m) => isUnresolved(m.status)) ? 'mistakes' : 'full',
            scope: { type: 'range', start: ref, end: ref },
            planId: null,
            label: formatRef(ref),
            options: { contextBefore: p.contextBefore, contextAfter: p.contextAfter, contextAcrossSurahs: p.contextAcrossSurahs, wordPractice: p.wordPractice },
            repeat: p.repeat,
            portionAyahRepeat: p.repeat.ayahRepeat,
            reciterId: p.reciterId,
          });
        },
      }, 'Listen and repeat'),
      h('button', { type: 'button', class: 'primary', 'data-key': `markayah-${idx}`, onclick: () => { close(); void openMarkDialog(app, { ref, word: null }); } }, ms.some((m) => !m.word) ? 'Open ayah mistake' : 'Mark whole ayah'),
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
    if (idx === range.start && ref.ayah !== 1) {
      const info = surahInfo(ref.surah);
      container.append(h('div', { class: 'surah-head', dir: 'ltr' }, h('span', { class: 'tr' }, `${info.nameTransliterated} (${info.nameArabic}), continuing from ${ref.surah}:${ref.ayah}`)));
    }
    if (ref.ayah === 1) {
      const info = surahInfo(ref.surah);
      container.append(h('div', { class: 'surah-head', dir: 'ltr' }, h('span', { class: 'ar', lang: 'ar', dir: 'rtl' }, `سورة ${info.nameArabic}`), h('span', { class: 'tr' }, `${info.number}. ${info.nameTransliterated}, ${info.ayahCount} ayat`)));
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
        'aria-label': `Ayah ${ref.surah}:${ref.ayah}${ms.length ? `, ${ms.length} recorded mistake${ms.length > 1 ? 's' : ''}` : ''}. Options`,
      }, arabicDigits(ref.ayah)),
      ' ',
    );
    container.append(h('span', { class: `ayah${idx === current ? ' current' : ''}${ayahMark && isUnresolved(ayahMark.status) ? ' marked-ayah' : ''}`, id: `a-${idx}`, dataset: { idx } }, children));
  }
  container.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!el) return;
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

function refOnlyBody(app: App, range: ViewRange, maps: ReturnType<typeof mistakeMaps>): HTMLElement {
  const rows: HTMLElement[] = [];
  for (let idx = range.start; idx <= range.end; idx++) {
    const ref = fromIndex(idx);
    const ms = maps.byAyah.get(idx) ?? [];
    const marker = divisionMarker(app, idx);
    if (marker) rows.push(marker);
    rows.push(
      h(
        'div',
        { class: 'ayah-row', id: `a-${idx}`, dataset: { idx } },
        h('span', null, formatRef(ref)),
        h('span', { class: 'row' }, ms.map((m) => statusChip(m)), h('button', { type: 'button', 'data-key': `end-${idx}`, onclick: () => ayahActions(app, ref, ms) }, ms.length ? 'Options' : 'Mark or listen')),
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
  const pos = app.readingPosition && toIndex(app.readingPosition) >= range.start && toIndex(app.readingPosition) <= range.end ? formatRef(app.readingPosition) : 'Not in this portion';

  const subItem = (r: DivisionRange, cls: string, label: string) => {
    const w = startWords(app, r.startIndex);
    const count = inRange.filter((m) => m.globalIndex >= r.startIndex && m.globalIndex <= r.endIndex && isUnresolved(m.status)).length;
    return h(
      'li',
      { class: cls },
      h(
        'button',
        { type: 'button', onclick: () => app.navigate(`#/quran?${r.kind}=${r.number}&focus=${r.startIndex}`) },
        h('span', null, h('strong', null, label), h('br'), h('small', null, `from ${formatRef(r.start)}`), count ? h('small', { style: { color: 'var(--mistake)' } }, `, ${count} open`) : null),
        w ? h('span', { class: 'start-words', lang: 'ar' }, w) : null,
      ),
    );
  };

  let subs: Child = null;
  if (d && (d.kind === 'hizb' || d.kind === 'juz' || d.kind === 'quarter')) {
    const quarters = d.kind === 'quarter' ? [] : index.children(d, 'quarter');
    const eighthsOf = (q: DivisionRange) => index.children(q, 'eighth');
    const items: HTMLElement[] = [];
    if (d.kind === 'quarter') {
      for (const e of eighthsOf(d)) items.push(subItem(e, 'eighth', `Eighth ${((e.number - 1) % 8) + 1} of Hizb ${Math.ceil(e.number / 8)}`));
    } else {
      for (const q of quarters) {
        items.push(subItem(q, 'quarter', `Quarter ${((q.number - 1) % 4) + 1} of Hizb ${Math.ceil(q.number / 4)}`));
        for (const e of eighthsOf(q)) items.push(subItem(e, 'eighth', `Eighth ${((e.number - 1) % 8) + 1}`));
      }
    }
    subs = h(
      'div',
      null,
      h('h3', { style: { 'margin-top': '1rem' } }, 'Subdivisions'),
      items.length ? h('ul', { class: 'sub-list' }, items) : h('p', { class: 'muted' }, 'Quarter data is not loaded.'),
      !index.has('eighth') ? h('p', { class: 'muted', style: { 'margin-top': '0.5rem' } }, 'Eighth (thumn) boundaries are not part of the Madani metadata. You can import a verified eighths list in Settings.') : null,
    );
  }

  return h(
    'aside',
    { class: 'panel division-panel', 'aria-label': 'Portion details' },
    h('h2', null, d ? `${kindLabel(d.kind)} ${d.number}` : `Surah ${surahInfo(range.surah ?? 1).nameTransliterated}`),
    h(
      'dl',
      { class: 'kv' },
      h('dt', null, 'Starts'), h('dd', null, formatRef(startRef)),
      h('dt', null, 'Ends'), h('dd', null, formatRef(endRef)),
      h('dt', null, 'Ayat'), h('dd', null, String(range.end - range.start + 1)),
      h('dt', null, 'Juz'), h('dd', null, `${loc.juz ?? '—'}${index.locate(endRef).juz !== loc.juz ? `–${index.locate(endRef).juz}` : ''}`),
      index.has('hizb') ? [h('dt', null, 'Hizb'), h('dd', null, `${loc.hizb}${index.locate(endRef).hizb !== loc.hizb ? `–${index.locate(endRef).hizb}` : ''}`)] : null,
      h('dt', null, 'Reading position'), h('dd', { id: 'reading-pos' }, pos),
      h('dt', null, 'Marked mistakes'), h('dd', null, String(inRange.length)),
      h('dt', null, 'Unresolved'), h('dd', null, String(unresolved)),
      h('dt', null, 'Resolved'), h('dd', null, String(inRange.length - unresolved)),
    ),
    h(
      'div',
      { class: 'row' },
      h('button', {
        type: 'button', class: 'primary', disabled: unresolved === 0,
        onclick: () => {
          const p = app.prefs;
          const scope = d ? { type: 'division' as const, kind: d.kind, number: d.number } : { type: 'surahs' as const, surahs: [range.surah ?? 1] };
          app.prepare({ mode: 'mistakes', scope, planId: null, label: d ? `${kindLabel(d.kind)} ${d.number}` : `Surah ${surahInfo(range.surah ?? 1).nameTransliterated}`, options: { contextBefore: p.contextBefore, contextAfter: p.contextAfter, contextAcrossSurahs: p.contextAcrossSurahs, wordPractice: p.wordPractice, categories: p.categories }, repeat: p.repeat, portionAyahRepeat: p.portionAyahRepeat, reciterId: p.reciterId });
        },
      }, 'Revise mistakes here'),
      d ? h('button', { type: 'button', onclick: () => void app.act(async () => { await app.s.plans.setPlan(app.today(), { type: 'division', kind: d.kind, number: d.number }); await app.refresh(); }, `${kindLabel(d.kind)} ${d.number} is today's revision.`) }, "Make today's revision") : null,
    ),
    subs,
  );
}

export function quranView(app: App): Node {
  const { range, problem } = resolveRange(app);
  const maps = mistakeMaps(app.data.mistakes);
  const hasText = !!app.quran.text;
  const body = hasText ? textBody(app, range, maps) : refOnlyBody(app, range, maps);
  const mushaf = h('article', { class: 'mushaf', 'aria-label': 'Quran text' }, body);

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
      if (label) label.textContent = formatRef(ref);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void app.setReadingPosition(ref), 800);
    }, { rootMargin: '-35% 0px -55% 0px' });
    mushaf.querySelectorAll('[data-idx]').forEach((el) => obs.observe(el));
  });

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Quran'), h('p', { class: 'muted' }, 'Tap a word to mark a mistake. Tap an ayah number to mark the whole ayah or listen to it.'))),
    h('span', { id: 'marked-desc', class: 'sr-only' }, 'Marked as a mistake'),
    problem ? h('div', { class: 'notice warn', role: 'alert' }, problem) : null,
    !hasText
      ? h('div', { class: 'notice info' }, h('p', null, 'The Quran text is not downloaded yet, so ayat are listed by reference. You can still mark whole ayat and listen to them.'), h('a', { class: 'btn', href: '#/settings?section=data' }, 'Download Quran data'))
      : null,
    navigator(app, range),
    h('div', { class: 'reader-layout' }, h('div', null, stepLinks(app, range), mushaf), divisionPanel(app, range)),
  );
}
