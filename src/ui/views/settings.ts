import { requestPersistentStorage } from '../../browser/idbStore.ts';
import { buildIcs, notificationsSupported, requestNotificationPermission } from '../../browser/reminders.ts';
import { resolveAudioUrl, TemplateError, validateTemplate, type ReciterSource } from '../../core/audio/reciters.ts';
import { removeDemoData, seedDemoData } from '../../core/demo.ts';
import { ANCHOR_SOURCES } from '../../core/quran/anchors.ts';
import { REPEAT_LIMITS } from '../../core/playlist/sequence.ts';
import type { Preferences } from '../../core/settings/preferences.ts';
import { exportBackup, parseBackup, restoreBackup, wipePersonalData } from '../../core/storage/backup.ts';
import type { App } from '../app.ts';
import { confirmDialog } from '../components/dialog.ts';
import { formatDateTime, h } from '../dom.ts';

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readJsonFile(file: File): Promise<unknown> {
  return file.text().then((t) => {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      throw new Error('The selected file is not valid JSON.');
    }
  });
}

function section(id: string, title: string, ...children: Parameters<typeof h>[2][]): HTMLElement {
  return h('section', { class: 'panel', id: `settings-${id}`, 'aria-labelledby': `h-${id}` }, h('h2', { id: `h-${id}` }, title), ...children);
}

function quranDataSection(app: App): HTMLElement {
  const q = app.quran;
  const status = h('p', { role: 'status', class: 'muted' });
  const t = q.text?.dataset;
  const d = q.divisions;
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'Eighths dataset file' });
  return section(
    'data',
    'Quran text and divisions',
    h(
      'dl',
      { class: 'kv' },
      h('dt', null, 'Text'), h('dd', null, t ? `${t.label} (${t.edition})` : 'Not downloaded'),
      t ? [h('dt', null, 'Text source'), h('dd', null, h('a', { href: t.source.url, rel: 'noopener', target: '_blank' }, t.source.name), h('br'), h('small', null, t.source.license))] : null,
      t?.source.retrievedAt ? [h('dt', null, 'Downloaded'), h('dd', null, formatDateTime(t.source.retrievedAt))] : null,
      t?.sha256 ? [h('dt', null, 'SHA-256'), h('dd', null, h('code', { style: { 'word-break': 'break-all', 'font-size': '0.8rem' } }, t.sha256))] : null,
      h('dt', null, 'Divisions'), h('dd', null, d.label),
      h('dt', null, 'Available'), h('dd', null, (['juz', 'hizb', 'quarter', 'eighth', 'page'] as const).map((k) => `${k} ${q.index.has(k) ? q.index.count(k) : 'no'}`).join(', ')),
      h('dt', null, 'Verification'), h('dd', null, q.validation.ok ? 'Passed: counts, order, and all verified juz and hizb anchors match.' : q.validation.errors.join(' ')),
      d.eighthsSource ? [h('dt', null, 'Eighths source'), h('dd', null, `${d.eighthsSource.name} (${d.eighthsSource.license})`)] : null,
    ),
    h('p', { class: 'muted' }, 'Text and division metadata are downloaded once from AlQuran.cloud (Tanzil Uthmani text, CC BY 3.0) and then work offline. The app never edits or re-spells the text. Downloaded data is rejected if it disagrees with the verified anchors: ', ANCHOR_SOURCES.map((s, i) => [i ? ', ' : '', h('a', { href: s.url, rel: 'noopener', target: '_blank' }, s.label)]), '.'),
    h(
      'div',
      { class: 'row' },
      h('button', {
        type: 'button', class: t ? '' : 'primary', 'data-key': 'download-data',
        onclick: async (e: Event) => {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.disabled = true;
          const ok = await app.act(async () => {
            app.quran = await app.s.quran.downloadFromAlQuranCloud((m) => { status.textContent = m; });
          }, 'Quran data downloaded and verified.');
          btn.disabled = false;
          if (!ok) status.textContent = 'Download failed. Check your connection and try again. Nothing was changed.';
          else app.render(true);
        },
      }, t ? 'Download again' : 'Download Quran data (about 2.5 MB)'),
      t || d.quarterStarts ? h('button', { type: 'button', class: 'quiet', onclick: async () => { if (await confirmDialog('Remove downloaded Quran data?', 'Your mistakes are kept. The reader will show references only until you download again.', 'Remove')) { app.quran = await app.s.quran.clearCache(); app.render(true); } } }, 'Remove downloaded data') : null,
    ),
    status,
    h('h3', { style: { 'margin-top': '1rem' } }, 'Eighths (thumn)'),
    h('p', { class: 'muted' }, 'The Madani mushaf metadata has quarters but no eighths. If your mushaf marks eighths, import a verified list (480 starting ayat, same ayah numbering). It is checked against the quarters before use. Format: see docs/DATA_SOURCES.md.'),
    h(
      'div',
      { class: 'row' },
      fileInput,
      h('button', {
        type: 'button', disabled: !d.quarterStarts,
        onclick: async () => {
          const f = fileInput.files?.[0];
          if (!f) { app.toast('Choose a JSON file first.', 'error'); return; }
          if (await app.act(async () => { app.quran = await app.s.quran.importEighths(await readJsonFile(f)); }, 'Eighths imported and verified.')) app.render(true);
        },
      }, 'Import eighths'),
      q.index.has('eighth') ? h('button', { type: 'button', class: 'quiet', onclick: async () => { app.quran = await app.s.quran.removeEighths(); app.render(true); } }, 'Remove eighths') : null,
    ),
  );
}

