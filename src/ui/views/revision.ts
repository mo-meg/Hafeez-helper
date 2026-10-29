import { isUnresolved, type DailyPlan, type SessionMode } from '../../core/model.ts';
import { PlanService } from '../../core/plan/planService.ts';
import { estimateDurationMs } from '../../core/playlist/sequence.ts';
import { fromIndex } from '../../core/quran/refs.ts';
import { describeScope, scopeContains, scopeIntervals, scopeKey, type RevisionScope } from '../../core/quran/scope.ts';
import type { SessionConfig } from '../../core/session/sessionBuilder.ts';
import type { App } from '../app.ts';
import { scopePicker } from '../components/scopePicker.ts';
import { formatDate, formatDuration, h } from '../dom.ts';
import { fmtDate, fmtDateKey, fmtNum, t, tn, type MessageKey } from '../i18n/index.ts';
import { errorText, refLabel, scopeLabel } from '../i18n/labels.ts';

const MODES: ReadonlyArray<{ mode: SessionMode; title: MessageKey; text: MessageKey }> = [
  { mode: 'mistakes', title: 'mode.mistakes', text: 'rev.modeMistakesText' },
  { mode: 'combined', title: 'mode.combined', text: 'rev.modeCombinedText' },
  { mode: 'full', title: 'mode.full', text: 'rev.modeFullText' },
];

export function sessionConfigFor(app: App, scope: RevisionScope, mode: SessionMode, planId: string | null): SessionConfig {
  const p = app.prefs;
  return {
    mode,
    scope,
    planId,
    label: describeScope(scope, app.quran.index),
    options: { contextBefore: p.contextBefore, contextAfter: p.contextAfter, contextAcrossSurahs: p.contextAcrossSurahs, wordPractice: p.wordPractice, categories: p.categories },
    repeat: p.repeat,
    portionAyahRepeat: p.portionAyahRepeat,
    reciterId: p.reciterId,
  };
}

export function wordCounter(app: App): ((i: number) => number | null) | null {
  const t = app.quran.text;
  return t ? (i: number) => t.ayahAt(i).tokens.filter((x) => x.position !== null).length : null;
}

function boundaries(app: App, scope: RevisionScope): HTMLElement {
  const index = app.quran.index;
  const iv = scopeIntervals(scope, index);
  const first = iv[0];
  const last = iv[iv.length - 1];
  const subs: HTMLElement[] = [];
  if (scope.type === 'division' && (scope.kind === 'hizb' || scope.kind === 'juz' || scope.kind === 'quarter')) {
    const parent = index.range(scope.kind, scope.number);
    const kind = scope.kind === 'quarter' ? 'eighth' : 'quarter';
    for (const c of index.children(parent, kind)) {
      const label = kind === 'quarter' ? t('division.quarterOfHizb', { q: ((c.number - 1) % 4) + 1, hizb: Math.ceil(c.number / 4) }) : t('division.eighthN', { e: ((c.number - 1) % 8) + 1 });
      subs.push(h('li', null, h('a', { href: `#/quran?${c.kind}=${c.number}&focus=${c.startIndex}` }, label), t('rev.startsAt', { ref: refLabel(c.start) })));
    }
  }
  return h(
    'div',
    null,
    h('dl', { class: 'kv' }, h('dt', null, t('common.begins')), h('dd', null, first ? refLabel(fromIndex(first.start)) : '—'), h('dt', null, t('common.ends')), h('dd', null, last ? refLabel(fromIndex(last.end)) : '—')),
    subs.length ? h('ul', { style: { margin: '0.25rem 0 0', 'padding-inline-start': '1.2rem' } }, subs) : null,
  );
}

