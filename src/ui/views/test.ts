import { RECALL_OUTCOMES, type RecallOutcome } from '../../core/model.ts';
import { fromIndex } from '../../core/quran/refs.ts';
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
// `t` is also the local name of the active test below, so the translator is aliased as `tr` there.
import { dir, fmtNum, t, t as tr, tn } from '../i18n/index.ts';
import { categoryLabel, errorText, outcomeLabel, refLabel, scopeLabel, surahName, surahOption } from '../i18n/labels.ts';
import { h, type Child } from '../dom.ts';

type TestKind = 'surah' | 'juz' | 'hizb' | 'quarter';
const TEST_KINDS: readonly TestKind[] = ['surah', 'juz', 'hizb', 'quarter'];
const kindText = (k: TestKind): string => t(`kindLong.${k}`);

export interface ActiveTest {
  readonly sessionId: string;
  readonly scope: RevisionScope;
  /** Stable English label (for records); the UI shows `scopeLabel(scope)` instead. */
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
    problem = errorText(e);
  }
  const mistakes = cards.reduce((n, c) => n + c.mistakeIds.length, 0);
  const transitions = cards.filter((c) => c.kind === 'transition').length;
  const rerender = () => app.render(true);

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('test.title')), h('p', { class: 'muted' }, t('test.intro')))),
    !app.quran.text
      ? h('div', { class: 'notice info' }, h('p', null, t('test.needsText')), h('a', { class: 'btn', href: '#/settings?section=data' }, t('common.downloadQuranData')))
      : null,
    h(
      'section',
      { class: 'panel' },
      h('h2', null, t('test.what')),
      h(
        'div',
        { class: 'row', style: { 'align-items': 'flex-end' } },
        h('label', { class: 'field' }, h('span', null, t('picker.kind')), h('select', { id: 'test-kind', 'data-key': 'test-kind', onchange: (e: Event) => { setup.kind = (e.target as HTMLSelectElement).value as TestKind; setup.number = 1; rerender(); } },
          TEST_KINDS.map((k) => {
            const ok = k === 'surah' || index.has(k);
            return h('option', { value: k, selected: k === setup.kind, disabled: !ok }, ok ? kindText(k) : t('common.dataNotLoaded', { label: kindText(k) }));
          }))),
        setup.kind === 'surah'
          ? h('label', { class: 'field' }, h('span', null, t('common.surah')), h('select', { id: 'test-surah', 'data-key': 'test-surah', onchange: (e: Event) => { setup.surah = Number((e.target as HTMLSelectElement).value); rerender(); } }, SURAHS.map((s) => h('option', { value: String(s.number), selected: s.number === setup.surah }, surahOption(s.number)))))
          : h('label', { class: 'field' }, h('span', null, t('common.numberRange', { max })), h('input', { id: 'test-num', 'data-key': 'test-num', type: 'number', min: '1', max: String(max), value: String(setup.number), onchange: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); if (Number.isInteger(v) && v >= 1 && v <= max) setup.number = v; rerender(); } })),
      ),
      h('label', { class: 'choice' }, h('input', { type: 'checkbox', checked: setup.includeResolved, 'data-key': 'test-resolved', onchange: (e: Event) => { setup.includeResolved = (e.target as HTMLInputElement).checked; rerender(); } }), h('span', null, t('test.includeResolved'))),
      h('label', { class: 'choice' }, h('input', { type: 'checkbox', checked: setup.shuffle, 'data-key': 'test-shuffle', onchange: (e: Event) => { setup.shuffle = (e.target as HTMLInputElement).checked; rerender(); } }), h('span', null, t('test.shuffle'))),
      problem ? h('p', { role: 'alert', style: { color: 'var(--mistake)' } }, problem) : null,
      h(
        'div',
        { class: 'row spread', style: { 'margin-top': '0.75rem' } },
        h('span', null, cards.length ? t('test.summary', { ayat: tn('test.ayatToTest', cards.length), mistakes: tn('test.mistakes', mistakes), transitions }) : t(setup.includeResolved ? 'test.noneIn' : 'test.noneUnresolvedIn', { portion: scopeLabel(scopeFromSetup(), index) })),
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
        }, t('test.start')),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, t('test.how')),
      h('p', null, t('test.how1')),
      h('p', null, t('test.how2')),
      h('p', null, t('test.how3')),
      h('p', null, t('test.how4')),
      h('p', { class: 'muted' }, t('test.how5')),
    ),
  );
}

