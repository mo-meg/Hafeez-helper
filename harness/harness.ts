/**
 * Browser end-to-end harness. Runs the REAL app UI against the REAL IndexedDB adapter, with a
 * mocked audio backend and SYNTHETIC fixture text (placeholder words, not Quran text).
 * Results are rendered at the top of the page and in document.title ("HARNESS PASS n/n").
 * Build: npm run test:e2e  → open dist-harness/harness.html in a browser.
 */
import '../src/ui/styles.css';
import { AudioCache } from '../src/browser/audioCache.ts';
import { createIdbStore } from '../src/browser/idbStore.ts';
import type { AudioBackend } from '../src/core/audio/playbackController.ts';
import { exportBackup, parseBackup, restoreBackup } from '../src/core/storage/backup.ts';
import { createMemoryStore } from '../src/core/storage/memoryStore.ts';
import { createServices } from '../src/core/services.ts';
import type { Store } from '../src/core/storage/store.ts';
import { randomIds, systemClock } from '../src/core/util/ids.ts';
import { App } from '../src/ui/app.ts';
import { syntheticDivisions, syntheticText } from '../tests/fixtures/synthetic.ts';

declare const SHOWCASE: string | undefined;
const showcase = typeof SHOWCASE === 'string' ? SHOWCASE : '';

/** Mock audio: each "file" plays for 15 ms; URLs containing a failing marker reject. */
class FakeAudio implements AudioBackend {
  readonly loads: string[] = [];
  failing = new Set<string>();
  private ended: () => void = () => {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  async load(url: string) {
    this.loads.push(url);
    if ([...this.failing].some((f) => url.includes(f))) throw new Error('HTTP 404 (simulated missing file)');
  }
  async play() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.ended(), 15);
  }
  pause() {
    if (this.timer) clearTimeout(this.timer);
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
  }
  setRate() {}
  onEnded(cb: () => void) {
    this.ended = cb;
  }
  onError() {}
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | null | undefined | false, what: string, timeout = 4000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - t0 > timeout) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}
function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true, detail: '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
const byText = (sel: string, text: string | RegExp, root: ParentNode = document) =>
  $$<HTMLElement>(sel, root).find((el) => (typeof text === 'string' ? el.textContent?.trim() === text : text.test(el.textContent ?? '')));
const go = async (hash: string) => {
  location.hash = hash;
  await sleep(60);
};
const dialog = () => $<HTMLDialogElement>('dialog[open]');
const setInput = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