function planCard(app: App, plan: DailyPlan): HTMLElement {
  const index = app.quran.index;
  let iv;
  try {
    iv = scopeIntervals(plan.scope, index);
  } catch (e) {
    return h('div', { class: 'notice error' }, t('rev.cannotShow', { portion: scopeLabel(plan.scope), detail: errorText(e) }));
  }
  const inScope = app.data.mistakes.filter((m) => scopeContains(iv, m.globalIndex));
  const unresolved = inScope.filter((m) => isUnresolved(m.status));
  const lastDone = app.data.sessions.filter((s) => s.status === 'completed' && scopeKey(s.scope) === scopeKey(plan.scope)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  let mode: SessionMode = unresolved.length ? 'mistakes' : 'full';
  const wc = wordCounter(app);
  const durations = new Map(MODES.map((m) => {
    const built = app.build(sessionConfigFor(app, plan.scope, m.mode, plan.id));
    return [m.mode, { steps: built.steps.length, ms: estimateDurationMs(built.steps, app.prefs.repeat.playbackRate, wc) }];
  }));
  const statusText = { pending: t('common.notStarted'), in_progress: t('common.inProgress'), completed: t('common.completed') }[plan.status];
  const next = PlanService.nextScope(plan.scope, index);

  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'today-title' },
    h('div', { class: 'row spread' }, h('h2', { id: 'today-title' }, t('rev.todayTitle', { portion: scopeLabel(plan.scope, index) })), h('span', { class: `chip ${plan.status === 'completed' ? 'status-resolved' : plan.status === 'in_progress' ? 'status-under_review' : ''}` }, statusText)),
    boundaries(app, plan.scope),
    h(
      'div',
      { class: 'metrics', style: { margin: '1rem 0' } },
      h('div', { class: 'metric' }, h('div', { class: 'value' }, fmtNum(inScope.length)), h('div', { class: 'label' }, t('common.markedMistakes'))),
      h('div', { class: `metric${unresolved.length ? ' alert' : ''}` }, h('div', { class: 'value' }, fmtNum(unresolved.length)), h('div', { class: 'label' }, t('common.unresolved'))),
      h('div', { class: 'metric' }, h('div', { class: 'value' }, fmtNum(new Set(unresolved.map((m) => m.globalIndex)).size)), h('div', { class: 'label' }, t('rev.ayatToRevise'))),
      h('div', { class: 'metric' }, h('div', { class: 'value', style: { 'font-size': '1.1rem' } }, lastDone ? formatDate(lastDone.endedAt ?? lastDone.startedAt) : t('common.never')), h('div', { class: 'label' }, t('rev.lastRevised'))),
    ),
    h(
      'fieldset',
      null,
      h('legend', null, t('rev.howQuestion')),
      MODES.map((m) => {
        const d = durations.get(m.mode);
        const empty = !d || d.steps === 0;
        return h(
          'label',
          { class: 'choice' },
          h('input', { type: 'radio', name: 'mode', value: m.mode, checked: m.mode === mode, disabled: empty, onchange: () => { mode = m.mode; } }),
          h('span', null, h('strong', null, t(m.title)), t(m.text), h('br'), h('small', null, empty ? t('rev.nothingToPlay') : tn('rev.estimate', d.steps, { duration: formatDuration(d.ms) }))),
        );
      }),
    ),
    h(
      'div',
      { class: 'row', style: { 'margin-top': '1rem' } },
      h('button', { type: 'button', class: 'primary big', 'data-key': 'start-revision', onclick: () => app.prepare(sessionConfigFor(app, plan.scope, mode, plan.id)) }, t('rev.start')),
      h('a', { class: 'btn', href: `#/quran?${plan.scope.type === 'division' ? `${plan.scope.kind}=${plan.scope.number}` : `focus=${iv[0]?.start ?? 1}&surah=${fromIndex(iv[0]?.start ?? 1).surah}`}` }, t('rev.read')),
      plan.status !== 'completed' ? h('button', { type: 'button', onclick: () => void app.act(async () => { await app.s.plans.setPlanStatus(plan.id, 'completed'); await app.refresh(); }, t('rev.markedDone')) }, t('rev.doneWithout')) : null,
    ),
    next ? h('p', { class: 'muted', style: { 'margin-top': '0.75rem' } }, h('button', { type: 'button', class: 'quiet', onclick: () => void setTomorrow(app, next) }, t('rev.planTomorrow', { portion: scopeLabel(next, index) }))) : null,
  );
}

async function setTomorrow(app: App, scope: RevisionScope) {
  const day = new Date(app.now().getTime() + 86_400_000);
  const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  await app.act(async () => {
    await app.s.plans.setPlan(key, scope);
    await app.refresh();
  }, t('rev.plannedTomorrow', { portion: scopeLabel(scope, app.quran.index) }));
}

