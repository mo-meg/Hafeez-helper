import { CATEGORY_LABELS, OUTCOME_LABELS, RECALL_OUTCOMES, type RecallOutcome } from '../../core/model.ts';
import { formatRef, fromIndex } from '../../core/quran/refs.ts';
import { describeScope, scopeIntervals, type RevisionScope } from '../../core/quran/scope.ts';
import { SURAHS, surahInfo } from '../../core/quran/surahs.ts';
import type { DivisionKind } from '../../core/quran/types.ts';
import {
  allowedOutcomes,
  buildTestCards,
  hint,
  initialReveal,
  isWordVisible,
  nextSegment,
  revealSegment,
  totalSteps,
  type RevealState,
  type TestCard,
} from '../../core/test/testBuilder.ts';
import type { App } from '../app.ts';
import { h, type Child } from '../dom.ts';

type TestKind = 'surah' | 'juz' | 'hizb' | 'quarter';
const KIND_LABEL: Record<TestKind, string> = { surah: 'Surah', juz: 'Juz', hizb: 'Hizb', quarter: 'Quarter (rub‘)' };

export interface ActiveTest {
  readonly sessionId: string;
  readonly scope: RevisionScope;
  readonly label: string;
  readonly cards: readonly TestCard[];
  index: number;
  reveal: RevealState;
  /** Answers keyed by `${cardId}:${segment}` (one per mistake step). */
  readonly answers: Map<string, RecallOutcome>;
  finished: boolean;
}

const setup = { kind: 'hizb' as TestKind, number: 1, surah: 1, includeResolved: false, shuffle: false };

function scopeFromSetup(): RevisionScope {
  return setup.kind === 'surah' ? { type: 'surahs', surahs: [setup.surah] } : { type: 'division', kind: setup.kind as DivisionKind, number: setup.number };
}

function wordCount(app: App, card: TestCard): number {
  return app.quran.text?.ayahAt(card.globalIndex).tokens.filter((t) => t.position !== null).length ?? 0;
}

