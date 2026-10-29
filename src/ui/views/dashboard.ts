import { aggregateDashboard, type DashboardData, type PracticeItem } from '../../core/dashboard/aggregate.ts';
import type { Mistake } from '../../core/model.ts';
import { DEFAULT_SCORING } from '../../core/review/scoring.ts';
import { effectiveDueDate } from '../../core/review/scheduler.ts';
import type { App } from '../app.ts';
import { bar } from '../components/charts.ts';
import { h, relativeDays } from '../dom.ts';
import { fmtList, fmtNum, t, tn } from '../i18n/index.ts';
import { categoryLabel, modeLabel, outcomeLabel, refLabel, scopeLabel } from '../i18n/labels.ts';

export function dashboardData(app: App): DashboardData {
  return aggregateDashboard({ ...app.data, index: app.quran.index, now: app.now() });
}

export function scoreExplanation(): HTMLElement {
  const c = DEFAULT_SCORING;
  return h(
    'details',
    null,
    h('summary', null, t('score.how')),
    h('p', null, t('score.p1')),
    h('p', null, t('score.p2', { easy: c.outcomeValues.correct_easy, difficult: c.outcomeValues.correct_difficult, prompt: c.outcomeValues.needed_prompt, again: c.outcomeValues.mistake_again, window: c.window, unreviewed: c.unreviewedValue, stale: c.staleAfterDays, floor: c.resolvedFloor })),
    h('p', { class: 'muted' }, t('score.p3')),
  );
}

const rowLink = (href: string, start: Node | string, end: Node | string) =>
  h('a', { class: 'btn quiet', style: { width: '100%', 'justify-content': 'space-between' }, href }, h('span', null, start), h('small', { class: 'muted' }, end));

function practiceList(items: readonly PracticeItem[], empty: string, detail: (i: PracticeItem) => string): HTMLElement {
  if (!items.length) return h('p', { class: 'muted' }, empty);
  return h('ul', { class: 'sub-list' }, items.map((i) => h('li', null, rowLink(`#/quran?surah=${i.surah}&focus=${i.globalIndex}`, refLabel(i), detail(i)))));
}

function dueList(app: App, due: readonly Mistake[]): HTMLElement {
  const now = app.now();
  const byAyah = new Map<number, Mistake[]>();
  for (const m of due) byAyah.set(m.globalIndex, [...(byAyah.get(m.globalIndex) ?? []), m]);
  const rows = [...byAyah.values()].slice(0, 8);
  return h('ul', { class: 'sub-list' }, rows.map((ms) => {
    const m = ms[0] as Mistake;
    const d = effectiveDueDate(m);
    const cats = fmtList([...new Set(ms.map((x) => categoryLabel(x.category)))]);
    return h('li', null, rowLink(`#/quran?surah=${m.surah}&focus=${m.globalIndex}`, h('span', null, refLabel(m), ' ', h('small', { class: 'muted' }, cats)), d && d < now ? t('dash.dueSince', { when: relativeDays(d.toISOString(), now) }) : t('dash.dueNow')));
  }));
}

/** Latest recall answers and sessions, newest first. */
function recentActivity(app: App): HTMLElement {
  const now = app.now();
  const index = app.quran.index;
  const items: Array<{ at: string; node: Node }> = [];
  const seen = new Set<string>();
  for (const r of app.data.reviews) {
    const k = `${r.globalIndex}|${r.sessionId}|${r.at}`;
    if (seen.has(k)) continue;
    seen.add(k);
    items.push({ at: r.at, node: h('a', { href: `#/quran?surah=${r.surah}&focus=${r.globalIndex}` }, t('dash.recentAnswer', { ref: refLabel(r), outcome: outcomeLabel(r.outcome) })) });
  }
  for (const s of app.data.sessions) {
    if (s.status === 'active') continue;
    items.push({ at: s.endedAt ?? s.startedAt, node: h('span', null, t('dash.recentSession', { mode: modeLabel(s.mode), portion: scopeLabel(s.scope, index) })) });
  }
  items.sort((a, b) => b.at.localeCompare(a.at));
  if (!items.length) return h('p', { class: 'muted' }, t('dash.noRecent'));
  return h(
    'div',
    null,
    h('ul', { class: 'activity' }, items.slice(0, 6).map((i) => h('li', null, i.node, h('span', { class: 'when' }, relativeDays(i.at, now))))),
    h('p', { style: { margin: '0.5rem 0 0' } }, h('a', { href: '#/progress' }, t('dash.allProgress'))),
  );
}

