import { isUnresolved, type DailyPlan, type SessionMode } from '../../core/model.ts';
import { PlanService } from '../../core/plan/planService.ts';
import { estimateDurationMs } from '../../core/playlist/sequence.ts';
import { formatRef, fromIndex } from '../../core/quran/refs.ts';
import { describeScope, scopeContains, scopeIntervals, scopeKey, type RevisionScope } from '../../core/quran/scope.ts';
import type { SessionConfig } from '../../core/session/sessionBuilder.ts';
import type { App } from '../app.ts';
import { scopePicker } from '../components/scopePicker.ts';
import { formatDate, formatDuration, h } from '../dom.ts';

const MODES: ReadonlyArray<{ mode: SessionMode; title: string; text: string }> = [
  { mode: 'mistakes', title: 'Mistake revision', text: 'Listen only to the ayat where you made mistakes, in Quran order.' },
  { mode: 'combined', title: 'Combined revision', text: 'Your marked ayat first, then the complete portion.' },
  { mode: 'full', title: 'Full revision', text: 'Listen to the complete assigned portion from start to end.' },
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
      const label = kind === 'quarter' ? `Quarter ${((c.number - 1) % 4) + 1} of Hizb ${Math.ceil(c.number / 4)}` : `Eighth ${((c.number - 1) % 8) + 1}`;
      subs.push(h('li', null, h('a', { href: `#/quran?${c.kind}=${c.number}&focus=${c.startIndex}` }, label), ` starts at ${formatRef(c.start)}`));
    }
  }
  return h(
    'div',
    null,
    h('dl', { class: 'kv' }, h('dt', null, 'Begins'), h('dd', null, first ? formatRef(fromIndex(first.start)) : '—'), h('dt', null, 'Ends'), h('dd', null, last ? formatRef(fromIndex(last.end)) : '—')),
    subs.length ? h('ul', { style: { margin: '0.25rem 0 0', 'padding-inline-start': '1.2rem' } }, subs) : null,
  );
}

function planCard(app: App, plan: DailyPlan): HTMLElement {
  const index = app.quran.index;
  let iv;
  try {
    iv = scopeIntervals(plan.scope, index);
  } catch (e) {
    return h('div', { class: 'notice error' }, `Today's assignment (${describeScope(plan.scope)}) cannot be shown: ${e instanceof Error ? e.message : e}`);
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
  const statusText = { pending: 'Not started', in_progress: 'In progress', completed: 'Completed' }[plan.status];
  const next = PlanService.nextScope(plan.scope, index);

  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'today-title' },
    h('div', { class: 'row spread' }, h('h2', { id: 'today-title' }, `Today: ${describeScope(plan.scope, index)}`), h('span', { class: `chip ${plan.status === 'completed' ? 'status-resolved' : plan.status === 'in_progress' ? 'status-under_review' : ''}` }, statusText)),
    boundaries(app, plan.scope),
    h(
      'div',
      { class: 'metrics', style: { margin: '1rem 0' } },
      h('div', { class: 'metric' }, h('div', { class: 'value' }, String(inScope.length)), h('div', { class: 'label' }, 'Marked mistakes')),
      h('div', { class: `metric${unresolved.length ? ' alert' : ''}` }, h('div', { class: 'value' }, String(unresolved.length)), h('div', { class: 'label' }, 'Unresolved')),
      h('div', { class: 'metric' }, h('div', { class: 'value' }, String(new Set(unresolved.map((m) => m.globalIndex)).size)), h('div', { class: 'label' }, 'Ayat to revise')),
      h('div', { class: 'metric' }, h('div', { class: 'value', style: { 'font-size': '1.1rem' } }, lastDone ? formatDate(lastDone.endedAt ?? lastDone.startedAt) : 'Never'), h('div', { class: 'label' }, 'Last revised')),
    ),
    h(
      'fieldset',
      null,
      h('legend', null, 'How do you want to revise?'),
      MODES.map((m) => {
        const d = durations.get(m.mode);
        const empty = !d || d.steps === 0;
        return h(
          'label',
          { class: 'choice' },
          h('input', { type: 'radio', name: 'mode', value: m.mode, checked: m.mode === mode, disabled: empty, onchange: () => { mode = m.mode; } }),
          h('span', null, h('strong', null, m.title), m.text, h('br'), h('small', null, empty ? 'Nothing to play: no unresolved mistakes in this portion.' : `${d.steps} plays, ${formatDuration(d.ms)} (estimate)`)),
        );
      }),
    ),
    h(
      'div',
      { class: 'row', style: { 'margin-top': '1rem' } },
      h('button', { type: 'button', class: 'primary big', 'data-key': 'start-revision', onclick: () => app.prepare(sessionConfigFor(app, plan.scope, mode, plan.id)) }, 'Start revision'),
      h('a', { class: 'btn', href: `#/quran?${plan.scope.type === 'division' ? `${plan.scope.kind}=${plan.scope.number}` : `focus=${iv[0]?.start ?? 1}&surah=${fromIndex(iv[0]?.start ?? 1).surah}`}` }, 'Read in the Quran'),
      plan.status !== 'completed' ? h('button', { type: 'button', onclick: () => void app.act(async () => { await app.s.plans.setPlanStatus(plan.id, 'completed'); await app.refresh(); }, 'Marked today’s revision as done.') }, 'I revised it without the app') : null,
    ),
    next ? h('p', { class: 'muted', style: { 'margin-top': '0.75rem' } }, h('button', { type: 'button', class: 'quiet', onclick: () => void setTomorrow(app, next) }, `Plan ${describeScope(next, index)} for tomorrow`)) : null,
  );
}

