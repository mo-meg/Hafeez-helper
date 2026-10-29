import type { PlayerState } from '../../core/audio/playbackController.ts';
import { resolveAudioUrl } from '../../core/audio/reciters.ts';
import { MISTAKE_CATEGORIES, RECALL_OUTCOMES, type RepeatConfig } from '../../core/model.ts';
import { estimateDurationMs, playsPerAyah, REPEAT_LIMITS, type PlaybackStep } from '../../core/playlist/sequence.ts';
import { fromIndex } from '../../core/quran/refs.ts';
import type { SessionConfig } from '../../core/session/sessionBuilder.ts';
import type { App } from '../app.ts';
import { icon } from '../components/icons.ts';
import { formatDuration, h, type Child } from '../dom.ts';
import { wordCounter } from './revision.ts';
import { fmtList, fmtNum, t, tn } from '../i18n/index.ts';
import { categoryLabel, modeLabel, outcomeLabel, reciterName, refLabel } from '../i18n/labels.ts';

function numberField(label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void, key: string): HTMLElement {
  const input = h('input', {
    type: 'number', min: String(min), max: String(max), step: String(step), value: String(value), 'data-key': key,
    onchange: () => {
      const v = Number(input.value);
      if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
      else input.value = String(value);
    },
  });
  return h('label', { class: 'field' }, h('span', null, label), input);
}