function testReciter(r: ReciterSource, out: HTMLElement) {
  out.textContent = 'Testing…';
  const audio = new Audio();
  const timer = setTimeout(() => { out.textContent = 'No response within 15 seconds.'; audio.src = ''; }, 15_000);
  audio.addEventListener('canplay', () => { clearTimeout(timer); out.textContent = 'Works: Al-Fatihah 1:1 loaded.'; }, { once: true });
  audio.addEventListener('error', () => { clearTimeout(timer); out.textContent = 'Failed: the file could not be loaded (offline, blocked, or wrong address).'; }, { once: true });
  audio.preload = 'auto';
  audio.src = resolveAudioUrl(r.urlTemplate, { surah: 1, ayah: 1 });
}

function audioSection(app: App): HTMLElement {
  const name = h('input', { placeholder: 'Reciter name' });
  const template = h('input', { placeholder: 'https://example.org/audio/{surah3}{ayah3}.mp3', style: { width: '100%' } });
  const usage = h('span', { class: 'muted' }, 'Calculating…');
  void app.deps.audioCache.totalBytes().then((u) => { usage.textContent = `${u.files} audio files saved for offline use (${(u.bytes / 1_048_576).toFixed(1)} MB).`; });
  return section(
    'audio',
    'Reciter and audio source',
    h('p', { class: 'muted' }, 'Audio is streamed per ayah and never bundled with the app. Sources marked “unverified” follow the usual address pattern but were not confirmed during development; use Test.'),
    h(
      'div',
      { role: 'radiogroup', 'aria-label': 'Reciter' },
      app.reciters().map((r) => {
        const out = h('small', { class: 'muted' });
        return h(
          'div',
          { class: 'choice', style: { 'align-items': 'center', 'flex-wrap': 'wrap' } },
          h('input', { type: 'radio', name: 'reciter', id: `rc-${r.id}`, checked: r.id === app.prefs.reciterId, onchange: () => void app.act(() => app.savePrefs({ ...app.prefs, reciterId: r.id }), `Reciter: ${r.name}.`) }),
          h('label', { for: `rc-${r.id}`, style: { flex: '1', 'min-width': '14rem' } }, h('strong', null, r.name), h('span', { class: 'muted', lang: 'ar' }, ` ${r.nameArabic}`), h('br'), h('small', { class: 'muted' }, `${r.host === 'everyayah' ? 'EveryAyah.com' : r.host === 'islamic-network' ? 'Islamic Network CDN' : 'Custom source'}, ${r.verification === 'documented' ? 'address documented' : r.verification === 'user' ? 'added by you' : 'unverified'}`)),
          h('button', { type: 'button', onclick: () => testReciter(r, out) }, 'Test'),
          r.host === 'custom' ? h('button', { type: 'button', class: 'quiet danger', onclick: () => void app.act(() => app.savePrefs({ ...app.prefs, customReciters: app.prefs.customReciters.filter((c) => c.id !== r.id), reciterId: app.prefs.reciterId === r.id ? 'husary-murattal-everyayah' : app.prefs.reciterId })).then(() => app.render(true)) }, 'Remove') : null,
          out,
        );
      }),
    ),
    h('p', null, h('small', { class: 'muted' }, app.reciter().attribution)),
    h('h3', { style: { 'margin-top': '1rem' } }, 'Add an audio source'),
    h('p', { class: 'muted' }, 'Use a per-ayah address with {surah3}{ayah3} (zero-padded, e.g. 002255), {surah} and {ayah}, or {global} (1 to 6236). Only add sources you are allowed to use.'),
    h('div', { class: 'fields' }, h('label', { class: 'field' }, h('span', null, 'Name'), name), h('label', { class: 'field', style: { 'grid-column': '1 / -1' } }, h('span', null, 'Address template'), template)),
    h('button', {
      type: 'button', style: { 'margin-top': '0.5rem' },
      onclick: () => void app.act(async () => {
        if (!name.value.trim()) throw new Error('Enter a name for the reciter.');
        try {
          validateTemplate(template.value.trim());
        } catch (e) {
          throw new Error(e instanceof TemplateError ? e.message : 'Invalid template.');
        }
        const id = `custom-${name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'source'}-${Date.now().toString(36)}`;
        const r = { id, name: name.value.trim(), nameArabic: '', style: 'murattal' as const, host: 'custom' as const, urlTemplate: template.value.trim(), verification: 'user' as const, attribution: 'Custom audio source added by you.' };
        await app.savePrefs({ ...app.prefs, customReciters: [...app.prefs.customReciters, r], reciterId: id });
        app.render(true);
      }, 'Audio source added and selected.'),
    }, 'Add source'),
    h('h3', { style: { 'margin-top': '1rem' } }, 'Offline audio'),
    h('div', { class: 'row' }, usage, h('button', { type: 'button', class: 'quiet', onclick: async () => { await app.deps.audioCache.clear(); app.render(true); } }, 'Delete offline audio')),
  );
}