async function setTomorrow(app: App, scope: RevisionScope) {
  const t = new Date(app.now().getTime() + 86_400_000);
  const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  await app.act(async () => {
    await app.s.plans.setPlan(key, scope);
    await app.refresh();
  }, `Planned ${describeScope(scope, app.quran.index)} for tomorrow.`);
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
      error.textContent = e instanceof Error ? e.message : String(e);
      return;
    }
    await app.act(async () => {
      await app.s.plans.setPlan(today, r.scope, kind);
      await app.refresh();
      if (kind === 'revision') app.navigate('#/revision');
    }, kind === 'revision' ? `Today's revision: ${describeScope(r.scope, index)}.` : `Today's memorization: ${describeScope(r.scope, index)}.`);
  };
  const unfinished = app.data.sessions.filter((s) => s.status === 'active' && s.id !== app.active?.id);
  const previous = app.data.plans.filter((p) => p.kind === 'revision' && p.date < today).sort((a, b) => b.date.localeCompare(a.date));
  const suggestion = previous[0] ? PlanService.nextScope(previous[0].scope, index) : null;

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Daily revision'), h('p', { class: 'muted' }, new Date(app.now()).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })))),
    unfinished.length
      ? h('div', { class: 'notice warn' }, h('p', null, `${unfinished.length} earlier session${unfinished.length > 1 ? 's were' : ' was'} interrupted (for example by closing the app). Recall results you recorded are saved.`), h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => void app.act(async () => { for (const s of unfinished) await app.s.plans.abandonSession(s.id); await app.refresh(); }) }, 'Close interrupted sessions')))
      : null,
    plan && !editing ? planCard(app, plan) : null,
    editing
      ? h(
          'section',
          { class: 'panel' },
          h('h2', null, plan ? 'Change today’s revision' : 'Set today’s revision'),
          h('p', { class: 'muted' }, 'Choose the portion you will revise today. Boundaries come from the verified division data.'),
          suggestion ? h('p', null, h('button', { type: 'button', onclick: () => void app.act(async () => { await app.s.plans.setPlan(today, suggestion); await app.refresh(); app.navigate('#/revision'); }) }, `Continue with ${describeScope(suggestion, index)}`), h('span', { class: 'muted' }, ` after ${describeScope(previous[0]?.scope ?? suggestion, index)} on ${previous[0]?.date}`)) : null,
          picker.el,
          error,
          h('div', { class: 'row', style: { 'margin-top': '0.75rem' } }, h('button', { type: 'button', class: 'primary', onclick: save('revision', picker) }, 'Set today’s revision'), plan ? h('a', { class: 'btn', href: '#/revision' }, 'Cancel') : null),
        )
      : h('p', null, h('a', { href: '#/revision?edit=1' }, 'Change today’s portion')),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'Memorization plan'),
      memo
        ? h('div', null, h('p', null, `New memorization today: ${describeScope(memo.scope, index)}. `, h('span', { class: 'muted' }, memo.status === 'completed' ? 'Done.' : 'Not marked done yet.')), boundaries(app, memo.scope), h('div', { class: 'row' }, memo.status !== 'completed' ? h('button', { type: 'button', onclick: () => void app.act(async () => { await app.s.plans.setPlanStatus(memo.id, 'completed'); await app.refresh(); }, 'Memorization marked done.') }, 'Mark memorized') : null, h('button', { type: 'button', class: 'quiet', onclick: () => void app.act(async () => { await app.s.plans.deletePlan(memo.id); await app.refresh(); }) }, 'Remove')))
        : h('div', null, h('p', { class: 'muted' }, 'Optional: record the new portion you are memorizing today, separate from revision.'), memoPicker.el, h('div', { class: 'row', style: { 'margin-top': '0.5rem' } }, h('button', { type: 'button', onclick: save('memorization', memoPicker) }, 'Set memorization plan'))),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'Recent assignments'),
      previous.length
        ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Date'), h('th', null, 'Portion'), h('th', null, 'Status'))), h('tbody', null, previous.slice(0, 10).map((p) => h('tr', null, h('td', null, p.date), h('td', null, describeScope(p.scope, index)), h('td', null, { pending: 'Not started', in_progress: 'Started', completed: 'Completed' }[p.status]))))))
        : h('p', { class: 'muted' }, 'Your past daily assignments will appear here.'),
      h('p', { class: 'muted' }, 'Reminders: ', app.prefs.reminder.enabled ? `daily at ${app.prefs.reminder.time} while the app is open. ` : 'off. ', h('a', { href: '#/settings?section=reminders' }, 'Reminder settings')),
    ),
  );
}