export function dashboardView(app: App): Node {
  const d = dashboardData(app);
  const plan = d.todayPlan;
  const fresh = d.totalMistakes === 0 && app.data.plans.length === 0;
  const maxCat = Math.max(1, ...d.categories.map((c) => c.total));
  const metric = (value: number, label: string, cls = '') => h('div', { class: `metric ${cls}` }, h('div', { class: 'value' }, fmtNum(value)), h('div', { class: 'label' }, label));
  const planStatus = { pending: t('common.notStarted'), in_progress: t('common.inProgress'), completed: t('common.completed') };

  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('dash.greeting')), h('p', { class: 'muted' }, t('dash.intro')))),
    d.hasDemoData ? h('div', { class: 'notice demo', role: 'note' }, h('p', null, t('dash.demoNotice')), h('a', { href: '#/settings?section=privacy' }, t('dash.removeDemo'))) : null,
    fresh
      ? h(
          'section',
          { class: 'panel', style: { 'margin-bottom': '1rem' } },
          h('h2', null, t('dash.gettingStarted')),
          h(
            'ol',
            null,
            h('li', null, app.quran.text ? t('dash.step1Done') : h('span', null, h('a', { href: '#/settings?section=data' }, t('dash.step1Link')), t('dash.step1Rest'))),
            h('li', null, t('dash.step2Before'), h('a', { href: '#/quran' }, t('dash.step2Link')), t('dash.step2After')),
            h('li', null, h('a', { href: '#/revision' }, t('dash.step3Link')), t('dash.step3After')),
          ),
          h('p', { class: 'muted' }, t('dash.demoHint')),
        )
      : null,
    h(
      'div',
      { class: 'grid two' },
      h(
        'section',
        { class: 'panel hero', 'aria-labelledby': 'dash-today' },
        h('div', { class: 'row spread' }, h('h2', { id: 'dash-today', style: { margin: '0' } }, t('dash.today')), plan ? h('span', { class: `chip ${plan.status === 'completed' ? 'status-resolved' : plan.status === 'in_progress' ? 'status-under_review' : ''}` }, planStatus[plan.status]) : null),
        plan
          ? [
              h('p', { class: 'hero-portion' }, scopeLabel(plan.scope, app.quran.index)),
              h('a', { class: 'btn primary big', href: '#/revision', 'data-key': 'dash-start' }, plan.status === 'completed' ? t('dash.reviewAgain') : t('dash.startRevision')),
            ]
          : [h('p', { class: 'muted', style: { margin: '0.5rem 0 0.75rem' } }, t('dash.noPlan')), h('a', { class: 'btn primary big', href: '#/revision', 'data-key': 'dash-start' }, t('dash.setToday'))],
        h('div', { class: 'metrics', style: { 'margin-top': '1rem' } }, metric(d.ayatReviewedToday, t('dash.recalledToday')), metric(d.streakDays, tn('dash.streak', d.streakDays), d.streakDays > 0 ? 'good' : '')),
      ),
      h(
        'section',
        { class: 'panel' },
        h('div', { class: 'row spread' }, h('h2', null, t('dash.due')), d.due.length ? h('button', {
          type: 'button', class: 'primary', 'data-key': 'revise-due',
          onclick: () => {
            const p = app.prefs;
            app.prepare({ mode: 'mistakes', scope: { type: 'all' }, planId: null, label: 'Due mistakes', options: { mistakeIds: d.due.map((m) => m.id), contextBefore: p.contextBefore, contextAfter: p.contextAfter, contextAcrossSurahs: p.contextAcrossSurahs, wordPractice: p.wordPractice }, repeat: p.repeat, portionAyahRepeat: p.portionAyahRepeat, reciterId: p.reciterId }, () => t('dash.dueLabel'));
          },
        }, t('dash.reviseDue')) : null),
        d.due.length ? dueList(app, d.due) : h('p', { class: 'muted' }, t('dash.nothingDue')),
        d.upcoming.length ? h('div', null, h('h3', { style: { 'margin-top': '1rem' } }, t('dash.comingUp')), h('ul', { class: 'activity' }, d.upcoming.slice(0, 5).map((m) => h('li', null, h('span', null, refLabel(m)), h('span', { class: 'when' }, relativeDays(effectiveDueDate(m)?.toISOString() ?? null, app.now())))))) : null,
      ),
    ),
    h(
      'div',
      { class: 'metrics', style: { margin: '1rem 0' } },
      metric(d.ayatWithMistakes, t('dash.ayatWithMistakes')),
      metric(d.unresolved, t('dash.unresolvedMistakes'), d.unresolved ? 'alert' : ''),
      metric(d.resolved, t('common.resolved'), d.resolved ? 'good' : ''),
      metric(d.reappeared, t('dash.reappeared')),
      metric(d.due.length, t('dash.due')),
      metric(d.completedSessions, t('dash.completedSessions')),
    ),
    h(
      'div',
      { class: 'grid two' },
      h(
        'section',
        { class: 'panel' },
        h('h2', null, t('dash.quality')),
        d.overall.score === null
          ? h('p', { class: 'muted' }, t('dash.noScore'))
          : [
              h('div', { class: 'score' }, h('span', { class: 'num' }, fmtNum(d.overall.score)), h('span', { class: 'of' }, t('common.outOf100'))),
              h('p', { class: 'muted' }, t('dash.scoreDetail', { count: d.overall.ayahCount, reviewed: d.overall.reviewedAyahCount, unreviewed: d.overall.unreviewedAyahCount, stale: d.overall.staleAyahCount })),
            ],
        scoreExplanation(),
      ),
      h('section', { class: 'panel' }, h('h2', null, t('dash.recent')), recentActivity(app)),
      h(
        'section',
        { class: 'panel' },
        h('h2', null, t('dash.types')),
        d.totalMistakes === 0
          ? h('p', { class: 'muted' }, t('dash.noMistakes'))
          : h('table', null, h('tbody', null, d.categories.filter((c) => c.total > 0).map((c) => h('tr', null, h('td', null, categoryLabel(c.category)), h('td', { style: { width: '40%' } }, bar(c.total, maxCat, c.unresolved > 0)), h('td', null, fmtNum(c.total), h('small', { class: 'muted' }, t('dash.openCount', { count: c.unresolved }))))))),
      ),
      h('section', { class: 'panel' }, h('h2', null, t('dash.mostPractice')), practiceList(d.mostPractice, t('dash.nothingStandsOut'), (i) => tn('dash.practiceDetail', i.lapses, { open: i.unresolved }))),
      h('section', { class: 'panel' }, h('h2', null, t('dash.notRecent')), practiceList(d.notReviewedRecently, t('dash.allRecent'), (i) => (i.lastReviewedAt ? t('dash.lastReviewed', { when: relativeDays(i.lastReviewedAt, app.now()) }) : t('dash.neverReviewed')))),
    ),
  );
}