function playbackSection(app: App): HTMLElement {
  const p = app.prefs;
  const save = (next: Preferences) => void app.act(() => app.savePrefs(next), 'Playback defaults saved.');
  const num = (label: string, value: number, min: number, max: number, step: number, apply: (v: number) => Preferences) => {
    const i = h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step), onchange: () => { const v = Number(i.value); if (v >= min && v <= max) save(apply(v)); else i.value = String(value); } });
    return h('label', { class: 'field' }, h('span', null, label), i);
  };
  const check = (label: string, checked: boolean, apply: (v: boolean) => Preferences) => h('label', { class: 'choice' }, h('input', { type: 'checkbox', checked, onchange: (e: Event) => save(apply((e.target as HTMLInputElement).checked)) }), h('span', null, label));
  const r = p.repeat;
  return section(
    'playback',
    'Playback defaults',
    h('p', { class: 'muted' }, 'Counts are total plays: 5 means you hear the ayah five times.'),
    h(
      'div',
      { class: 'fields' },
      num('Plays of each marked ayah', r.ayahRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => ({ ...p, repeat: { ...r, ayahRepeat: v } })),
      num('Passes over each group', r.groupRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => ({ ...p, repeat: { ...r, groupRepeat: v } })),
      num('Passes over the playlist', r.playlistRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => ({ ...p, repeat: { ...r, playlistRepeat: v } })),
      num('Plays per ayah in full revision', p.portionAyahRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => ({ ...p, portionAyahRepeat: v })),
      num('Pause between repetitions (s)', r.pauseBetweenRepetitionsMs / 1000, 0, 60, 0.5, (v) => ({ ...p, repeat: { ...r, pauseBetweenRepetitionsMs: v * 1000 } })),
      num('Pause between ayat (s)', r.pauseBetweenAyatMs / 1000, 0, 60, 0.5, (v) => ({ ...p, repeat: { ...r, pauseBetweenAyatMs: v * 1000 } })),
      num('Speed', r.playbackRate, REPEAT_LIMITS.minRate, REPEAT_LIMITS.maxRate, 0.05, (v) => ({ ...p, repeat: { ...r, playbackRate: v } })),
      num('Ayat before each mistake', p.contextBefore, 0, 5, 1, (v) => ({ ...p, contextBefore: v })),
      num('Ayat after each mistake', p.contextAfter, 0, 5, 1, (v) => ({ ...p, contextAfter: v })),
    ),
    check('Repeat neighbouring ayat as often as the marked ayah', r.repeatContext, (v) => ({ ...p, repeat: { ...r, repeatContext: v } })),
    check('Allow neighbouring ayat from another surah', p.contextAcrossSurahs, (v) => ({ ...p, contextAcrossSurahs: v })),
    check('Word practice: one play-through per marked word', p.wordPractice === 'per_word', (v) => ({ ...p, wordPractice: v ? 'per_word' : 'grouped' })),
    check('Pause after each marked ayah to record how I recalled it', p.pauseForAssessment, (v) => ({ ...p, pauseForAssessment: v })),
  );
}