function setupView(app: App): Node {
  const index = app.quran.index;
  if (setup.kind !== 'surah' && !index.has(setup.kind)) setup.kind = 'surah';
  const max = setup.kind === 'surah' ? 114 : index.count(setup.kind);
  if (setup.number > max) setup.number = 1;
  let cards: TestCard[] = [];
  let problem: string | null = null;
  try {
    cards = buildTestCards(app.data.mistakes, scopeIntervals(scopeFromSetup(), index), { includeResolved: setup.includeResolved });
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }
  const mistakes = cards.reduce((n, c) => n + c.mistakeIds.length, 0);
  const transitions = cards.filter((c) => c.kind === 'transition').length;
  const rerender = () => app.render(true);

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Test'), h('p', { class: 'muted' }, 'Check yourself on the places where you made mistakes. The text is hidden from your mistake to the end of the ayah; recite it, then reveal.'))),
    !app.quran.text
      ? h('div', { class: 'notice info' }, h('p', null, 'The test shows the Quran text, so it needs the text to be downloaded first.'), h('a', { class: 'btn', href: '#/settings?section=data' }, 'Download Quran data'))
      : null,
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'What do you want to be tested on?'),
      h(
        'div',
        { class: 'row', style: { 'align-items': 'flex-end' } },
        h('label', { class: 'field' }, h('span', null, 'Portion type'), h('select', { id: 'test-kind', 'data-key': 'test-kind', onchange: (e: Event) => { setup.kind = (e.target as HTMLSelectElement).value as TestKind; setup.number = 1; rerender(); } },
          (Object.keys(KIND_LABEL) as TestKind[]).map((k) => {
            const ok = k === 'surah' || index.has(k);
            return h('option', { value: k, selected: k === setup.kind, disabled: !ok }, ok ? KIND_LABEL[k] : `${KIND_LABEL[k]} (data not loaded)`);
          }))),
        setup.kind === 'surah'
          ? h('label', { class: 'field' }, h('span', null, 'Surah'), h('select', { id: 'test-surah', 'data-key': 'test-surah', onchange: (e: Event) => { setup.surah = Number((e.target as HTMLSelectElement).value); rerender(); } }, SURAHS.map((s) => h('option', { value: String(s.number), selected: s.number === setup.surah }, `${s.number}. ${s.nameTransliterated}`))))
          : h('label', { class: 'field' }, h('span', null, `Number (1–${max})`), h('input', { id: 'test-num', 'data-key': 'test-num', type: 'number', min: '1', max: String(max), value: String(setup.number), onchange: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); if (Number.isInteger(v) && v >= 1 && v <= max) setup.number = v; rerender(); } })),
      ),
      h('label', { class: 'choice' }, h('input', { type: 'checkbox', checked: setup.includeResolved, 'data-key': 'test-resolved', onchange: (e: Event) => { setup.includeResolved = (e.target as HTMLInputElement).checked; rerender(); } }), h('span', null, 'Also test mistakes I marked as resolved')),
      h('label', { class: 'choice' }, h('input', { type: 'checkbox', checked: setup.shuffle, 'data-key': 'test-shuffle', onchange: (e: Event) => { setup.shuffle = (e.target as HTMLInputElement).checked; rerender(); } }), h('span', null, 'Mix the order (otherwise Quran order)')),
      problem ? h('p', { role: 'alert', style: { color: 'var(--mistake)' } }, problem) : null,
      h(
        'div',
        { class: 'row spread', style: { 'margin-top': '0.75rem' } },
        h('span', null, cards.length ? `${cards.length} ayat to test (${mistakes} mistake${mistakes === 1 ? '' : 's'}; ${transitions} on linking ayat)` : `No ${setup.includeResolved ? '' : 'unresolved '}mistakes in ${describeScope(scopeFromSetup(), index)}.`),
        h('button', {
          type: 'button', class: 'primary big', 'data-key': 'test-start', disabled: cards.length === 0 || !app.quran.text,
          onclick: () => void app.act(async () => {
            const scope = scopeFromSetup();
            const ordered = buildTestCards(app.data.mistakes, scopeIntervals(scope, index), { includeResolved: setup.includeResolved, shuffle: setup.shuffle, seed: Date.now() % 100000 });
            const session = await app.s.plans.startSession({
              planId: null, mode: 'test', scope, reciterId: app.prefs.reciterId, repeat: app.prefs.repeat,
              mistakeAyahIndexes: ordered.map((c) => c.globalIndex).sort((a, b) => a - b), plannedSteps: totalSteps(ordered),
            });
            const first = ordered[0] as TestCard;
            app.test = { sessionId: session.id, scope, label: describeScope(scope, index), cards: ordered, index: 0, reveal: initialReveal(first), answers: new Map(), finished: false };
            await app.refresh();
          }),
        }, 'Start test'),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'How it works'),
      h('p', null, 'Every question shows the ayah before it in full, as a starting point.'),
      h('p', null, 'Mistake inside an ayah: the ayah is shown up to the word where you made the mistake. That word and the rest of the ayah are hidden.'),
      h('p', null, 'Mistake at the start of an ayah (linking ayat), or a whole-ayah mistake: the whole ayah is hidden, so you practise moving from one ayah to the next.'),
      h('p', null, 'Several mistakes in one ayah are asked one after another: “Reveal” stops just before your next mistake, which stays hidden until you answer.'),
      h('p', { class: 'muted' }, '“Hint” uncovers one word; after a hint the answer counts as “Needed a prompt”. Your answers update each mistake’s status, review schedule and progress. Nothing is marked resolved automatically.'),
    ),
  );
}

function ayahTokens(app: App, idx: number, card: TestCard | null, reveal: RevealState | null): Child {
  const ayah = app.quran.text?.ayahAt(idx);
  if (!ayah) return null;
  const marked = new Set(card?.markedPositions ?? []);
  let lastWordVisible = true;
  return ayah.tokens.map((t) => {
    if (t.position === null) return lastWordVisible ? [h('span', { class: 'pause-mark', 'aria-hidden': 'true' }, t.text), ' '] : null;
    const visible = !card || !reveal || isWordVisible(card, reveal, t.position);
    lastWordVisible = visible;
    if (!visible) return [h('span', { class: 'hidden-word', role: 'img', 'aria-label': 'hidden word', style: { '--len': String(Math.max(2, t.text.length)) } }), ' '];
    const wasHidden = card && t.position >= card.hideFrom;
    return [h('span', { class: `${marked.has(t.position) && wasHidden ? 'w marked' : 'w'}${wasHidden ? ' revealed' : ''}` }, t.text), ' '];
  });
}

async function answer(app: App, t: ActiveTest, card: TestCard, outcome: RecallOutcome) {
  const seg = card.segments[t.reveal.segment];
  const ok = await app.act(async () => {
    await app.s.mistakes.recordAyahReview(card.ref, outcome, { sessionId: t.sessionId, repetitions: 0, assisted: t.reveal.hintsUsed > 0 || outcome === 'needed_prompt' }, seg?.mistakeIds ?? card.mistakeIds);
    t.answers.set(`${card.id}:${t.reveal.segment}`, outcome);
    await app.s.plans.recordTestProgress(t.sessionId, t.answers.size);
  });
  if (!ok) return;
  const following = nextSegment(card, t.reveal);
  if (following) {
    // Next mistake in the same ayah: the text revealed so far stays visible.
    t.reveal = following;
    await app.refresh();
    document.querySelector<HTMLElement>('[data-key="test-reveal"]')?.focus();
    return;
  }
  await next(app, t);
}

