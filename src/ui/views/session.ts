import type { PlayerState } from '../../core/audio/playbackController.ts';
import { resolveAudioUrl } from '../../core/audio/reciters.ts';
import { CATEGORY_LABELS, MISTAKE_CATEGORIES, OUTCOME_LABELS, RECALL_OUTCOMES, type RepeatConfig } from '../../core/model.ts';
import { estimateDurationMs, playsPerAyah, REPEAT_LIMITS, type PlaybackStep } from '../../core/playlist/sequence.ts';
import { formatRef } from '../../core/quran/refs.ts';
import type { SessionConfig } from '../../core/session/sessionBuilder.ts';
import type { App } from '../app.ts';
import { icon } from '../components/icons.ts';
import { formatDuration, h, type Child } from '../dom.ts';
import { wordCounter } from './revision.ts';

const MODE_LABEL = { mistakes: 'Mistake revision', full: 'Full revision', combined: 'Combined revision', test: 'Test' } as const;

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
    app.reciters().map((r) => h('option', { value: r.id, selected: r.id === cfg.reciterId }, `${r.name}${r.verification === 'unverified' ? ' (unverified source)' : ''}`)),
  );
  const check = (label: string, checked: boolean, key: string, on: (v: boolean) => void) =>
    h('label', { class: 'choice' }, h('input', { type: 'checkbox', checked, 'data-key': key, onchange: (e: Event) => on((e.target as HTMLInputElement).checked) }), h('span', null, label));
  const showMistakeOptions = cfg.mode !== 'full';
  return h(
    'details',
    { class: 'panel', open: true },
    h('summary', null, h('strong', null, 'Playback settings'), h('span', { class: 'muted' }, ' (apply to this session)')),
    h(
      'div',
      { class: 'stack', style: { 'margin-top': '0.75rem' } },
      h('label', { class: 'field' }, h('span', null, 'Reciter'), reciter),
      h(
        'div',
        { class: 'fields' },
        showMistakeOptions ? numberField('Plays of each marked ayah', cfg.repeat.ayahRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => update({}, { ayahRepeat: v }), 'cfg-ayah') : null,
        showMistakeOptions ? numberField('Passes over each group', cfg.repeat.groupRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => update({}, { groupRepeat: v }), 'cfg-group') : null,
        showMistakeOptions ? numberField('Passes over the playlist', cfg.repeat.playlistRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => update({}, { playlistRepeat: v }), 'cfg-list') : null,
        cfg.mode !== 'mistakes' ? numberField('Plays of each ayah in the full portion', cfg.portionAyahRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => update({ portionAyahRepeat: v }), 'cfg-portion') : null,
        numberField('Pause between repetitions (s)', cfg.repeat.pauseBetweenRepetitionsMs / 1000, 0, 60, 0.5, (v) => update({}, { pauseBetweenRepetitionsMs: v * 1000 }), 'cfg-prep'),
        numberField('Pause between ayat (s)', cfg.repeat.pauseBetweenAyatMs / 1000, 0, 60, 0.5, (v) => update({}, { pauseBetweenAyatMs: v * 1000 }), 'cfg-pay'),
        numberField('Speed', cfg.repeat.playbackRate, REPEAT_LIMITS.minRate, REPEAT_LIMITS.maxRate, 0.05, (v) => update({}, { playbackRate: v }), 'cfg-rate'),
        showMistakeOptions ? numberField('Ayat before each mistake', opt.contextBefore ?? 0, 0, 5, 1, (v) => update({ options: { ...opt, contextBefore: v } }), 'cfg-before') : null,
        showMistakeOptions ? numberField('Ayat after each mistake', opt.contextAfter ?? 0, 0, 5, 1, (v) => update({ options: { ...opt, contextAfter: v } }), 'cfg-after') : null,
      ),
      showMistakeOptions
        ? h(
            'div',
            null,
            check('Repeat the neighbouring ayat as often as the marked ayah', cfg.repeat.repeatContext, 'cfg-rc', (v) => update({}, { repeatContext: v })),
            check('Allow neighbouring ayat from the next or previous surah', opt.contextAcrossSurahs ?? false, 'cfg-across', (v) => update({ options: { ...opt, contextAcrossSurahs: v } })),
            check('Word practice: play an ayah once per marked word (the word is highlighted; audio is the whole ayah)', opt.wordPractice === 'per_word', 'cfg-word', (v) => update({ options: { ...opt, wordPractice: v ? 'per_word' : 'grouped' } })),
            h(
              'fieldset',
              { style: { 'margin-top': '0.5rem' } },
              h('legend', null, 'Mistake types to include'),
              h('div', { class: 'cat-grid' }, MISTAKE_CATEGORIES.map((c) => {
                const all = !opt.categories || opt.categories.length === 0;
                return check(CATEGORY_LABELS[c], all || (opt.categories ?? []).includes(c), `cfg-cat-${c}`, (v) => {
                  const current = all ? [...MISTAKE_CATEGORIES] : [...(opt.categories ?? [])];
                  const next = v ? [...new Set([...current, c])] : current.filter((x) => x !== c);
                  update({ options: { ...opt, categories: next.length === MISTAKE_CATEGORIES.length ? [] : next } });
                });
              })),
            ),
          )
        : null,
      check('Pause after each marked ayah so I can record how I recalled it', app.prefs.pauseForAssessment, 'cfg-assess', (v) => void app.savePrefs({ ...app.prefs, pauseForAssessment: v }).then(() => app.render(true))),
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
        }), 'Saved as your default playback settings.'),
      }, 'Use these settings by default'),
    ),
  );
}