function configForm(app: App, cfg: SessionConfig): HTMLElement {
  const update = (patch: Partial<SessionConfig>, repeat?: Partial<RepeatConfig>) => {
    app.pending = { ...cfg, ...patch, repeat: { ...cfg.repeat, ...(repeat ?? {}) } };
    app.render(true);
  };
  const opt = cfg.options;
  const reciter = h(
    'select',
    { 'data-key': 'cfg-reciter', onchange: () => update({ reciterId: reciter.value }) },
    app.reciters().map((r) => h('option', { value: r.id, selected: r.id === cfg.reciterId }, r.verification === 'unverified' ? t('ses.unverified', { name: reciterName(r) }) : reciterName(r))),
  );
  const check = (label: string, checked: boolean, key: string, on: (v: boolean) => void) =>
    h('label', { class: 'choice' }, h('input', { type: 'checkbox', checked, 'data-key': key, onchange: (e: Event) => on((e.target as HTMLInputElement).checked) }), h('span', null, label));
  const showMistakeOptions = cfg.mode !== 'full';
  return h(
    'details',
    { class: 'panel', open: true },
    h('summary', null, h('strong', null, t('ses.settings')), h('span', { class: 'muted' }, t('ses.settingsHint'))),
    h(
      'div',
      { class: 'stack', style: { 'margin-top': '0.75rem' } },
      h('label', { class: 'field' }, h('span', null, t('ses.reciter')), reciter),
      h(
        'div',
        { class: 'fields' },
        showMistakeOptions ? numberField(t('ses.playsMarked'), cfg.repeat.ayahRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => update({}, { ayahRepeat: v }), 'cfg-ayah') : null,
        showMistakeOptions ? numberField(t('ses.passesGroup'), cfg.repeat.groupRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => update({}, { groupRepeat: v }), 'cfg-group') : null,
        showMistakeOptions ? numberField(t('ses.passesList'), cfg.repeat.playlistRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => update({}, { playlistRepeat: v }), 'cfg-list') : null,
        cfg.mode !== 'mistakes' ? numberField(t('ses.playsPortion'), cfg.portionAyahRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => update({ portionAyahRepeat: v }), 'cfg-portion') : null,
        numberField(t('ses.pauseRep'), cfg.repeat.pauseBetweenRepetitionsMs / 1000, 0, 60, 0.5, (v) => update({}, { pauseBetweenRepetitionsMs: v * 1000 }), 'cfg-prep'),
        numberField(t('ses.pauseAyat'), cfg.repeat.pauseBetweenAyatMs / 1000, 0, 60, 0.5, (v) => update({}, { pauseBetweenAyatMs: v * 1000 }), 'cfg-pay'),
        numberField(t('ses.speed'), cfg.repeat.playbackRate, REPEAT_LIMITS.minRate, REPEAT_LIMITS.maxRate, 0.05, (v) => update({}, { playbackRate: v }), 'cfg-rate'),
        showMistakeOptions ? numberField(t('ses.before'), opt.contextBefore ?? 0, 0, 5, 1, (v) => update({ options: { ...opt, contextBefore: v } }), 'cfg-before') : null,
        showMistakeOptions ? numberField(t('ses.after'), opt.contextAfter ?? 0, 0, 5, 1, (v) => update({ options: { ...opt, contextAfter: v } }), 'cfg-after') : null,
      ),
      showMistakeOptions
        ? h(
            'div',
            null,
            check(t('ses.repeatContext'), cfg.repeat.repeatContext, 'cfg-rc', (v) => update({}, { repeatContext: v })),
            check(t('ses.across'), opt.contextAcrossSurahs ?? false, 'cfg-across', (v) => update({ options: { ...opt, contextAcrossSurahs: v } })),
            check(t('ses.wordPractice'), opt.wordPractice === 'per_word', 'cfg-word', (v) => update({ options: { ...opt, wordPractice: v ? 'per_word' : 'grouped' } })),
            h(
              'fieldset',
              { style: { 'margin-top': '0.5rem' } },
              h('legend', null, t('ses.includeTypes')),
              h('div', { class: 'cat-grid' }, MISTAKE_CATEGORIES.map((c) => {
                const all = !opt.categories || opt.categories.length === 0;
                return check(categoryLabel(c), all || (opt.categories ?? []).includes(c), `cfg-cat-${c}`, (v) => {
                  const current = all ? [...MISTAKE_CATEGORIES] : [...(opt.categories ?? [])];
                  const next = v ? [...new Set([...current, c])] : current.filter((x) => x !== c);
                  update({ options: { ...opt, categories: next.length === MISTAKE_CATEGORIES.length ? [] : next } });
                });
              })),
            ),
          )
        : null,
      check(t('ses.assess'), app.prefs.pauseForAssessment, 'cfg-assess', (v) => void app.savePrefs({ ...app.prefs, pauseForAssessment: v }).then(() => app.render(true))),
      h('button', {
        type: 'button', class: 'quiet',
        onclick: () => void app.act(() => app.savePrefs({
          ...app.prefs,
          reciterId: cfg.reciterId,
          repeat: cfg.repeat,
          portionAyahRepeat: cfg.portionAyahRepeat,
          contextBefore: opt.contextBefore ?? 0,
          contextAfter: opt.contextAfter ?? 0,
          contextAcrossSurahs: opt.contextAcrossSurahs ?? false,
          wordPractice: opt.wordPractice ?? 'grouped',
          categories: [...(opt.categories ?? [])],
        }), t('ses.savedDefault')),
      }, t('ses.saveDefault')),
    ),
  );
}

/** First step of each item occurrence: the visible "queue". */
function queueEntries(steps: readonly PlaybackStep[]): PlaybackStep[] {
  return steps.filter((s) => s.repetition === 1);
}

function stepLabel(s: PlaybackStep): string {
  const passes = fmtList([s.playlistPasses > 1 ? t('ses.pass', { n: s.playlistPass, total: s.playlistPasses }) : '', s.groupPasses > 1 ? t('ses.groupRound', { n: s.groupPass, total: s.groupPasses }) : ''].filter(Boolean));
  return passes;
}

function itemTags(s: PlaybackStep): Child {
  return h(
    'span',
    { class: 'chips' },
    s.role === 'context' ? h('span', { class: 'chip cat' }, t('ses.context')) : null,
    s.role === 'portion' && s.item.mistakeIds.length === 0 ? null : s.item.categories.map((c) => h('span', { class: 'chip cat' }, categoryLabel(c))),
    s.item.focusWord ? h('span', { class: 'chip cat' }, t('common.word', { n: s.item.focusWord.position })) : null,
  );
}