function appearanceSection(app: App): HTMLElement {
  const p = app.prefs;
  const sample = app.quran.text?.ayah({ surah: 1, ayah: 2 }).text ?? 'معاينة حجم الخط';
  const preview = h('p', { class: 'quran', lang: 'ar', dir: 'rtl', style: { 'text-align': 'center', 'max-width': 'none' } }, sample);
  return section(
    'appearance',
    'Appearance',
    h('div', { class: 'row', role: 'radiogroup', 'aria-label': 'Theme' }, (['system', 'light', 'dark'] as const).map((t) => h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'theme', checked: p.theme === t, onchange: () => void app.savePrefs({ ...p, theme: t }) }), h('span', null, { system: 'Match device', light: 'Light', dark: 'Dark' }[t])))),
    h('label', { class: 'field', style: { 'margin-top': '0.75rem' } }, h('span', null, `Arabic text size (${Math.round(p.fontScale * 100)}%)`), h('input', { type: 'range', min: '0.8', max: '2.5', step: '0.1', value: String(p.fontScale), 'data-key': 'font-scale', oninput: (e: Event) => document.documentElement.style.setProperty('--quran-scale', (e.target as HTMLInputElement).value), onchange: (e: Event) => void app.savePrefs({ ...p, fontScale: Number((e.target as HTMLInputElement).value) }).then(() => app.render(true)) })),
    preview,
    h('p', { class: 'muted' }, 'For the best Uthmani rendering install the free “KFGQPC HAFS Uthmanic Script” or “Amiri Quran” font on your device; the app uses it automatically.'),
  );
}

function remindersSection(app: App): HTMLElement {
  const p = app.prefs;
  const supported = notificationsSupported();
  const perm = supported ? Notification.permission : 'unsupported';
  const time = h('input', { type: 'time', value: p.reminder.time, onchange: () => void app.act(() => app.savePrefs({ ...p, reminder: { ...p.reminder, time: time.value || '07:00' } }), 'Reminder time saved.') });
  return section(
    'reminders',
    'Daily reminder',
    h('p', { class: 'muted' }, 'Reminders are local; there is no server. While the app is open (or installed and running), it shows a notification once a day after your chosen time if today’s revision is not done. Browsers cannot reliably notify a closed web app, so for a reminder that always arrives, add the calendar event below to your calendar.'),
    h('label', { class: 'choice' }, h('input', { type: 'checkbox', checked: p.reminder.enabled, onchange: async (e: Event) => { const on = (e.target as HTMLInputElement).checked; if (on && supported && Notification.permission === 'default') await requestNotificationPermission(); await app.savePrefs({ ...p, reminder: { ...p.reminder, enabled: on } }); app.render(true); } }), h('span', null, 'Remind me while the app is open')),
    h('label', { class: 'field', style: { 'max-width': '12rem' } }, h('span', null, 'Time'), time),
    h('p', null, h('small', { class: 'muted' }, `Notification permission: ${perm === 'unsupported' ? 'not supported in this browser' : perm}.`), perm === 'default' ? h('button', { type: 'button', class: 'quiet', onclick: async () => { await requestNotificationPermission(); app.render(true); } }, 'Allow notifications') : null),
    h('button', { type: 'button', onclick: () => download('hafeez-helfer-daily-revision.ics', buildIcs(p.reminder.time, 'Quran revision (Hafeez Helfer)', app.now(), location.href.split('#')[0] ?? ''), 'text/calendar') }, 'Download calendar reminder (.ics)'),
  );
}