async function makeApp(store: Store, audio: FakeAudio, root: HTMLElement): Promise<App> {
  const services = createServices({ store, clock: systemClock, ids: randomIds, fetcher: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  const app = new App({ services, audioBackend: audio, audioCache: new AudioCache(store.audio), isOnline: () => true, fixture: { text: syntheticText(), divisions: syntheticDivisions({ withEighths: true }) }, enableReminders: false });
  await app.start(root);
  return app;
}

async function run() {
  const dbName = `hafeez-harness-${Date.now()}`;
  let store: Store;
  let storeKind = 'IndexedDB';
  try {
    store = await createIdbStore(dbName);
  } catch {
    store = createMemoryStore();
    storeKind = 'memory (IndexedDB unavailable here)';
  }
  const audio = new FakeAudio();
  const root = document.getElementById('app') as HTMLElement;
  let app = await makeApp(store, audio, root);
  await app.savePrefs({ ...app.prefs, repeat: { ...app.prefs.repeat, pauseBetweenAyatMs: 0, pauseBetweenRepetitionsMs: 0 } });

  await step('Opens Hizb 5 with verified boundaries (2:253 to 3:14)', async () => {
    await go('#/quran?hizb=5');
    const panel = await waitFor(() => $('.division-panel'), 'division panel');
    check(panel.querySelector('h2')?.textContent === 'Hizb 5', 'panel title');
    const text = panel.textContent ?? '';
    check(text.includes('Al-Baqarah 2:253'), 'start 2:253 shown');
    check(text.includes("Al 'Imran 3:14"), 'end 3:14 shown');
    check($$('.sub-list li.quarter', panel).length === 4, 'four quarters listed');
    check($$('.sub-list li.eighth', panel).length === 8, 'eight eighths listed');
    check(($$('.sub-list li.quarter', panel)[0]?.textContent ?? '').includes('2:253'), 'first quarter starts at 2:253');
  });

  await step('Quran text is right-to-left', async () => {
    const q = await waitFor(() => $('.quran'), 'text');
    check(q.getAttribute('dir') === 'rtl' && getComputedStyle(q).direction === 'rtl', 'direction rtl');
  });

  await step('Selecting a subdivision navigates to its starting ayah', async () => {
    const btn = $$<HTMLButtonElement>('.division-panel .sub-list li.quarter button')[1];
    check(btn, 'second quarter button');
    btn?.click();
    await sleep(80);
    check(location.hash.startsWith('#/quran?quarter=18'), `navigated (${location.hash})`);
    await go('#/quran?hizb=5');
  });

  await step('Marks a whole ayah (2:260) from the ayah number', async () => {
    const end = await waitFor(() => $<HTMLButtonElement>('button.ayah-end[data-end="267"]'), 'ayah 2:260 end marker');
    end.click();
    const d1 = await waitFor(dialog, 'ayah dialog');
    byText('button', 'Mark whole ayah', d1)?.click();
    const d2 = await waitFor(() => (dialog() && byText('button', 'Mark mistake', dialog() as ParentNode) ? dialog() : null), 'mark dialog');
    ($<HTMLInputElement>('input[value="hesitation"]', d2 as ParentNode) as HTMLInputElement).click();
    byText('button', 'Mark mistake', d2 as ParentNode)?.click();
    await waitFor(() => $('button.ayah-end.has-mistake[data-end="267"]'), 'ayah marked');
  });

  await step('Marks a single word (2:255, word 2) with a category and note', async () => {
    const w = await waitFor(() => $<HTMLButtonElement>('button.w[data-a="262"][data-p="2"]'), 'word button');
    w.click();
    const d = await waitFor(dialog, 'mark dialog');
    ($<HTMLInputElement>('input[value="incorrect_word"]', d) as HTMLInputElement).click();
    ($<HTMLTextAreaElement>('textarea', d) as HTMLTextAreaElement).value = 'Said a different word';
    byText('button', 'Mark mistake', d)?.click();
    await waitFor(() => $('button.w.marked[data-a="262"][data-p="2"]'), 'word highlighted');
  });

  await step('Re-marking the same word does not create a duplicate', async () => {
    $<HTMLButtonElement>('button.w[data-a="262"][data-p="2"]')?.click();
    const d = await waitFor(dialog, 'existing mistake dialog');
    check(d.querySelector('h2')?.textContent === 'Recorded mistake', 'opens existing record');
    byText('button', 'It happened again', d)?.click();
    await sleep(150);
    const all = await store.mistakes.getAll();
    check(all.length === 2, `two records (got ${all.length})`);
    check(all.find((m) => m.globalIndex === 262)?.lapseCount === 1, 'recurrence recorded');
  });

  await step('Marks a mistake outside the assignment (18:28)', async () => {
    await go('#/quran?surah=18');
    const end = await waitFor(() => $<HTMLButtonElement>('button.ayah-end[data-end="2168"]'), '18:28 marker');
    end.click();
    byText('button', 'Mark whole ayah', await waitFor(dialog, 'dialog'))?.click();
    const d = await waitFor(() => (dialog() && byText('button', 'Mark mistake', dialog() as ParentNode) ? dialog() : null), 'mark dialog');
    byText('button', 'Mark mistake', d as ParentNode)?.click();
    await waitFor(() => $('button.ayah-end.has-mistake[data-end="2168"]'), 'marked');
  });

  await step(`Mistakes persist after restarting the app (${storeKind})`, async () => {
    if (store.kind !== 'indexeddb') throw new Error('IndexedDB not available in this browser context; persistence not verifiable here');
    const fresh = await createIdbStore(dbName);
    app = await makeApp(fresh, audio, root);
    store = fresh;
    await go('#/quran?hizb=5');
    await waitFor(() => $('button.w.marked[data-a="262"][data-p="2"]'), 'word still marked after restart');
    check((await fresh.mistakes.getAll()).length === 3, 'three mistakes reloaded');
  });

  await step("Sets today's revision to Hizb 5", async () => {
    await go('#/revision?edit=1');
    setInput(await waitFor(() => $<HTMLSelectElement>('#plan-kind'), 'kind select'), 'hizb');
    setInput($<HTMLInputElement>('#plan-num') as HTMLInputElement, '5');
    byText('button', 'Set today’s revision')?.click();
    await waitFor(() => $('#today-title')?.textContent === 'Today: Hizb 5', 'plan card');
    const unresolved = byText('.metric', /Unresolved/);
    check(unresolved?.querySelector('.value')?.textContent === '2', 'two unresolved mistakes in Hizb 5 (18:28 excluded)');
  });

  await step('Builds the playlist in Quran order and honours the repeat count', async () => {
    $<HTMLButtonElement>('[data-key="start-revision"]')?.click();
    await waitFor(() => location.hash === '#/session' && $('[data-key="start-session"]'), 'session preview');
    setInput(await waitFor(() => $<HTMLInputElement>('input[data-key="cfg-ayah"]'), 'repeat input'), '3');
    await sleep(60);
    const rows = $$('table tbody tr').map((tr) => tr.children[1]?.textContent ?? '');
    check(rows.join('|') === 'Al-Baqarah 2:255|Al-Baqarah 2:260', `order was ${rows.join('|')}`);
    check(byText('.metric', /Plays in total/)?.querySelector('.value')?.textContent === '6', 'six plays in total');
  });

  await step('Plays each ayah 3 times, asks for recall, records outcomes', async () => {
    audio.loads.length = 0;
    $<HTMLButtonElement>('[data-key="start-session"]')?.click();
    await waitFor(() => app.player.state.status === 'awaiting_assessment', 'assessment pause after 2:255', 6000);
    check(byText('.ref-big', 'Al-Baqarah 2:255'), 'current ayah 2:255');
    $<HTMLButtonElement>('[data-key="o-correct_difficult"]')?.click();
    await waitFor(() => app.player.state.status === 'awaiting_assessment' && app.player.state.current?.item.ref.ayah === 260, 'assessment pause after 2:260', 6000);
    $<HTMLButtonElement>('[data-key="o-mistake_again"]')?.click();
    await waitFor(() => app.player.state.status === 'finished', 'playlist finished', 6000);
    const files = audio.loads.map((u) => u.slice(-10, -4));
    check(files.join(',') === '002255,002255,002255,002260,002260,002260', `audio order ${files.join(',')}`);
  });

  await step('Finishing the session completes the plan but resolves nothing', async () => {
    $<HTMLButtonElement>('[data-key="finish"]')?.click();
    await sleep(200);
    const plan = (await store.plans.getAll())[0];
    check(plan?.status === 'completed', 'plan completed');
    const ms = await store.mistakes.getAll();
    check(ms.every((m) => m.status !== 'resolved'), 'no mistake auto-resolved');
    check(ms.find((m) => m.globalIndex === 262)?.status === 'under_review', '2:255 under review');
    check(ms.find((m) => m.globalIndex === 267)?.status === 'needs_practice', '2:260 needs practice');
  });

  await step('Dashboard reflects recorded answers only', async () => {
    await go('#/dashboard');
    await waitFor(() => $('.score .num'), 'score');
    check(byText('.metric', /Unresolved mistakes/)?.querySelector('.value')?.textContent === '3', 'three unresolved');
    check(byText('.metric', /Ayat with mistakes/)?.querySelector('.value')?.textContent === '3', 'three ayat');
  });

  await step('Resolves and reopens a mistake from My mistakes', async () => {
    await go('#/mistakes');
    const m = (await store.mistakes.getAll()).find((x) => x.globalIndex === 267);
    $<HTMLButtonElement>(`[data-key="details-${m?.id}"]`)?.click();
    byText('button', 'Mark resolved', await waitFor(dialog, 'details dialog'))?.click();
    await sleep(150);
    check((await store.mistakes.get(m?.id ?? ''))?.status === 'resolved', 'resolved');
    setInput(await waitFor(() => $<HTMLSelectElement>('[data-key="f-status"]'), 'status filter'), 'all');
    await sleep(60);
    $<HTMLButtonElement>(`[data-key="details-${m?.id}"]`)?.click();
    byText('button', 'Reopen', await waitFor(dialog, 'details dialog'))?.click();
    await sleep(150);
    check((await store.mistakes.get(m?.id ?? ''))?.status === 'reopened', 'reopened');
    check((await store.mistakeEvents.getAll()).some((e) => e.mistakeId === m?.id && e.type === 'resolved'), 'history kept');
  });

  await step('Missing audio stops with an explicit error; skipping is explicit', async () => {
    audio.failing.add('002255');
    await go('#/revision');
    $<HTMLButtonElement>('[data-key="start-revision"]')?.click();
    await waitFor(() => $('[data-key="start-session"]'), 'preview');
    $<HTMLButtonElement>('[data-key="start-session"]')?.click();
    await waitFor(() => app.player.state.status === 'error', 'error state');
    const alert = await waitFor(() => $('.now-playing .notice.error'), 'error notice');
    check(/2:255/.test(alert.textContent ?? '') && /Nothing was skipped/.test(alert.textContent ?? ''), 'clear message');
    $<HTMLButtonElement>('[data-key="skip"]')?.click();
    await waitFor(() => app.player.state.current?.item.ref.ayah === 260, 'moved on after explicit skip');
    check(app.player.state.skippedAyat.includes(262), 'skip recorded');
    audio.failing.clear();
    app.player.stop();
    await app.endSession(false);
  });

  await step('Marking the first word of an ayah pre-selects "Linking ayat"', async () => {
    await go('#/quran?hizb=5');
    (await waitFor(() => $<HTMLButtonElement>('button.w[data-a="263"][data-p="1"]'), '2:256 first word')).click();
    const d = await waitFor(dialog, 'mark dialog');
    check(($<HTMLInputElement>('input[value="ayah_transition"]', d) as HTMLInputElement).checked, 'transition type pre-selected');
    check(/first word of the ayah/.test(d.textContent ?? ''), 'explanation shown');
    byText('button', 'Mark mistake', d)?.click();
    await waitFor(() => !dialog() && $('button.w.marked[data-a="263"][data-p="1"]'), 'word marked');
    check((await store.mistakes.getAll()).length === 4, 'saved as a new record');
    check((await store.mistakes.getAll()).find((m) => m.globalIndex === 263)?.category === 'ayah_transition', 'saved as linking ayat');
  });

  await step('Test: hides from the mistake word to the end of the ayah; hint and reveal', async () => {
    await go('#/test');
    setInput(await waitFor(() => $<HTMLSelectElement>('#test-kind'), 'kind'), 'hizb');
    setInput(await waitFor(() => $<HTMLInputElement>('#test-num'), 'number'), '5');
    await sleep(50);
    check(/3 ayat to test/.test($('main')?.textContent ?? ''), 'three ayat in Hizb 5 (18:28 excluded)');
    $<HTMLButtonElement>('[data-key="test-start"]')?.click();
    const target = await waitFor(() => $('.test-target .quran'), 'first card');
    check(/2:255/.test($('.test-target')?.textContent ?? ''), 'first card is 2:255 (Quran order)');
    const total = $$('.w, .hidden-word', target).length;
    check($$('.w', target).length === 1 && $$('.hidden-word', target).length === total - 1, 'word 1 visible, word 2 (the mistake) to the end hidden');
    check(/2:254/.test($('.test-prompt')?.textContent ?? '') && $$('.test-prompt .hidden-word').length === 0, 'previous ayah 2:254 shown in full');
    $<HTMLButtonElement>('[data-key="test-hint"]')?.click();
    await sleep(30);
    check($$('.test-target .hidden-word').length === total - 2, 'hint uncovers exactly one word');
    $<HTMLButtonElement>('[data-key="test-reveal"]')?.click();
    await sleep(30);
    check($$('.test-target .hidden-word').length === 0, 'reveal shows the rest');
    check(($<HTMLButtonElement>('[data-key="test-o-correct_easy"]') as HTMLButtonElement).disabled, 'after a hint, "correct" is not allowed');
    $<HTMLButtonElement>('[data-key="test-o-needed_prompt"]')?.click();
  });

  await step('Test: a linking-ayat mistake shows the previous ayah and hides the whole next ayah', async () => {
    await waitFor(() => /2:256/.test($('.test-target')?.textContent ?? ''), 'second card 2:256');
    check(/2:255/.test($('.test-prompt')?.textContent ?? ''), 'previous ayah 2:255 shown in full');
    check($$('.test-prompt .hidden-word').length === 0, 'prompt fully visible');
    check($$('.test-target .w').length === 0 && $$('.test-target .hidden-word').length > 0, 'whole ayah hidden');
    $<HTMLButtonElement>('[data-key="test-reveal"]')?.click();
    await sleep(30);
    $<HTMLButtonElement>('[data-key="test-o-correct_easy"]')?.click();
    await waitFor(() => /2:260/.test($('.test-target')?.textContent ?? ''), 'third card: whole-ayah mistake');
    check(/2:259/.test($('.test-prompt')?.textContent ?? ''), 'whole-ayah mark also shows the previous ayah');
    $<HTMLButtonElement>('[data-key="test-end"]')?.click();
    await waitFor(() => /Test finished/.test($('main h1')?.textContent ?? ''), 'summary');
    const reviews = await store.reviews.getAll();
    check(reviews.some((r) => r.globalIndex === 262 && r.outcome === 'needed_prompt' && r.assisted), 'hinted answer recorded as needed a prompt');
    check(reviews.some((r) => r.globalIndex === 263 && r.outcome === 'correct_easy'), 'linking answer recorded');
    check((await store.sessions.getAll()).some((x) => x.mode === 'test' && x.status === 'completed' && x.completedSteps === 2), 'test session saved');
    const after = await store.mistakes.getAll();
    check(after.find((m) => m.globalIndex === 263)?.status === 'resolved', '"correct without difficulty" resolved 2:256');
    check(after.find((m) => m.globalIndex === 262)?.status !== 'resolved', 'hinted answer did not resolve 2:255');
    $<HTMLButtonElement>('[data-key="test-new"]')?.click();
  });

  await step('Test: two mistakes in one ayah, reveal stops before the second one', async () => {
    await app.s.mistakes.markWord({ surah: 2, ayah: 257 }, { position: 2, tokenText: 'كلمة', edition: 'synthetic-fixture' }, { category: 'forgotten' });
    await app.s.mistakes.markWord({ surah: 2, ayah: 257 }, { position: 4, tokenText: 'كلمة', edition: 'synthetic-fixture' }, { category: 'incorrect_word' });
    await app.refresh();
    await go('#/test');
    setInput(await waitFor(() => $<HTMLSelectElement>('#test-kind'), 'kind'), 'hizb');
    setInput(await waitFor(() => $<HTMLInputElement>('#test-num'), 'number'), '5');
    await sleep(50);
    $<HTMLButtonElement>('[data-key="test-start"]')?.click();
    for (let i = 0; i < 5 && !/2:257/.test($('.test-target')?.textContent ?? ''); i++) {
      $<HTMLButtonElement>('[data-key="test-skip"]')?.click();
      await sleep(80);
    }
    check(/2:257/.test($('.test-target')?.textContent ?? ''), 'reached the 2:257 card');
    check(/mistake 1 of 2 in this ayah/.test($('main')?.textContent ?? ''), 'step indicator shown');
    const visible = () => $$('.test-target .w').length;
    check(visible() === 1, 'only word 1 visible before the first mistake');
    $<HTMLButtonElement>('[data-key="test-reveal"]')?.click();
    await sleep(40);
    check(visible() === 3 && $$('.test-target .hidden-word').length > 0, 'reveal shows words 2–3 and keeps word 4 (next mistake) hidden');
    $<HTMLButtonElement>('[data-key="test-o-correct_easy"]')?.click();
    await waitFor(() => /mistake 2 of 2 in this ayah/.test($('main')?.textContent ?? ''), 'second step');
    check(visible() === 3, 'revealed words stay visible');
    check($$('.test-target .w.marked.resolved').length === 1, 'the just-resolved mistake turns green');
    $<HTMLButtonElement>('[data-key="test-reveal"]')?.click();
    await sleep(40);
    check($$('.test-target .hidden-word').length === 0, 'second reveal shows the rest of the ayah');
    $<HTMLButtonElement>('[data-key="test-o-mistake_again"]')?.click();
    await sleep(150);
    const ms = (await store.mistakes.getAll()).filter((m) => m.globalIndex === 264);
    check(ms.find((m) => m.word?.position === 2)?.status === 'resolved', 'first mistake (correct without difficulty) resolved on its own');
    check(ms.find((m) => m.word?.position === 4)?.status === 'needs_practice', 'second mistake got its own answer');
    $<HTMLButtonElement>('[data-key="test-end"]')?.click();
    await waitFor(() => /Test finished/.test($('main h1')?.textContent ?? ''), 'summary');
    $<HTMLButtonElement>('[data-key="test-new"]')?.click();
  });

  await step('Backup export and restore round-trip', async () => {
    const backup = parseBackup(JSON.parse(JSON.stringify(await exportBackup(store, new Date()))));
    const target = createMemoryStore();
    const res = await restoreBackup(target, backup, 'replace');
    check(res.summary.mistakes === 6 && res.summary.reviews >= 6, `restored ${JSON.stringify(res.summary)}`);
  });

  await step('Every button and link has an accessible name on each page', async () => {
    for (const r of ['#/dashboard', '#/quran?hizb=5', '#/revision', '#/mistakes', '#/test', '#/progress', '#/settings']) {
      await go(r);
      const unnamed = $$('main button, main a, .rail a').filter((el) => !(el.textContent?.trim() || el.getAttribute('aria-label')));
      check(unnamed.length === 0, `${r}: ${unnamed.length} unnamed controls`);
    }
  });

  if (showcase === 'live-session') {
    await go('#/revision');
    $<HTMLButtonElement>('[data-key="start-revision"]')?.click();
    await waitFor(() => $('[data-key="start-session"]'), 'preview');
    $<HTMLButtonElement>('[data-key="start-session"]')?.click();
    await waitFor(() => app.player.state.status === 'awaiting_assessment', 'assessment', 6000).catch(() => null);
    window.scrollTo(0, 0);
  } else if (showcase === 'live-test') {
    await go('#/test');
    setInput(await waitFor(() => $<HTMLSelectElement>('#test-kind'), 'kind'), 'hizb');
    setInput(await waitFor(() => $<HTMLInputElement>('#test-num'), 'number'), '5');
    await sleep(50);
    $<HTMLButtonElement>('[data-key="test-start"]')?.click();
    await waitFor(() => $('.test-target'), 'card');
    for (let i = 0; i < 5 && !/2:257/.test($('.test-target')?.textContent ?? ''); i++) {
      $<HTMLButtonElement>('[data-key="test-skip"]')?.click();
      await sleep(80);
    }
    $<HTMLButtonElement>('[data-key="test-reveal"]')?.click();
    await sleep(30);
    window.scrollTo(0, 0);
  } else if (showcase) await go(showcase);
  else await go('#/dashboard');
  report(storeKind);
}

function report(storeKind: string) {
  const passed = results.filter((r) => r.ok).length;
  const el = document.getElementById('harness-report') as HTMLElement;
  document.title = `HARNESS ${passed === results.length ? 'PASS' : 'FAIL'} ${passed}/${results.length}`;
  document.querySelector('.toast-region')?.replaceChildren();
  el.setAttribute('style', `font: 14px/1.5 system-ui; color: #1c2420; padding: 0.75rem 1rem; background: ${passed === results.length ? '#e1efe7' : '#fbe7e4'}; border-bottom: 2px solid ${passed === results.length ? '#2d6a4f' : '#b42318'}`);
  if (showcase) {
    el.textContent = `Browser harness: ${passed}/${results.length} journeys passed (storage: ${storeKind}). Synthetic placeholder text, not Quran text.`;
    return;
  }
  el.replaceChildren(
    Object.assign(document.createElement('strong'), { textContent: `Browser harness: ${passed}/${results.length} passed (storage: ${storeKind}). Text shown is a synthetic placeholder, not Quran text.` }),
    ...results.map((r) => Object.assign(document.createElement('div'), { textContent: `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `: ${r.detail}` : ''}` })),
  );
}

run().catch((e: unknown) => {
  results.push({ name: 'Harness crashed', ok: false, detail: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  report('unknown');
});