function previewView(app: App, cfg: SessionConfig, title: string): Node {
  let built;
  try {
    built = app.build(cfg);
  } catch (e) {
    return h('div', { class: 'notice error', role: 'alert' }, t('ses.cannotPrepare', { detail: e instanceof Error ? e.message : String(e) }));
  }
  const steps = built.steps;
  const entries = queueEntries(steps);
  const plays = playsPerAyah(steps);
  const est = estimateDurationMs(steps, cfg.repeat.playbackRate, wordCounter(app));
  const mp = built.mistakePlaylist;
  const urls = [...new Set(steps.map((s) => resolveAudioUrl(app.reciter().urlTemplate, s.item.ref)))];
  const offlineStatus = h('span', { class: 'muted', role: 'status' }, t('ses.checkingOffline'));
  void app.deps.audioCache.countCached(urls).then((n) => { offlineStatus.textContent = t('ses.offlineCount', { n, total: urls.length }); });
  const reciter = app.reciters().find((r) => r.id === cfg.reciterId) ?? app.reciter();

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), h('p', { class: 'muted' }, t('ses.withReciter', { mode: modeLabel(cfg.mode), reciter: reciterName(reciter) })))),
    steps.length === 0
      ? h('div', { class: 'empty' }, h('p', null, cfg.mode === 'full' ? t('ses.emptyFull') : t('ses.emptyMistakes')), h('p', { class: 'muted' }, mp && mp.excludedOutOfScope ? tn('ses.outside', mp.excludedOutOfScope) : t('ses.emptyHint')), h('div', { class: 'row', style: { 'justify-content': 'center' } }, h('a', { class: 'btn', href: '#/revision' }, t('common.backToRevision')), h('a', { class: 'btn', href: '#/quran' }, t('common.openQuran'))))
      : h(
          'section',
          { class: 'panel' },
          h('div', { class: 'metrics' },
            mp ? h('div', { class: 'metric' }, h('div', { class: 'value' }, fmtNum(mp.mistakeAyahIndexes.length)), h('div', { class: 'label' }, t('ses.markedAyat'))) : null,
            mp ? h('div', { class: 'metric' }, h('div', { class: 'value' }, fmtNum(mp.contextAyahCount)), h('div', { class: 'label' }, t('ses.neighbours'))) : null,
            built.portionPlaylist ? h('div', { class: 'metric' }, h('div', { class: 'value' }, fmtNum(built.portionPlaylist.groups.reduce((n, g) => n + g.items.length, 0))), h('div', { class: 'label' }, t('ses.portionAyat'))) : null,
            h('div', { class: 'metric' }, h('div', { class: 'value' }, fmtNum(steps.length)), h('div', { class: 'label' }, t('ses.totalPlays'))),
            h('div', { class: 'metric' }, h('div', { class: 'value', style: { 'font-size': '1.15rem' } }, formatDuration(est)), h('div', { class: 'label' }, t('ses.length'))),
          ),
          mp && mp.excludedOutOfScope ? h('p', { class: 'muted', style: { 'margin-top': '0.75rem' } }, tn('ses.otherOutside', mp.excludedOutOfScope)) : null,
          h('div', { class: 'row', style: { 'margin-top': '1rem' } },
            h('button', { type: 'button', class: 'primary big', 'data-key': 'start-session', onclick: () => void app.act(() => app.startPending()) }, icon('play'), t('common.start')),
            h('button', {
              type: 'button',
              onclick: async (e: Event) => {
                const btn = e.currentTarget as HTMLButtonElement;
                btn.disabled = true;
                const res = await app.deps.audioCache.download(urls, (d, total) => { offlineStatus.textContent = t('ses.downloading', { n: d, total }); });
                btn.disabled = false;
                offlineStatus.textContent = res.failed.length ? t('ses.savedPartial', { ok: res.ok, total: urls.length, failed: res.failed.length }) : t('ses.savedAll', { total: urls.length });
              },
            }, t('ses.saveOffline')),
            h('button', { type: 'button', class: 'quiet', onclick: () => { app.pending = null; app.pendingTitle = null; history.back(); } }, t('common.cancel')),
          ),
          offlineStatus,
        ),
    configForm(app, cfg),
    steps.length
      ? h(
          'section',
          { class: 'panel' },
          h('h2', null, t('ses.order')),
          h('p', { class: 'muted' }, t('ses.orderHelp')),
          h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, t('common.ayah')), h('th', null, t('ses.why')), h('th', null, t('ses.playsHere')), h('th', null, t('ses.playsTotal')))),
            h('tbody', null, entries.slice(0, 400).map((s, i) => h('tr', null, h('td', null, fmtNum(i + 1)), h('td', null, refLabel(s.item.ref), s.phase === 'portion' && cfg.mode === 'combined' ? h('small', { class: 'muted' }, t('ses.fullPortion')) : null), h('td', null, itemTags(s), h('small', { class: 'muted' }, stepLabel(s))), h('td', null, fmtNum(s.repetitions)), h('td', null, fmtNum(plays.get(s.item.globalIndex) ?? 0))))),
          )),
          entries.length > 400 ? h('p', { class: 'muted' }, t('ses.showingFirst', { shown: 400, total: entries.length })) : null,
        )
      : null,
  );
}