function privacySection(app: App): HTMLElement {
  const file = h('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'Backup file' });
  let mode: 'replace' | 'merge' = 'merge';
  const hasDemo = app.data.mistakes.some((m) => m.demo);
  return section(
    'privacy',
    'Privacy, backup and data',
    h('p', null, 'Your mistakes, notes, answers and plans are stored only in this browser on this device', app.s.store.kind === 'memory' ? h('strong', null, ' (currently in temporary memory only, because local storage is unavailable; export a backup before closing)') : '', '. There is no account, no analytics and no tracking. Nothing personal is sent anywhere.'),
    h('p', { class: 'muted' }, 'Internet is needed only to download the Quran data once, to stream recitation audio (unless saved for offline use), and to test audio sources. Those requests go to AlQuran.cloud and the audio host you choose; they contain ayah numbers, never your notes.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary', onclick: async () => { const b = await exportBackup(app.s.store, app.now()); download(`hafeez-helfer-backup-${app.today()}.json`, JSON.stringify(b, null, 2), 'application/json'); app.toast('Backup exported.'); } }, 'Export backup'),
      h('button', { type: 'button', class: 'quiet', onclick: async () => { const r = await requestPersistentStorage(); app.toast(r === null ? 'This browser does not support persistent storage requests.' : r ? 'The browser will keep your data even when space is low.' : 'The browser declined; export backups regularly.'); } }, 'Ask the browser to keep data'),
    ),
    h('h3', { style: { 'margin-top': '1rem' } }, 'Restore a backup'),
    h('div', { class: 'row' },
      file,
      h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'restore', checked: true, onchange: () => { mode = 'merge'; } }), h('span', null, 'Merge with current data')),
      h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'restore', onchange: () => { mode = 'replace'; } }), h('span', null, 'Replace current data')),
      h('button', {
        type: 'button',
        onclick: async () => {
          const f = file.files?.[0];
          if (!f) { app.toast('Choose a backup file first.', 'error'); return; }
          await app.act(async () => {
            const backup = parseBackup(await readJsonFile(f));
            if (mode === 'replace' && !(await confirmDialog('Replace all data?', 'Your current mistakes, answers and plans on this device will be replaced by the backup.', 'Replace', true))) return;
            const res = await restoreBackup(app.s.store, backup, mode);
            if (res.preferences) await app.savePrefs(res.preferences);
            await app.refresh();
            app.toast(`Restored ${res.summary.mistakes} mistakes and ${res.summary.reviews} answers.`);
          });
        },
      }, 'Restore'),
    ),
    h('h3', { style: { 'margin-top': '1rem' } }, 'Demo data'),
    h('p', { class: 'muted' }, 'Example mistakes and answers on a few ayat, labelled “Demo”, so you can see how the app works. They never mix silently with your own records.'),
    h('div', { class: 'row' },
      hasDemo
        ? h('button', { type: 'button', onclick: () => void app.act(async () => { await removeDemoData(app.s.store); await app.refresh(); }, 'Demo data removed.') }, 'Remove demo data')
        : h('button', { type: 'button', 'data-key': 'load-demo', onclick: () => void app.act(async () => { await seedDemoData(app.s.store, app.s.clock, app.s.ids); await app.refresh(); }, 'Demo data loaded.') }, 'Load demo data'),
      h('button', { type: 'button', class: 'danger', onclick: async () => { if (await confirmDialog('Delete all personal data?', 'This permanently deletes every mistake, note, answer, plan, session and setting on this device. Export a backup first if you may need it.', 'Delete everything', true)) await app.act(async () => { await wipePersonalData(app.s.store); app.prefs = await app.s.preferences.load(); app.applyAppearance(); await app.refresh(); }, 'All personal data deleted.'); } }, 'Delete all personal data'),
    ),
  );
}

export function settingsView(app: App): Node {
  const focus = app.route.params.get('section');
  if (focus) queueMicrotask(() => document.getElementById(`settings-${focus}`)?.scrollIntoView({ block: 'start' }));
  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Settings'))),
    h('div', { class: 'stack' },
      quranDataSection(app),
      audioSection(app),
      playbackSection(app),
      appearanceSection(app),
      remindersSection(app),
      privacySection(app),
      section('about', 'About', h('p', null, 'Hafeez Helfer is free, open-source software (MIT licence). Quran text: Tanzil.net (CC BY 3.0), delivered by AlQuran.cloud. Recitations belong to their reciters and publishers and are streamed from the selected host.'), h('p', { class: 'muted' }, 'Version 0.1.0. Documentation, data provenance and licences are in the project’s docs folder.')),
    ),
  );
}