async function next(app: App, t: ActiveTest) {
  if (t.index + 1 >= t.cards.length) {
    await finish(app, t);
    return;
  }
  t.index++;
  t.reveal = initialReveal(t.cards[t.index] as TestCard);
  await app.refresh();
  document.querySelector<HTMLElement>('[data-key="test-hint"]')?.focus();
}

async function finish(app: App, t: ActiveTest) {
  t.finished = true;
  await app.act(() => (t.answers.size > 0 ? app.s.plans.completeSession(t.sessionId) : app.s.plans.abandonSession(t.sessionId)));
  await app.refresh();
}

function cardView(app: App, t: ActiveTest): Node {
  const card = t.cards[t.index] as TestCard;
  const words = wordCount(app, card);
  const allowed = allowedOutcomes(t.reveal);
  const seg = card.segments[t.reveal.segment];
  const multi = card.segments.length > 1;
  const segCategories = [...new Set(app.data.mistakes.filter((m) => seg?.mistakeIds.includes(m.id)).map((m) => m.category))];
  const info = surahInfo(card.ref.surah);
  const prompt = card.promptIndex !== null ? fromIndex(card.promptIndex) : null;
  const target = app.quran.text?.ayahAt(card.globalIndex);
  const crossesSurah = prompt !== null && prompt.surah !== card.ref.surah;
  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, `Test: ${t.label}`), h('p', { class: 'muted' }, `Ayah ${t.index + 1} of ${t.cards.length}${multi ? `, mistake ${t.reveal.segment + 1} of ${card.segments.length} in this ayah` : ''}, ${t.answers.size} answered`)), h('button', { type: 'button', 'data-key': 'test-end', onclick: () => void finish(app, t) }, 'End test')),
    h('div', { class: 'progress-track', role: 'progressbar', 'aria-label': 'Test progress', 'aria-valuemin': '0', 'aria-valuemax': String(t.cards.length), 'aria-valuenow': String(t.index) }, h('span', { style: { width: `${Math.round((100 * t.index) / t.cards.length)}%` } })),
    h(
      'section',
      { class: 'panel test-card', 'aria-live': 'polite' },
      h('div', { class: 'row spread' }, h('strong', null, seg?.from === 1 ? 'Recite the next ayah' : 'Continue the ayah'), h('span', { class: 'chips' }, (segCategories.length ? segCategories : card.categories).map((c) => h('span', { class: 'chip cat' }, CATEGORY_LABELS[c])))),
      h('p', { class: 'muted' }, seg?.from === 1 ? 'Your mistake was at the start of this ayah. After the ayah above, what comes next?' : multi && seg?.to !== null ? 'Recite from where the text stops. Reveal stops before your next mistake in this ayah.' : 'Recite from where the text stops to the end of the ayah.'),
      prompt
        ? h('div', { class: 'test-prompt', 'aria-label': 'Previous ayah' }, h('small', { class: 'muted' }, formatRef(prompt)), h('div', { class: 'quran', lang: 'ar', dir: 'rtl' }, ayahTokens(app, card.promptIndex as number, null, null)))
        : h('p', { class: 'muted' }, 'This is the first ayah of the Quran; there is no ayah before it.'),
      crossesSurah || card.ref.ayah === 1
        ? h('div', { class: 'surah-head', dir: 'ltr' }, h('span', { class: 'ar', lang: 'ar', dir: 'rtl' }, `سورة ${info.nameArabic}`), h('span', { class: 'tr' }, `${info.number}. ${info.nameTransliterated}`))
        : null,
      target?.basmalaPrefix ? h('div', { class: 'basmala' }, target.basmalaPrefix) : null,
      h('div', { class: 'test-target' }, h('small', { class: 'muted' }, formatRef(card.ref)), h('div', { class: 'quran', lang: 'ar', dir: 'rtl' }, ayahTokens(app, card.globalIndex, card, t.reveal))),
      !t.reveal.segmentRevealed
        ? h(
            'div',
            { class: 'controls' },
            h('button', { type: 'button', 'data-key': 'test-hint', onclick: () => { t.reveal = hint(card, t.reveal, words); app.render(true); } }, `Hint: show one word${t.reveal.hintsUsed ? ` (${t.reveal.hintsUsed} used)` : ''}`),
            h('button', { type: 'button', class: 'primary', 'data-key': 'test-reveal', onclick: () => { t.reveal = revealSegment(card, t.reveal, words); app.render(true); document.querySelector<HTMLElement>('[data-key^="test-o-"]:not([disabled])')?.focus(); } }, 'Reveal'),
            h('button', { type: 'button', class: 'quiet', 'data-key': 'test-skip', onclick: () => void next(app, t) }, 'Skip'),
          )
        : h(
            'div',
            null,
            h('h2', { style: { 'margin-top': '1rem' } }, multi ? `How did you recall mistake ${t.reveal.segment + 1} of ${card.segments.length}?` : 'How did you recall it?'),
            t.reveal.hintsUsed ? h('p', { class: 'muted' }, `You used ${t.reveal.hintsUsed} hint${t.reveal.hintsUsed > 1 ? 's' : ''}, so this counts as needing a prompt.`) : null,
            h('div', { class: 'outcomes' }, RECALL_OUTCOMES.map((o) => h('button', { type: 'button', class: `outcome-${o}`, 'data-key': `test-o-${o}`, disabled: !allowed.includes(o), onclick: () => void answer(app, t, card, o) }, OUTCOME_LABELS[o]))),
          ),
    ),
  );
}