export function revisionView(app: App): Node {
  const today = app.today();
  const plan = app.data.plans.find((p) => p.date === today && p.kind === 'revision') ?? null;
  const memo = app.data.plans.find((p) => p.date === today && p.kind === 'memorization') ?? null;
  const editing = app.route.params.get('edit') === '1' || !plan;
  const index = app.quran.index;
  const picker = scopePicker(index, plan?.scope ?? null, { idPrefix: 'plan' });
  const memoPicker = scopePicker(index, memo?.scope ?? null, { idPrefix: 'memo' });
  const error = h('p', { role: 'alert', style: { color: 'var(--mistake)' } });
  const save = (kind: 'revision' | 'memorization', p: ReturnType<typeof scopePicker>) => async () => {
    const r = p.read();
    if ('error' in r) {
      error.textContent = r.error;
      return;
    }
    try {
      scopeIntervals(r.scope, index);
    } catch (e) {
      error.textContent = errorText(e);
      return;
    }
    await app.act(async () => {
      await app.s.plans.setPlan(today, r.scope, kind);
      await app.refresh();
      if (kind === 'revision') app.navigate('#/revision');
    }, kind === 'revision' ? t('rev.setToast', { portion: scopeLabel(r.scope, index) }) : t('rev.memoToast', { portion: scopeLabel(r.scope, index) }));
  };
  const unfinished = app.data.sessions.filter((s) => s.status === 'active' && s.id !== app.active?.id);
  const previous = app.data.plans.filter((p) => p.kind === 'revision' && p.date < today).sort((a, b) => b.date.localeCompare(a.date));
  const suggestion = previous[0] ? PlanService.nextScope(previous[0].scope, index) : null;

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('rev.title')), h('p', { class: 'muted' }, fmtDate(app.now(), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })))),
    unfinished.length
      ? h('div', { class: 'notice warn' }, h('p', null, tn('rev.interrupted', unfinished.length)), h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => void app.act(async () => { for (const s of unfinished) await app.s.plans.abandonSession(s.id); await app.refresh(); }) }, t('rev.closeInterrupted'))))
      : null,
    plan && !editing ? planCard(app, plan) : null,
    editing
      ? h(
          'section',
          { class: 'panel' },
          h('h2', null, plan ? t('rev.change') : t('rev.set')),
          h('p', { class: 'muted' }, t('rev.chooseHelp')),
          suggestion ? h('p', null, h('button', { type: 'button', onclick: () => void app.act(async () => { await app.s.plans.setPlan(today, suggestion); await app.refresh(); app.navigate('#/revision'); }) }, t('rev.continueWith', { portion: scopeLabel(suggestion, index) })), h('span', { class: 'muted' }, t('rev.after', { portion: scopeLabel(previous[0]?.scope ?? suggestion, index), date: previous[0] ? fmtDateKey(previous[0].date) : '' }))) : null,
          picker.el,
          error,
          h('div', { class: 'row', style: { 'margin-top': '0.75rem' } }, h('button', { type: 'button', class: 'primary', onclick: save('revision', picker) }, t('rev.set')), plan ? h('a', { class: 'btn', href: '#/revision' }, t('common.cancel')) : null),
        )
      : h('p', null, h('a', { href: '#/revision?edit=1' }, t('rev.changeLink'))),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, t('rev.memoTitle')),
      memo
        ? h('div', null, h('p', null, t('rev.memoToday', { portion: scopeLabel(memo.scope, index) }), h('span', { class: 'muted' }, memo.status === 'completed' ? t('rev.memoDone') : t('rev.memoNotDone'))), boundaries(app, memo.scope), h('div', { class: 'row' }, memo.status !== 'completed' ? h('button', { type: 'button', onclick: () => void app.act(async () => { await app.s.plans.setPlanStatus(memo.id, 'completed'); await app.refresh(); }, t('rev.memoMarkedDone')) }, t('rev.markMemorized')) : null, h('button', { type: 'button', class: 'quiet', onclick: () => void app.act(async () => { await app.s.plans.deletePlan(memo.id); await app.refresh(); }) }, t('common.remove'))))
        : h('div', null, h('p', { class: 'muted' }, t('rev.memoHelp')), memoPicker.el, h('div', { class: 'row', style: { 'margin-top': '0.5rem' } }, h('button', { type: 'button', onclick: save('memorization', memoPicker) }, t('rev.setMemo')))),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, t('rev.recent')),
      previous.length
        ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, t('common.date')), h('th', null, t('common.portion')), h('th', null, t('common.status')))), h('tbody', null, previous.slice(0, 10).map((p) => h('tr', null, h('td', null, fmtDateKey(p.date)), h('td', null, scopeLabel(p.scope, index)), h('td', null, { pending: t('common.notStarted'), in_progress: t('common.started'), completed: t('common.completed') }[p.status]))))))
        : h('p', { class: 'muted' }, t('rev.noRecent')),
      h('p', { class: 'muted' }, t('rev.reminders'), app.prefs.reminder.enabled ? t('rev.remindersOn', { time: app.prefs.reminder.time }) : t('rev.remindersOff'), h('a', { href: '#/settings?section=reminders' }, t('rev.reminderSettings'))),
    ),
  );
}
