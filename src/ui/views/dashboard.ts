import { aggregateDashboard, type DashboardData, type PracticeItem } from '../../core/dashboard/aggregate.ts';
import { CATEGORY_LABELS, type Mistake } from '../../core/model.ts';
import { DEFAULT_SCORING } from '../../core/review/scoring.ts';
import { effectiveDueDate } from '../../core/review/scheduler.ts';
import { formatRef } from '../../core/quran/refs.ts';
import { describeScope } from '../../core/quran/scope.ts';
import type { App } from '../app.ts';
import { bar } from '../components/charts.ts';
import { h, relativeDays } from '../dom.ts';

export function dashboardData(app: App): DashboardData {
  return aggregateDashboard({ ...app.data, index: app.quran.index, now: app.now() });
}

export function scoreExplanation(): HTMLElement {
  const c = DEFAULT_SCORING;
  return h(
    'details',
    null,
    h('summary', null, 'How is this estimated?'),
    h('p', null, 'The score looks only at ayat where you recorded a mistake, and only at the answers you gave after reciting them. Listening to audio never changes it.'),
    h('p', null, `Each answer has a value: correct without difficulty ${c.outcomeValues.correct_easy}, correct but difficult ${c.outcomeValues.correct_difficult}, needed a prompt ${c.outcomeValues.needed_prompt}, mistake again ${c.outcomeValues.mistake_again}. For every ayah the last ${c.window} answers are averaged, recent ones weighted more; repeated answers within one session count once. Ayat you have not reviewed yet count as ${c.unreviewedValue}. If your last correct recall is older than ${c.staleAfterDays} days, a small staleness penalty applies. Ayat you marked resolved count at least ${c.resolvedFloor}.`),
    h('p', { class: 'muted' }, 'This is a transparent heuristic to show direction over time, not a scientifically validated measure of memorization.'),
  );
}

function practiceList(items: readonly PracticeItem[], empty: string, detail: (i: PracticeItem) => string): HTMLElement {
  if (!items.length) return h('p', { class: 'muted' }, empty);
  return h('ul', { class: 'sub-list' }, items.map((i) => h('li', null, h('a', { class: 'btn quiet', style: { width: '100%', 'justify-content': 'space-between' }, href: `#/quran?surah=${i.surah}&focus=${i.globalIndex}` }, h('span', null, formatRef(i)), h('small', { class: 'muted' }, detail(i))))));
}

function dueList(app: App, due: readonly Mistake[]): HTMLElement {
  const now = app.now();
  const byAyah = new Map<number, Mistake[]>();
  for (const m of due) byAyah.set(m.globalIndex, [...(byAyah.get(m.globalIndex) ?? []), m]);
  const rows = [...byAyah.values()].slice(0, 8);
  return h('ul', { class: 'sub-list' }, rows.map((ms) => {
    const m = ms[0] as Mistake;
    const d = effectiveDueDate(m);
    return h('li', null, h('a', { class: 'btn quiet', style: { width: '100%', 'justify-content': 'space-between' }, href: `#/quran?surah=${m.surah}&focus=${m.globalIndex}` }, h('span', null, formatRef(m), ' ', h('small', { class: 'muted' }, [...new Set(ms.map((x) => CATEGORY_LABELS[x.category]))].join(', '))), h('small', { class: 'muted' }, d && d < now ? `due ${relativeDays(d.toISOString(), now)}` : 'due now')));
  }));
}