/** First step of each item occurrence: the visible "queue". */
function queueEntries(steps: readonly PlaybackStep[]): PlaybackStep[] {
  return steps.filter((s) => s.repetition === 1);
}

function stepLabel(s: PlaybackStep): string {
  const passes = [s.playlistPasses > 1 ? `pass ${s.playlistPass}/${s.playlistPasses}` : '', s.groupPasses > 1 ? `group round ${s.groupPass}/${s.groupPasses}` : ''].filter(Boolean).join(', ');
  return passes;
}

function itemTags(s: PlaybackStep): Child {
  return h(
    'span',
    { class: 'chips' },
    s.role === 'context' ? h('span', { class: 'chip cat' }, 'Context') : null,
    s.role === 'portion' && s.item.mistakeIds.length === 0 ? null : s.item.categories.map((c) => h('span', { class: 'chip cat' }, CATEGORY_LABELS[c])),
    s.item.focusWord ? h('span', { class: 'chip cat' }, `Word ${s.item.focusWord.position}`) : null,
  );
}

function previewView(app: App, cfg: SessionConfig): Node {
  let built;
  try {
    built = app.build(cfg);
  } catch (e) {
    return h('div', { class: 'notice error', role: 'alert' }, `This session cannot be prepared: ${e instanceof Error ? e.message : e}`);
  }
  const steps = built.steps;
  const entries = queueEntries(steps);
  const plays = playsPerAyah(steps);
  const est = estimateDurationMs(steps, cfg.repeat.playbackRate, wordCounter(app));
  const mp = built.mistakePlaylist;
  const urls = [...new Set(steps.map((s) => resolveAudioUrl(app.reciter().urlTemplate, s.item.ref)))];
  const offlineStatus = h('span', { class: 'muted' }, 'Checking offline copies…');
  void app.deps.audioCache.countCached(urls).then((n) => { offlineStatus.textContent = `${n} of ${urls.length} audio files available offline.`; });
  const reciter = app.reciters().find((r) => r.id === cfg.reciterId) ?? app.reciter();

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, cfg.label), h('p', { class: 'muted' }, `${MODE_LABEL[cfg.mode]} with ${reciter.name}`))),
    steps.length === 0
      ? h('div', { class: 'empty' }, h('p', null, cfg.mode === 'full' ? 'This portion has no ayat to play.' : 'No unresolved mistakes match this selection, so there is nothing to revise here.'), h('p', { class: 'muted' }, mp && mp.excludedOutOfScope ? `${mp.excludedOutOfScope} matching mistake${mp.excludedOutOfScope > 1 ? 's are' : ' is'} outside this portion.` : 'Mark mistakes while reading, or choose full revision.'), h('div', { class: 'row', style: { 'justify-content': 'center' } }, h('a', { class: 'btn', href: '#/revision' }, 'Back to daily revision'), h('a', { class: 'btn', href: '#/quran' }, 'Open the Quran')))
      : h(
          'section',
          { class: 'panel' },
          h('div', { class: 'metrics' },
            mp ? h('div', { class: 'metric' }, h('div', { class: 'value' }, String(mp.mistakeAyahIndexes.length)), h('div', { class: 'label' }, 'Marked ayat')) : null,
            mp ? h('div', { class: 'metric' }, h('div', { class: 'value' }, String(mp.contextAyahCount)), h('div', { class: 'label' }, 'Neighbouring ayat')) : null,
            built.portionPlaylist ? h('div', { class: 'metric' }, h('div', { class: 'value' }, String(built.portionPlaylist.groups.reduce((n, g) => n + g.items.length, 0))), h('div', { class: 'label' }, 'Ayat in the portion')) : null,
            h('div', { class: 'metric' }, h('div', { class: 'value' }, String(steps.length)), h('div', { class: 'label' }, 'Plays in total')),
            h('div', { class: 'metric' }, h('div', { class: 'value', style: { 'font-size': '1.15rem' } }, formatDuration(est)), h('div', { class: 'label' }, 'Estimated length')),
          ),
          mp && mp.excludedOutOfScope ? h('p', { class: 'muted', style: { 'margin-top': '0.75rem' } }, `${mp.excludedOutOfScope} other unresolved mistake${mp.excludedOutOfScope > 1 ? 's are' : ' is'} outside this portion and not included.`) : null,
          h('div', { class: 'row', style: { 'margin-top': '1rem' } },
            h('button', { type: 'button', class: 'primary big', 'data-key': 'start-session', onclick: () => void app.act(() => app.startPending()) }, icon('play'), 'Start'),
            h('button', {
              type: 'button',
              onclick: async (e: Event) => {
                const btn = e.currentTarget as HTMLButtonElement;
                btn.disabled = true;
                const res = await app.deps.audioCache.download(urls, (d, t) => { offlineStatus.textContent = `Downloading ${d} of ${t}…`; });
                btn.disabled = false;
                offlineStatus.textContent = res.failed.length ? `${res.ok} of ${urls.length} saved. ${res.failed.length} could not be saved: the audio source may not allow offline copies, or you are offline.` : `All ${urls.length} audio files are available offline.`;
              },
            }, 'Save audio for offline use'),
            h('button', { type: 'button', class: 'quiet', onclick: () => { app.pending = null; history.back(); } }, 'Cancel'),
          ),
          offlineStatus,
        ),
    configForm(app, cfg),
    steps.length
      ? h(
          'section',
          { class: 'panel' },
          h('h2', null, 'Playback order'),
          h('p', { class: 'muted' }, 'Ayat are played in Quran order. A play count of 5 means the ayah is heard five times in total.'),
          h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Ayah'), h('th', null, 'Why'), h('th', null, 'Plays here'), h('th', null, 'Total plays'))),
            h('tbody', null, entries.slice(0, 400).map((s, i) => h('tr', null, h('td', null, String(i + 1)), h('td', null, formatRef(s.item.ref), s.phase === 'portion' && cfg.mode === 'combined' ? h('small', { class: 'muted' }, ' (full portion)') : null), h('td', null, itemTags(s), h('small', { class: 'muted' }, stepLabel(s))), h('td', null, String(s.repetitions)), h('td', null, String(plays.get(s.item.globalIndex) ?? 0))))),
          )),
          entries.length > 400 ? h('p', { class: 'muted' }, `Showing the first 400 of ${entries.length} entries.`) : null,
        )
      : null,
  );
}