function ayahTokens(app: App, idx: number, card: TestCard | null, reveal: RevealState | null): Child {
  const ayah = app.quran.text?.ayahAt(idx);
  if (!ayah) return null;
  const marked = new Set(card?.markedPositions ?? []);
  const resolvedPositions = new Set(
    app.data.mistakes.filter((m) => card?.mistakeIds.includes(m.id) && m.status === 'resolved' && m.word).map((m) => m.word?.position as number),
  );
  let lastWordVisible = true;
  return ayah.tokens.map((t) => {
    if (t.position === null) return lastWordVisible ? [h('span', { class: 'pause-mark', 'aria-hidden': 'true' }, t.text), ' '] : null;
    const visible = !card || !reveal || isWordVisible(card, reveal, t.position);
    lastWordVisible = visible;
    if (!visible) return [h('span', { class: 'hidden-word', role: 'img', 'aria-label': tr('test.hiddenWord'), style: { '--len': String(Math.max(2, t.text.length)) } }), ' '];
    const wasHidden = card && t.position >= card.hideFrom;
    const markCls = marked.has(t.position) && wasHidden ? ` marked${resolvedPositions.has(t.position) ? ' resolved' : ''}` : '';
    return [h('span', { class: `w${markCls}${wasHidden ? ' revealed' : ''}` }, t.text), ' '];
  });
}