export function dashboardView(app: App): Node {
  const d = dashboardData(app);
  const plan = d.todayPlan;
  const fresh = d.totalMistakes === 0 && app.data.plans.length === 0;
  const maxCat = Math.max(1, ...d.categories.map((c) => c.total));
  const metric = (value: string | number, label: string, cls = '') => h('div', { class: `metric ${cls}` }, h('div', { class: 'value' }, String(value)), h('div', { class: 'label' }, label));

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Assalamu alaikum'), h('p', { class: 'muted' }, 'Your revision at a glance. Everything here comes from what you recorded on this device.'))),
    d.hasDemoData ? h('div', { class: 'notice demo', role: 'note' }, h('p', null, 'Demo data is loaded. Records marked “Demo” are examples, not your progress.'), h('a', { href: '#/settings?section=privacy' }, 'Remove demo data')) : null,
    fresh
      ? h(
          'section',
          { class: 'panel' },
          h('h2', null, 'Getting started'),
          h(
            'ol',
            null,
            h('li', null, app.quran.text ? 'Quran text and divisions are downloaded and verified.' : h('span', null, h('a', { href: '#/settings?section=data' }, 'Download the Quran text and divisions'), ' (one time, then it works offline).')),
            h('li', null, 'While reciting or listening, ', h('a', { href: '#/quran' }, 'open the Quran'), ' and tap the words or ayat where you made mistakes.'),
            h('li', null, h('a', { href: '#/revision' }, 'Set today’s revision'), ', for example a hizb, and start a mistake revision session.'),
          ),
          h('p', { class: 'muted' }, 'Want to look around first? You can load clearly labelled demo data in Settings.'),
        )
      : null,
    h(
      'div',
      { class: 'grid two' },
      h(
        'section',
        { class: 'panel' },
        h('h2', null, 'Today'),
        plan
          ? [
              h('p', null, h('strong', null, describeScope(plan.scope, app.quran.index)), ' ', h('span', { class: `chip ${plan.status === 'completed' ? 'status-resolved' : plan.status === 'in_progress' ? 'status-under_review' : ''}` }, { pending: 'Not started', in_progress: 'In progress', completed: 'Completed' }[plan.status])),
              h('a', { class: 'btn primary', href: '#/revision' }, plan.status === 'completed' ? 'Review again' : 'Start revision'),
            ]
          : [h('p', { class: 'muted' }, 'No revision is set for today.'), h('a', { class: 'btn primary', href: '#/revision' }, 'Set today’s revision')],
        h('div', { class: 'metrics', style: { 'margin-top': '1rem' } }, metric(d.ayatReviewedToday, 'Ayat recalled today'), metric(d.streakDays, d.streakDays === 1 ? 'Day of revision in a row' : 'Days of revision in a row', d.streakDays > 0 ? 'good' : '')),
      ),
      h(
        'section',
        { class: 'panel' },
        h('h2', null, 'Estimated revision quality'),
        d.overall.score === null
          ? h('p', { class: 'muted' }, 'No score yet. It appears once you have recorded mistakes.')
          : [
              h('div', { class: 'score' }, h('span', { class: 'num' }, String(d.overall.score)), h('span', { class: 'of' }, '/ 100')),
              h('p', { class: 'muted' }, `Across ${d.overall.ayahCount} ayat with mistakes: ${d.overall.reviewedAyahCount} reviewed, ${d.overall.unreviewedAyahCount} not yet reviewed, ${d.overall.staleAyahCount} not recalled correctly for a while.`),
            ],
        scoreExplanation(),
      ),
    ),
    h(
      'div',
      { class: 'metrics', style: { margin: '1rem 0' } },
      metric(d.ayatWithMistakes, 'Ayat with mistakes'),
      metric(d.unresolved, 'Unresolved mistakes', d.unresolved ? 'alert' : ''),
      metric(d.resolved, 'Resolved', d.resolved ? 'good' : ''),
      metric(d.reappeared, 'Mistakes that came back'),
      metric(d.due.length, 'Due for review'),
      metric(d.completedSessions, 'Completed sessions'),
    ),
    h(
      'div',
      { class: 'grid two' },
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'row spread' }, h('h2', null, 'Due for review'), d.due.length ? h('button', {
          type: 'button', class: 'primary', 'data-key': 'revise-due',
          onclick: () => {
            const p = app.prefs;
            app.prepare({ mode: 'mistakes', scope: { type: 'all' }, planId: null, label: 'Due mistakes', options: { mistakeIds: d.due.map((m) => m.id), contextBefore: p.contextBefore, contextAfter: p.contextAfter, contextAcrossSurahs: p.contextAcrossSurahs, wordPractice: p.wordPractice }, repeat: p.repeat, portionAyahRepeat: p.portionAyahRepeat, reciterId: p.reciterId });
          },
        }, 'Revise due mistakes') : null),
        d.due.length ? dueList(app, d.due) : h('p', { class: 'muted' }, 'Nothing is due right now.'),
        d.upcoming.length ? h('div', null, h('h3', { style: { 'margin-top': '1rem' } }, 'Coming up'), h('ul', { class: 'sub-list' }, d.upcoming.slice(0, 5).map((m) => h('li', { style: { padding: '0.35rem 0', display: 'flex', 'justify-content': 'space-between' } }, h('span', null, formatRef(m)), h('small', { class: 'muted' }, relativeDays(effectiveDueDate(m)?.toISOString() ?? null, app.now())))))) : null,
      ),
      h(
        'section',
        { class: 'panel' },
        h('h2', null, 'Mistake types'),
        d.totalMistakes === 0
          ? h('p', { class: 'muted' }, 'No mistakes recorded yet.')
          : h('table', null, h('tbody', null, d.categories.filter((c) => c.total > 0).map((c) => h('tr', null, h('td', null, CATEGORY_LABELS[c.category]), h('td', { style: { width: '40%' } }, bar(c.total, maxCat, c.unresolved > 0)), h('td', null, `${c.total}`, h('small', { class: 'muted' }, ` (${c.unresolved} open)`)))))),
      ),
      h('section', { class: 'panel' }, h('h2', null, 'Need the most practice'), practiceList(d.mostPractice, 'Nothing stands out yet.', (i) => `${i.lapses} repeat${i.lapses === 1 ? '' : 's'}, ${i.unresolved} open`)),
      h('section', { class: 'panel' }, h('h2', null, 'Not reviewed recently'), practiceList(d.notReviewedRecently, 'All open mistakes were reviewed in the last two weeks.', (i) => (i.lastReviewedAt ? `last ${relativeDays(i.lastReviewedAt, app.now())}` : 'never reviewed'))),
    ),
  );
}