function statusLine(st: PlayerState): string {
  switch (st.status) {
    case 'loading': return 'Loading audio…';
    case 'playing': return 'Playing';
    case 'paused': return 'Paused';
    case 'gap': return st.current && !st.current.isLastRepetition ? 'Short pause before the next repetition' : 'Short pause before the next ayah';
    case 'awaiting_assessment': return 'How did you recall this ayah? Choose an answer below, or continue.';
    case 'finished': return 'Playlist finished.';
    case 'error': return 'Audio problem';
    default: return 'Ready';
  }
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
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, a.config.label), h('p', { class: 'muted' }, `${MODE_LABEL[a.config.mode]}, ${app.reciter().name}`)), a.ended ? h('span', { class: 'chip status-resolved' }, 'Session ended') : null),
    h('div', { class: 'progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Session progress' }, h('span', { style: { width: `${pct}%` } })),
    h('p', { class: 'muted' }, `Ayah ${Math.max(1, curEntry + 1)} of ${entries.length} in the queue, ${st.completedSteps} of ${st.steps.length} plays done`),
    h(
      'section',
      { class: 'panel now-playing', 'aria-live': 'polite' },
      cur
        ? [
            h('div', { class: 'ref-big' }, formatRef(cur.item.ref)),
            h('div', { class: 'muted' }, cur.phase === 'portion' ? 'Full portion' : cur.role === 'context' ? 'Neighbouring ayah (context)' : 'Marked ayah', stepLabel(cur) ? `, ${stepLabel(cur)}` : ''),
            ayahText
              ? h('div', { class: 'quran', lang: 'ar', dir: 'rtl' }, ayahText.tokens.map((t) => [h('span', { class: t.position !== null && marked.has(t.position) ? `w marked${focus === t.position ? ' focus' : ''}` : t.position === null ? 'pause-mark' : 'w' }, t.text), ' ']))
              : h('p', { class: 'muted' }, 'Quran text not downloaded: showing the reference only.'),
            h('div', { class: 'beads', role: 'img', 'aria-label': `Repetition ${cur.repetition} of ${cur.repetitions}` }, Array.from({ length: cur.repetitions }, (_, i) => h('span', { class: `bead${i + 1 < cur.repetition ? ' done' : i + 1 === cur.repetition ? (st.status === 'playing' ? ' now' : ' done') : ''}` }))),
            h('div', null, h('strong', null, `${cur.repetition}/${cur.repetitions}`), h('span', { class: 'muted' }, ` ${statusLine(st)}`)),
          ]
        : h('p', null, statusLine(st)),
      st.status === 'error'
        ? h('div', { class: 'notice error', role: 'alert', style: { 'text-align': 'start', 'margin-top': '1rem' } }, h('p', null, st.error?.message ?? 'Audio failed.'), h('p', { class: 'muted' }, 'Nothing was skipped. Retry, or skip this ayah on purpose.'), h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', 'data-key': 'retry', onclick: () => void app.player.retry() }, 'Retry'), h('button', { type: 'button', 'data-key': 'skip', onclick: () => void app.player.skipFailed() }, 'Skip this ayah'), h('a', { class: 'btn', href: '#/settings?section=audio' }, 'Audio settings')))
        : null,
      h(
        'div',
        { class: 'controls', role: 'group', 'aria-label': 'Playback controls' },
        ctl('prev', 'Previous ayah', () => app.player.prev(), 'c-prev'),
        ctl('restart', 'Restart this ayah', () => app.player.restartAyah(), 'c-restart'),
        h('button', { type: 'button', class: 'icon primary', 'aria-label': playing ? 'Pause' : 'Play', 'data-key': 'c-play', disabled: a.ended, onclick: () => void app.player.togglePlay() }, icon(playing ? 'pause' : 'play')),
        ctl('next', 'Next ayah', () => app.player.next(), 'c-next'),
        ctl('flagNext', 'Skip to next mistake', () => app.player.nextMistake(), 'c-nextm'),
        ctl('stop', 'Stop', () => app.player.stop(), 'c-stop'),
        h('button', { type: 'button', 'data-key': 'c-again', onclick: () => void app.player.restartPlaylist() }, 'Restart playlist'),
      ),
      cur ? h('a', { href: `#/quran?surah=${cur.item.ref.surah}&focus=${cur.item.globalIndex}`, onclick: () => app.player.pause() }, 'Pause and inspect in the Quran reader') : null,
      assessable && !a.ended
        ? h(
            'div',
            null,
            h('h2', { style: { 'margin-top': '1.25rem' } }, 'How did you recall it?'),
            h('p', { class: 'muted', style: { margin: '0 auto' } }, 'Listening does not change your progress. Only your answer here does.'),
            h('div', { class: 'outcomes' }, RECALL_OUTCOMES.map((o) => h('button', { type: 'button', class: `outcome-${o}${recorded === o ? ' primary' : ''}`, 'data-key': `o-${o}`, 'aria-pressed': recorded === o ? 'true' : 'false', onclick: () => void app.recordOutcome(cur.item.ref, cur.item.globalIndex, o) }, OUTCOME_LABELS[o]))),
            st.status === 'awaiting_assessment' ? h('button', { type: 'button', class: 'quiet', style: { 'margin-top': '0.5rem' }, onclick: () => void app.player.continueAfterAssessment() }, 'Continue without answering') : null,
          )
        : null,
    ),
    h(
      'div',
      { class: 'grid two' },
      h(
        'section',
        { class: 'panel' },
        h('h2', null, 'Queue'),
        h('ol', { class: 'queue' }, entries.map((e, i) => {
          const done = e.stepIndex + e.repetitions <= st.completedSteps || (e.stepIndex < st.index && e.itemKey !== cur?.itemKey);
          return h('li', { class: `${e.role === 'context' ? 'context ' : ''}${e.itemKey === cur?.itemKey ? 'current ' : ''}${done ? 'played' : ''}` },
            h('span', { class: 'idx' }, done ? '✓' : String(i + 1)),
            h('button', { type: 'button', class: 'quiet', style: { 'justify-content': 'flex-start', padding: '0.2rem 0.4rem', 'min-height': '2rem' }, onclick: () => void app.player.jumpTo(e.stepIndex) }, formatRef(e.item.ref)),
            h('span', { class: 'row' }, a.outcomes.has(e.item.globalIndex) && e.item.mistakeIds.length ? h('span', { class: 'chip status-improved' }, 'Answered') : null, `×${e.repetitions}`),
          );
        })),
      ),
      h(
        'section',
        { class: 'panel' },
        h('h2', null, 'Finish'),
        h('p', null, `${a.outcomes.size} of ${a.built.mistakeAyahIndexes.length} marked ayat have a recorded answer.`),
        notAssessed.length ? h('p', { class: 'muted' }, `Played but not answered yet: ${notAssessed.slice(0, 8).map((i) => formatRef(st.steps.find((s) => s.item.globalIndex === i)?.item.ref ?? { surah: 1, ayah: 1 })).join(', ')}${notAssessed.length > 8 ? '…' : ''}`) : null,
        h('p', { class: 'muted' }, 'Finishing marks today’s assignment as revised. It never resolves mistakes for you; use “Mark resolved” on a mistake when you are confident.'),
        a.ended
          ? h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/dashboard' }, 'Go to dashboard'), h('a', { class: 'btn', href: '#/revision' }, 'Daily revision'))
          : h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', 'data-key': 'finish', onclick: () => void app.endSession(true) }, 'Finish session'), h('button', { type: 'button', 'data-key': 'abandon', onclick: () => void app.endSession(false) }, 'End without finishing')),
      ),
    ),
  );
}

export function sessionView(app: App): Node {
  if (app.active) return playerView(app);
  if (app.pending) return previewView(app, app.pending);
  return h(
    'div',
    null,
    h('h1', null, 'Revision session'),
    h('div', { class: 'empty' }, h('p', null, 'No session is prepared. Start one from today’s revision or from your mistakes.'), h('div', { class: 'row', style: { 'justify-content': 'center' } }, h('a', { class: 'btn primary', href: '#/revision' }, 'Daily revision'), h('a', { class: 'btn', href: '#/mistakes' }, 'My mistakes'))),
  );
}