async function answer(app: App, t: ActiveTest, card: TestCard, outcome: RecallOutcome) {
  const seg = card.segments[t.reveal.segment];
  const ok = await app.act(async () => {
    await app.s.mistakes.recordAyahReview(card.ref, outcome, { sessionId: t.sessionId, repetitions: 0, assisted: t.reveal.hintsUsed > 0 || outcome === 'needed_prompt', resolveOnEasy: true }, seg?.mistakeIds ?? card.mistakeIds);
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
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, tr('test.cardTitle', { label: scopeLabel(t.scope, app.quran.index) })), h('p', { class: 'muted' }, tr('test.cardPos', { n: t.index + 1, total: t.cards.length }), multi ? tr('test.cardMulti', { n: t.reveal.segment + 1, total: card.segments.length }) : '', tr('test.cardAnswered', { count: t.answers.size }))), h('button', { type: 'button', 'data-key': 'test-end', onclick: () => void finish(app, t) }, tr('test.end'))),
    h('div', { class: 'progress-track', role: 'progressbar', 'aria-label': tr('test.progress'), 'aria-valuemin': '0', 'aria-valuemax': String(t.cards.length), 'aria-valuenow': String(t.index) }, h('span', { style: { width: `${Math.round((100 * t.index) / t.cards.length)}%` } })),
    h(
      'section',
      { class: 'panel test-card', 'aria-live': 'polite' },
      h('div', { class: 'row spread' }, h('strong', null, seg?.from === 1 ? tr('test.reciteNext') : tr('test.continueAyah')), h('span', { class: 'chips' }, (segCategories.length ? segCategories : card.categories).map((c) => h('span', { class: 'chip cat' }, categoryLabel(c))))),
      h('p', { class: 'muted' }, seg?.from === 1 ? tr('test.hintStart') : multi && seg?.to !== null ? tr('test.hintMulti') : tr('test.hintEnd')),
      prompt
        ? h('div', { class: 'test-prompt', 'aria-label': tr('test.prevAyah') }, h('small', { class: 'muted' }, refLabel(prompt)), h('div', { class: 'quran', lang: 'ar', dir: 'rtl' }, ayahTokens(app, card.promptIndex as number, null, null)))
        : h('p', { class: 'muted' }, tr('test.firstAyah')),
      crossesSurah || card.ref.ayah === 1
        ? h('div', { class: 'surah-head', dir: dir() }, h('span', { class: 'ar', lang: 'ar', dir: 'rtl' }, `سورة ${info.nameArabic}`), h('span', { class: 'tr' }, `${info.number}. ${surahName(info.number)}`))
        : null,
      target?.basmalaPrefix ? h('div', { class: 'basmala' }, target.basmalaPrefix) : null,
      h('div', { class: 'test-target' }, h('small', { class: 'muted' }, refLabel(card.ref)), h('div', { class: 'quran', lang: 'ar', dir: 'rtl' }, ayahTokens(app, card.globalIndex, card, t.reveal))),
      !t.reveal.segmentRevealed
        ? h(
            'div',
            { class: 'controls' },
            h('button', { type: 'button', 'data-key': 'test-hint', onclick: () => { t.reveal = hint(card, t.reveal, words); app.render(true); } }, t.reveal.hintsUsed ? tr('test.hintUsed', { count: t.reveal.hintsUsed }) : tr('test.hint')),
            h('button', { type: 'button', class: 'primary', 'data-key': 'test-reveal', onclick: () => { t.reveal = revealSegment(card, t.reveal, words); app.render(true); document.querySelector<HTMLElement>('[data-key^="test-o-"]:not([disabled])')?.focus(); } }, tr('test.reveal')),
            h('button', { type: 'button', class: 'quiet', 'data-key': 'test-skip', onclick: () => void next(app, t) }, tr('test.skip')),
          )
        : h(
            'div',
            null,
            h('h2', { style: { 'margin-top': '1rem' } }, multi ? tr('test.howMulti', { n: t.reveal.segment + 1, total: card.segments.length }) : tr('test.howOne')),
            t.reveal.hintsUsed ? h('p', { class: 'muted' }, tn('test.hintsUsed', t.reveal.hintsUsed)) : null,
            h('div', { class: 'outcomes' }, RECALL_OUTCOMES.map((o) => h('button', { type: 'button', class: `outcome-${o}`, 'data-key': `test-o-${o}`, disabled: !allowed.includes(o), onclick: () => void answer(app, t, card, o) }, outcomeLabel(o)))),
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
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, tr('test.finished', { label: scopeLabel(t.scope, app.quran.index) })), h('p', { class: 'muted' }, tr('test.finishedDetail', { answered: t.answers.size, total: totalSteps(t.cards), ayat: tn('test.ayatToTest', t.cards.length) })))),
    h('div', { class: 'metrics' }, RECALL_OUTCOMES.map((o) => h('div', { class: `metric${o === 'mistake_again' && counts.get(o) ? ' alert' : o === 'correct_easy' && counts.get(o) ? ' good' : ''}` }, h('div', { class: 'value' }, fmtNum(counts.get(o) ?? 0)), h('div', { class: 'label' }, outcomeLabel(o))))),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, tr('test.results')),
      h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, tr('common.ayah')), h('th', null, tr('common.type')), h('th', null, tr('test.yourAnswer')))), h('tbody', null, t.cards.map((c) => h('tr', null, h('td', null, h('a', { href: `#/quran?surah=${c.ref.surah}&focus=${c.globalIndex}` }, refLabel(c.ref))), h('td', null, c.kind === 'transition' ? tr('test.linking') : tr('test.within')), h('td', null, answersOf(c).map((o, i) => `${c.segments.length > 1 ? `${fmtNum(i + 1)}. ` : ''}${o ? `${outcomeLabel(o)}${o === 'correct_easy' ? tr('test.nowResolved') : ''}` : tr('test.skipped')}`).join(tr('common.listSep')))))))),
      h(
        'div',
        { class: 'row', style: { 'margin-top': '1rem' } },
        weak.length
          ? h('button', {
              type: 'button', class: 'primary',
              onclick: () => {
                const p = app.prefs;
                app.test = null;
                const scope = t.scope;
                app.prepare({ mode: 'mistakes', scope: t.scope, planId: null, label: `Weak spots from test: ${t.label}`, options: { mistakeIds: weakIds, statuses: ['new', 'needs_practice', 'under_review', 'improved', 'reopened', 'resolved'], contextBefore: p.contextBefore, contextAfter: p.contextAfter, contextAcrossSurahs: p.contextAcrossSurahs, wordPractice: p.wordPractice }, repeat: p.repeat, portionAyahRepeat: p.portionAyahRepeat, reciterId: p.reciterId }, () => tr('test.weakLabel', { label: scopeLabel(scope, app.quran.index) }));
              },
            }, tn('test.listenWeak', weak.length))
          : null,
        h('button', { type: 'button', 'data-key': 'test-new', onclick: () => { app.test = null; app.render(false); } }, tr('test.new')),
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