function statusLine(st: PlayerState): string {
  switch (st.status) {
    case 'loading': return t('ses.stLoading');
    case 'playing': return t('ses.stPlaying');
    case 'paused': return t('ses.stPaused');
    case 'gap': return st.current && !st.current.isLastRepetition ? t('ses.stGapRep') : t('ses.stGapAyah');
    case 'awaiting_assessment': return t('ses.stAssess');
    case 'finished': return t('ses.stFinished');
    case 'error': return t('ses.stError');
    default: return t('ses.stReady');
  }
}

/** Localized audio error; the technical reason from the browser is kept as detail. */
function audioErrorText(st: PlayerState): string {
  const e = st.error;
  if (!e || e.globalIndex < 1) return e ? e.message : t('ses.audioFailedGeneric');
  return t('error.audioFailed', { ref: refLabel(fromIndex(e.globalIndex)), detail: e.offline ? t('error.offlineAudio') : e.reason });
}

function playerView(app: App): Node {
  const a = app.active;
  if (!a) return h('div');
  const st = app.player.state;
  const cur = st.current;
  const entries = queueEntries(st.steps);
  const curEntry = cur ? entries.findIndex((e) => e.itemKey === cur.itemKey) : -1;
  const pct = st.steps.length ? Math.round((100 * Math.min(st.completedSteps, st.steps.length)) / st.steps.length) : 0;
  const text = app.quran.text;
  const playing = st.status === 'playing' || st.status === 'gap' || st.status === 'loading';
  const assessable = cur && cur.item.mistakeIds.length > 0;
  const recorded = cur ? a.outcomes.get(cur.item.globalIndex) : undefined;
  const marked = new Set((cur?.item.words ?? []).map((w) => w.position));
  const focus = cur?.item.focusWord?.position ?? null;
  const ayahText = cur && text ? text.ayahAt(cur.item.globalIndex) : null;
  const notAssessed = [...new Set(a.built.mistakeAyahIndexes)].filter((i) => !a.outcomes.has(i) && (a.plays.get(i) ?? 0) > 0);
  const ctl = (name: string, label: string, fn: () => unknown, key: string, cls = 'icon') =>
    h('button', { type: 'button', class: cls, 'aria-label': label, title: label, 'data-key': key, onclick: () => void fn() }, icon(name));

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, a.title()), h('p', { class: 'muted' }, t('ses.modeReciter', { mode: modeLabel(a.config.mode), reciter: reciterName(app.reciter()) }))), a.ended ? h('span', { class: 'chip status-resolved' }, t('ses.ended')) : null),
    h('div', { class: 'progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': t('ses.progress') }, h('span', { style: { width: `${pct}%` } })),
    h('p', { class: 'muted' }, t('ses.position', { n: Math.max(1, curEntry + 1), total: entries.length, done: st.completedSteps, steps: st.steps.length })),
    h(
      'section',
      { class: 'panel now-playing', 'aria-live': 'polite' },
      cur
        ? [
            h('div', { class: 'ref-big' }, refLabel(cur.item.ref)),
            h('div', { class: 'muted' }, cur.phase === 'portion' ? t('ses.phasePortion') : cur.role === 'context' ? t('ses.phaseContext') : t('ses.phaseMarked'), stepLabel(cur) ? `${t('common.listSep')}${stepLabel(cur)}` : ''),
            ayahText
              ? h('div', { class: 'quran', lang: 'ar', dir: 'rtl' }, ayahText.tokens.map((t) => [h('span', { class: t.position !== null && marked.has(t.position) ? `w marked${focus === t.position ? ' focus' : ''}` : t.position === null ? 'pause-mark' : 'w' }, t.text), ' ']))
              : h('p', { class: 'muted' }, t('ses.noText')),
            h('div', { class: 'beads', role: 'img', 'aria-label': t('ses.repetition', { n: cur.repetition, total: cur.repetitions }) }, Array.from({ length: cur.repetitions }, (_, i) => h('span', { class: `bead${i + 1 < cur.repetition ? ' done' : i + 1 === cur.repetition ? (st.status === 'playing' ? ' now' : ' done') : ''}` }))),
            h('div', null, h('strong', { dir: 'ltr' }, `${fmtNum(cur.repetition)}/${fmtNum(cur.repetitions)}`), h('span', { class: 'muted' }, ` ${statusLine(st)}`)),
          ]
        : h('p', null, statusLine(st)),
      st.status === 'error'
        ? h('div', { class: 'notice error', role: 'alert', style: { 'text-align': 'start', 'margin-top': '1rem' } }, h('p', null, audioErrorText(st)), h('p', { class: 'muted' }, t('ses.nothingSkipped')), h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', 'data-key': 'retry', onclick: () => void app.player.retry() }, t('ses.retry')), h('button', { type: 'button', 'data-key': 'skip', onclick: () => void app.player.skipFailed() }, t('ses.skip')), h('a', { class: 'btn', href: '#/settings?section=audio' }, t('ses.audioSettings'))))
        : null,
      h(
        'div',
        { class: 'controls', role: 'group', 'aria-label': t('ses.controls'), dir: 'ltr' },
        ctl('prev', t('player.prev'), () => app.player.prev(), 'c-prev'),
        ctl('restart', t('ses.restartAyah'), () => app.player.restartAyah(), 'c-restart'),
        h('button', { type: 'button', class: 'icon primary', 'aria-label': playing ? t('player.pause') : t('player.play'), title: playing ? t('player.pause') : t('player.play'), 'data-key': 'c-play', disabled: a.ended, onclick: () => void app.player.togglePlay() }, icon(playing ? 'pause' : 'play')),
        ctl('next', t('player.next'), () => app.player.next(), 'c-next'),
        ctl('flagNext', t('ses.nextMistake'), () => app.player.nextMistake(), 'c-nextm'),
        ctl('stop', t('ses.stop'), () => app.player.stop(), 'c-stop'),
        h('button', { type: 'button', 'data-key': 'c-again', dir: 'auto', onclick: () => void app.player.restartPlaylist() }, t('ses.restartList')),
      ),
      cur ? h('a', { href: `#/quran?surah=${cur.item.ref.surah}&focus=${cur.item.globalIndex}`, onclick: () => app.player.pause() }, t('ses.inspect')) : null,
      assessable && !a.ended
        ? h(
            'div',
            null,
            h('h2', { style: { 'margin-top': '1.25rem' } }, t('ses.howRecall')),
            h('p', { class: 'muted', style: { margin: '0 auto' } }, t('ses.listenNote')),
            h('div', { class: 'outcomes' }, RECALL_OUTCOMES.map((o) => h('button', { type: 'button', class: `outcome-${o}${recorded === o ? ' primary' : ''}`, 'data-key': `o-${o}`, 'aria-pressed': recorded === o ? 'true' : 'false', onclick: () => void app.recordOutcome(cur.item.ref, cur.item.globalIndex, o) }, outcomeLabel(o)))),
            st.status === 'awaiting_assessment' ? h('button', { type: 'button', class: 'quiet', style: { 'margin-top': '0.5rem' }, onclick: () => void app.player.continueAfterAssessment() }, t('ses.continue')) : null,
          )
        : null,
    ),
    h(
      'div',
      { class: 'grid two' },
      h(
        'section',
        { class: 'panel' },
        h('h2', null, t('ses.queue')),
        h('ol', { class: 'queue' }, entries.map((e, i) => {
          const done = e.stepIndex + e.repetitions <= st.completedSteps || (e.stepIndex < st.index && e.itemKey !== cur?.itemKey);
          return h('li', { class: `${e.role === 'context' ? 'context ' : ''}${e.itemKey === cur?.itemKey ? 'current ' : ''}${done ? 'played' : ''}` },
            h('span', { class: 'idx' }, done ? '✓' : fmtNum(i + 1)),
            h('button', { type: 'button', class: 'quiet', style: { 'justify-content': 'flex-start', padding: '0.2rem 0.4rem', 'min-height': '2rem' }, onclick: () => void app.player.jumpTo(e.stepIndex) }, refLabel(e.item.ref)),
            h('span', { class: 'row' }, a.outcomes.has(e.item.globalIndex) && e.item.mistakeIds.length ? h('span', { class: 'chip status-improved' }, t('ses.answered')) : null, t('ses.times', { n: e.repetitions })),
          );
        })),
      ),
      h(
        'section',
        { class: 'panel' },
        h('h2', null, t('ses.finish')),
        h('p', null, t('ses.answeredCount', { n: a.outcomes.size, total: a.built.mistakeAyahIndexes.length })),
        notAssessed.length ? h('p', { class: 'muted' }, t('ses.notAnswered', { list: `${notAssessed.slice(0, 8).map((i) => refLabel(fromIndex(i))).join(t('common.listSep'))}${notAssessed.length > 8 ? '…' : ''}` })) : null,
        h('p', { class: 'muted' }, t('ses.finishNote')),
        a.ended
          ? h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/dashboard' }, t('ses.toDashboard')), h('a', { class: 'btn', href: '#/revision' }, t('nav.revision')))
          : h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', 'data-key': 'finish', onclick: () => void app.endSession(true) }, t('ses.finishBtn')), h('button', { type: 'button', 'data-key': 'abandon', onclick: () => void app.endSession(false) }, t('ses.abandon'))),
      ),
    ),
  );
}

export function sessionView(app: App): Node {
  if (app.active) return playerView(app);
  if (app.pending) return previewView(app, app.pending, app.pendingTitle?.() ?? app.pending.label);
  return h(
    'div',
    null,
    h('h1', null, t('ses.title')),
    h('div', { class: 'empty' }, h('p', null, t('ses.none')), h('div', { class: 'row', style: { 'justify-content': 'center' } }, h('a', { class: 'btn primary', href: '#/revision' }, t('nav.revision')), h('a', { class: 'btn', href: '#/mistakes' }, t('nav.mistakes')))),
  );
}