function summaryView(app: App, t: ActiveTest): Node {
  const counts = new Map<RecallOutcome, number>();
  for (const o of t.answers.values()) counts.set(o, (counts.get(o) ?? 0) + 1);
  const answersOf = (c: TestCard) => c.segments.map((_, i) => t.answers.get(`${c.id}:${i}`));
  const weakIds = t.cards.flatMap((c) => c.segments.filter((_, i) => { const o = t.answers.get(`${c.id}:${i}`); return o === 'needed_prompt' || o === 'mistake_again'; }).flatMap((sg) => sg.mistakeIds));
  const weak = t.cards.filter((c) => c.segments.some((sg) => sg.mistakeIds.some((id) => weakIds.includes(id))));
  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, `Test finished: ${t.label}`), h('p', { class: 'muted' }, `${t.answers.size} of ${totalSteps(t.cards)} mistakes answered in ${t.cards.length} ayat. Your answers were saved to your progress.`))),
    h('div', { class: 'metrics' }, RECALL_OUTCOMES.map((o) => h('div', { class: `metric${o === 'mistake_again' && counts.get(o) ? ' alert' : o === 'correct_easy' && counts.get(o) ? ' good' : ''}` }, h('div', { class: 'value' }, String(counts.get(o) ?? 0)), h('div', { class: 'label' }, OUTCOME_LABELS[o])))),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'Results'),
      h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Ayah'), h('th', null, 'Type'), h('th', null, 'Your answer'))), h('tbody', null, t.cards.map((c) => h('tr', null, h('td', null, h('a', { href: `#/quran?surah=${c.ref.surah}&focus=${c.globalIndex}` }, formatRef(c.ref))), h('td', null, c.kind === 'transition' ? 'Linking ayat' : 'Within the ayah'), h('td', null, answersOf(c).map((o, i) => `${c.segments.length > 1 ? `${i + 1}. ` : ''}${o ? OUTCOME_LABELS[o] : 'Skipped'}`).join('; '))))))),
      h(
        'div',
        { class: 'row', style: { 'margin-top': '1rem' } },
        weak.length
          ? h('button', {
              type: 'button', class: 'primary',
              onclick: () => {
                const p = app.prefs;
                app.test = null;
                app.prepare({ mode: 'mistakes', scope: t.scope, planId: null, label: `Weak spots from test: ${t.label}`, options: { mistakeIds: weakIds, statuses: ['new', 'needs_practice', 'under_review', 'improved', 'reopened', 'resolved'], contextBefore: p.contextBefore, contextAfter: p.contextAfter, contextAcrossSurahs: p.contextAcrossSurahs, wordPractice: p.wordPractice }, repeat: p.repeat, portionAyahRepeat: p.portionAyahRepeat, reciterId: p.reciterId });
              },
            }, `Listen to the ${weak.length} weak ayah${weak.length > 1 ? 's' : ''}`)
          : null,
        h('button', { type: 'button', 'data-key': 'test-new', onclick: () => { app.test = null; app.render(false); } }, 'New test'),
      ),
    ),
  );
}

export function testView(app: App): Node {
  const t = app.test;
  if (!t) return setupView(app);
  if (t.finished) return summaryView(app, t);
  return cardView(app, t);
}
