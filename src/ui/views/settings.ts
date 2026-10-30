import { requestPersistentStorage } from '../../browser/idbStore.ts';
import { buildIcs, notificationsSupported, requestNotificationPermission } from '../../browser/reminders.ts';
import { resolveAudioUrl, TemplateError, validateTemplate, type ReciterSource } from '../../core/audio/reciters.ts';
import { removeDemoData, seedDemoData } from '../../core/demo.ts';
import { ANCHOR_SOURCES } from '../../core/quran/anchors.ts';
import { QURAN_TEXT_EDITIONS } from '../../core/data/alquranCloud.ts';
import { REPEAT_LIMITS } from '../../core/playlist/sequence.ts';
import type { Preferences } from '../../core/settings/preferences.ts';
import { exportBackup, parseBackup, restoreBackup, wipePersonalData } from '../../core/storage/backup.ts';
import type { App } from '../app.ts';
import { confirmDialog } from '../components/dialog.ts';
import { formatDateTime, h } from '../dom.ts';
import { fmtNum, t, t as tr } from '../i18n/index.ts';
import { kindName, LocalizedError, reciterAttribution, reciterName } from '../i18n/labels.ts';
import { authErrorText } from '../auth/authView.ts';

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readJsonFile(file: File): Promise<unknown> {
  return file.text().then((text) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LocalizedError(t('error.invalidJson'));
    }
  });
}

function section(id: string, title: string, ...children: Parameters<typeof h>[2][]): HTMLElement {
  return h('section', { class: 'panel', id: `settings-${id}`, 'aria-labelledby': `h-${id}` }, h('h2', { id: `h-${id}` }, title), ...children);
}

/** Localizes the data service's progress messages (core reports them in English). */
function progressText(m: string): string {
  if (m.startsWith('Downloading Quran text')) return tr('set.progDownload');
  if (m.startsWith('Main server unreachable')) return tr('set.progMirror');
  if (m.startsWith('Verifying text structure')) return tr('set.progVerify');
  if (m.startsWith('Note: the /meta cross-check')) return tr('set.progMetaNote');
  if (m.startsWith('Quran data verified')) return tr('set.progDone');
  return m;
}

function quranDataSection(app: App): HTMLElement {
  const q = app.quran;
  const status = h('p', { role: 'status', class: 'muted' });
  const t = q.text?.dataset;
  const d = q.divisions;
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', 'aria-label': tr('set.eighthsFile') });
  const textEdition = h('select', { 'aria-label': tr('set.textStyle'), 'data-key': 'quran-text-style' },
    h('option', { value: QURAN_TEXT_EDITIONS.simple, selected: (t?.edition ?? QURAN_TEXT_EDITIONS.simple) === QURAN_TEXT_EDITIONS.simple }, tr('set.textSimple')),
    h('option', { value: QURAN_TEXT_EDITIONS.uthmani, selected: t?.edition === QURAN_TEXT_EDITIONS.uthmani }, tr('set.textUthmani')),
  );
  return section(
    'data',
    tr('set.data'),
    h(
      'dl',
      { class: 'kv' },
      h('dt', null, tr('set.dText')), h('dd', null, t ? h('span', { dir: 'auto' }, `${t.label} (${t.edition})`) : tr('set.dNotDownloaded')),
      t ? [h('dt', null, tr('set.dSource')), h('dd', null, h('a', { href: t.source.url, rel: 'noopener', target: '_blank' }, t.source.name), h('br'), h('small', null, t.source.license))] : null,
      t?.source.retrievedAt ? [h('dt', null, tr('set.dDownloaded')), h('dd', null, formatDateTime(t.source.retrievedAt))] : null,
      t?.sha256 ? [h('dt', null, 'SHA-256'), h('dd', null, h('code', { dir: 'ltr', style: { 'word-break': 'break-all', 'font-size': '0.8rem' } }, t.sha256))] : null,
      h('dt', null, tr('set.dDivisions')), h('dd', { dir: 'auto' }, d.label),
      h('dt', null, tr('set.dAvailable')), h('dd', null, (['juz', 'hizb', 'quarter', 'eighth', 'page'] as const).map((k) => `${kindName(k)} ${q.index.has(k) ? fmtNum(q.index.count(k)) : tr('set.dAvailNo')}`).join(tr('common.listSep'))),
      h('dt', null, tr('set.dVerification')), h('dd', null, q.validation.ok ? tr('set.dPassed') : h('span', { dir: 'auto' }, q.validation.errors.join(' '))),
      d.eighthsSource ? [h('dt', null, tr('set.dEighths')), h('dd', { dir: 'auto' }, `${d.eighthsSource.name} (${d.eighthsSource.license})`)] : null,
    ),
    h('p', { class: 'muted' }, tr('set.dataHelp'), ANCHOR_SOURCES.map((s, i) => [i ? tr('common.listSep') : '', h('a', { href: s.url, rel: 'noopener', target: '_blank' }, s.label)]), '.'),
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'choice' }, h('span', null, tr('set.textStyle')), textEdition),
      h('button', {
        type: 'button', class: t ? '' : 'primary', 'data-key': 'download-data',
        onclick: async (e: Event) => {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.disabled = true;
          textEdition.disabled = true;
          const edition = textEdition.value as (typeof QURAN_TEXT_EDITIONS)[keyof typeof QURAN_TEXT_EDITIONS];
          const ok = await app.act(async () => {
            app.quran = await app.s.quran.setEdition(edition, (m) => { status.textContent = progressText(m); });
          }, tr('set.downloaded'));
          btn.disabled = false;
          textEdition.disabled = false;
          if (!ok) status.textContent = tr('set.downloadFailed');
          else app.render(true);
        },
      }, t ? tr('set.changeTextStyle') : tr('set.download')),
      t || d.quarterStarts ? h('button', { type: 'button', class: 'quiet', onclick: async () => { if (await confirmDialog(tr('set.removeDataTitle'), tr('set.removeDataBody'), tr('common.remove'))) { app.quran = await app.s.quran.clearCache(); app.render(true); } } }, tr('set.removeData')) : null,
    ),
    status,
    h('h3', { style: { 'margin-top': '1rem' } }, tr('set.eighths')),
    h('p', { class: 'muted' }, tr('set.eighthsHelp')),
    h(
      'div',
      { class: 'row' },
      fileInput,
      h('button', {
        type: 'button', disabled: !d.quarterStarts,
        onclick: async () => {
          const f = fileInput.files?.[0];
          if (!f) { app.toast(tr('error.chooseFile'), 'error'); return; }
          if (await app.act(async () => { app.quran = await app.s.quran.importEighths(await readJsonFile(f)); }, tr('set.eighthsImported'))) app.render(true);
        },
      }, tr('set.importEighths')),
      q.index.has('eighth') ? h('button', { type: 'button', class: 'quiet', onclick: async () => { app.quran = await app.s.quran.removeEighths(); app.render(true); } }, tr('set.removeEighths')) : null,
    ),
  );
}

function testReciter(r: ReciterSource, out: HTMLElement) {
  out.textContent = t('set.testing');
  const audio = new Audio();
  const timer = setTimeout(() => { out.textContent = t('set.testTimeout'); audio.src = ''; }, 15_000);
  audio.addEventListener('canplay', () => { clearTimeout(timer); out.textContent = t('set.testOk'); }, { once: true });
  audio.addEventListener('error', () => { clearTimeout(timer); out.textContent = t('set.testFail'); }, { once: true });
  audio.preload = 'auto';
  audio.src = resolveAudioUrl(r.urlTemplate, { surah: 1, ayah: 1 });
}

function audioSection(app: App): HTMLElement {
  const name = h('input', { placeholder: t('set.reciterName'), dir: 'auto' });
  const template = h('input', { class: 'ltr', dir: 'ltr', placeholder: 'https://example.org/audio/{surah3}{ayah3}.mp3', style: { width: '100%' } });
  const usage = h('span', { class: 'muted' }, t('set.calculating'));
  void app.deps.audioCache.totalBytes().then((u) => { usage.textContent = t('set.usage', { files: u.files, mb: fmtNum(u.bytes / 1_048_576, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) }); });
  return section(
    'audio',
    t('set.audio'),
    h('p', { class: 'muted' }, t('set.audioHelp')),
    h(
      'div',
      { role: 'radiogroup', 'aria-label': t('ses.reciter') },
      app.reciters().map((r) => {
        const out = h('small', { class: 'muted' });
        return h(
          'div',
          { class: 'choice', style: { 'align-items': 'center', 'flex-wrap': 'wrap' } },
          h('input', { type: 'radio', name: 'reciter', id: `rc-${r.id}`, checked: r.id === app.prefs.reciterId, onchange: () => void app.act(() => app.savePrefs({ ...app.prefs, reciterId: r.id }), t('set.reciterToast', { name: reciterName(r) })) }),
          h('label', { for: `rc-${r.id}`, style: { flex: '1', 'min-width': '14rem' } }, h('strong', null, reciterName(r)), r.nameArabic && r.name !== reciterName(r) ? h('span', { class: 'muted', lang: 'en', dir: 'ltr' }, ` ${r.name}`) : r.nameArabic ? h('span', { class: 'muted', lang: 'ar', dir: 'rtl' }, ` ${r.nameArabic}`) : null, h('br'), h('small', { class: 'muted' }, `${r.host === 'everyayah' ? t('set.hostEveryayah') : r.host === 'islamic-network' ? t('set.hostIslamicNetwork') : t('set.hostCustom')}${t('common.listSep')}${r.verification === 'documented' ? t('set.verDocumented') : r.verification === 'user' ? t('set.verUser') : t('set.verUnverified')}`)),
          h('button', { type: 'button', 'aria-label': `${t('common.test')}: ${reciterName(r)}`, onclick: () => testReciter(r, out) }, t('common.test')),
          r.host === 'custom' ? h('button', { type: 'button', class: 'quiet danger', onclick: () => void app.act(() => app.savePrefs({ ...app.prefs, customReciters: app.prefs.customReciters.filter((c) => c.id !== r.id), reciterId: app.prefs.reciterId === r.id ? 'husary-murattal-everyayah' : app.prefs.reciterId })).then(() => app.render(true)) }, t('common.remove')) : null,
          out,
        );
      }),
    ),
    h('p', null, h('small', { class: 'muted' }, reciterAttribution(app.reciter()))),
    h('h3', { style: { 'margin-top': '1rem' } }, t('set.addSource')),
    h('p', { class: 'muted' }, t('set.addSourceHelp')),
    h('div', { class: 'fields' }, h('label', { class: 'field' }, h('span', null, t('set.name')), name), h('label', { class: 'field', style: { 'grid-column': '1 / -1' } }, h('span', null, t('set.template')), template)),
    h('button', {
      type: 'button', style: { 'margin-top': '0.5rem' },
      onclick: () => void app.act(async () => {
        if (!name.value.trim()) throw new LocalizedError(t('error.reciterName'));
        try {
          validateTemplate(template.value.trim());
        } catch (e) {
          throw e instanceof TemplateError ? e : new TemplateError('Invalid template.');
        }
        const id = `custom-${name.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'source'}-${Date.now().toString(36)}`;
        const r = { id, name: name.value.trim(), nameArabic: '', style: 'murattal' as const, host: 'custom' as const, urlTemplate: template.value.trim(), verification: 'user' as const, attribution: 'Custom audio source added by you.' };
        await app.savePrefs({ ...app.prefs, customReciters: [...app.prefs.customReciters, r], reciterId: id });
        app.render(true);
      }, t('set.sourceAdded')),
    }, t('set.addSourceBtn')),
    h('h3', { style: { 'margin-top': '1rem' } }, t('set.offlineAudio')),
    h('div', { class: 'row' }, usage, h('button', { type: 'button', class: 'quiet', onclick: async () => { await app.deps.audioCache.clear(); app.render(true); } }, t('set.deleteOffline'))),
  );
}

function playbackSection(app: App): HTMLElement {
  const p = app.prefs;
  const save = (next: Preferences) => void app.act(() => app.savePrefs(next), t('set.playbackSaved'));
  const num = (label: string, value: number, min: number, max: number, step: number, apply: (v: number) => Preferences) => {
    const i = h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step), onchange: () => { const v = Number(i.value); if (v >= min && v <= max) save(apply(v)); else i.value = String(value); } });
    return h('label', { class: 'field' }, h('span', null, label), i);
  };
  const check = (label: string, checked: boolean, apply: (v: boolean) => Preferences) => h('label', { class: 'choice' }, h('input', { type: 'checkbox', checked, onchange: (e: Event) => save(apply((e.target as HTMLInputElement).checked)) }), h('span', null, label));
  const r = p.repeat;
  return section(
    'playback',
    t('set.playback'),
    h('p', { class: 'muted' }, t('set.playbackHelp')),
    h(
      'div',
      { class: 'fields' },
      num(t('ses.playsMarked'), r.ayahRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => ({ ...p, repeat: { ...r, ayahRepeat: v } })),
      num(t('ses.passesGroup'), r.groupRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => ({ ...p, repeat: { ...r, groupRepeat: v } })),
      num(t('ses.passesList'), r.playlistRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => ({ ...p, repeat: { ...r, playlistRepeat: v } })),
      num(t('set.playsFull'), p.portionAyahRepeat, 1, REPEAT_LIMITS.maxRepeat, 1, (v) => ({ ...p, portionAyahRepeat: v })),
      num(t('ses.pauseRep'), r.pauseBetweenRepetitionsMs / 1000, 0, 60, 0.5, (v) => ({ ...p, repeat: { ...r, pauseBetweenRepetitionsMs: v * 1000 } })),
      num(t('ses.pauseAyat'), r.pauseBetweenAyatMs / 1000, 0, 60, 0.5, (v) => ({ ...p, repeat: { ...r, pauseBetweenAyatMs: v * 1000 } })),
      num(t('ses.speed'), r.playbackRate, REPEAT_LIMITS.minRate, REPEAT_LIMITS.maxRate, 0.05, (v) => ({ ...p, repeat: { ...r, playbackRate: v } })),
      num(t('ses.before'), p.contextBefore, 0, 5, 1, (v) => ({ ...p, contextBefore: v })),
      num(t('ses.after'), p.contextAfter, 0, 5, 1, (v) => ({ ...p, contextAfter: v })),
    ),
    check(t('set.repeatContext'), r.repeatContext, (v) => ({ ...p, repeat: { ...r, repeatContext: v } })),
    check(t('set.across'), p.contextAcrossSurahs, (v) => ({ ...p, contextAcrossSurahs: v })),
    check(t('set.wordPractice'), p.wordPractice === 'per_word', (v) => ({ ...p, wordPractice: v ? 'per_word' : 'grouped' })),
    check(t('set.assess'), p.pauseForAssessment, (v) => ({ ...p, pauseForAssessment: v })),
  );
}

function appearanceSection(app: App): HTMLElement {
  const p = app.prefs;
  // Preview uses the verified dataset verbatim (Al-Fatihah 1:2); without data, an interface label.
  const sample = app.quran.text?.ayah({ surah: 1, ayah: 2 }).text ?? t('set.fontPreview');
  const preview = h('p', { class: 'quran', lang: 'ar', dir: 'rtl', style: { 'text-align': 'center', 'max-width': 'none' } }, sample);
  return section(
    'appearance',
    t('set.appearance'),
    h('div', { class: 'row', role: 'radiogroup', 'aria-label': t('set.theme') }, (['system', 'light', 'dark'] as const).map((th) => h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'theme', checked: p.theme === th, onchange: () => void app.savePrefs({ ...p, theme: th }) }), h('span', null, { system: t('set.themeSystem'), light: t('set.themeLight'), dark: t('set.themeDark') }[th])))),
    h('label', { class: 'field', style: { 'margin-top': '0.75rem' } }, h('span', null, t('set.fontSize', { pct: fmtNum(p.fontScale, { style: 'percent' }) })), h('input', { type: 'range', min: '0.8', max: '2.5', step: '0.1', value: String(p.fontScale), 'data-key': 'font-scale', oninput: (e: Event) => document.documentElement.style.setProperty('--quran-scale', (e.target as HTMLInputElement).value), onchange: (e: Event) => void app.savePrefs({ ...p, fontScale: Number((e.target as HTMLInputElement).value) }).then(() => app.render(true)) })),
    preview,
    h('p', { class: 'muted' }, t('set.fontHelp')),
  );
}

function remindersSection(app: App): HTMLElement {
  const p = app.prefs;
  const supported = notificationsSupported();
  const perm = supported ? Notification.permission : 'unsupported';
  const time = h('input', { type: 'time', value: p.reminder.time, onchange: () => void app.act(() => app.savePrefs({ ...p, reminder: { ...p.reminder, time: time.value || '07:00' } }), t('set.reminderSaved')) });
  const permText = perm === 'unsupported' ? t('set.permUnsupported') : perm === 'granted' ? t('set.permGranted') : perm === 'denied' ? t('set.permDenied') : t('set.permDefault');
  return section(
    'reminders',
    t('set.reminders'),
    h('p', { class: 'muted' }, t('set.remindersHelp')),
    h('label', { class: 'choice' }, h('input', { type: 'checkbox', checked: p.reminder.enabled, onchange: async (e: Event) => { const on = (e.target as HTMLInputElement).checked; if (on && supported && Notification.permission === 'default') await requestNotificationPermission(); await app.savePrefs({ ...p, reminder: { ...p.reminder, enabled: on } }); app.render(true); } }), h('span', null, t('set.remindOpen'))),
    h('label', { class: 'field', style: { 'max-width': '12rem' } }, h('span', null, t('set.time')), time),
    h('p', null, h('small', { class: 'muted' }, t('set.permission', { state: permText })), perm === 'default' ? h('button', { type: 'button', class: 'quiet', onclick: async () => { await requestNotificationPermission(); app.render(true); } }, t('set.allowNotifications')) : null),
    h('button', { type: 'button', onclick: () => download('hafeez-helfer-daily-revision.ics', buildIcs(p.reminder.time, t('set.icsTitle'), app.now(), location.href.split('#')[0] ?? ''), 'text/calendar') }, t('set.downloadIcs')),
  );
}

function accountSection(app: App): HTMLElement | null {
  const account = app.deps.account;
  if (!account) return null;
  const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: '8', dir: 'ltr', class: 'ltr' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', minlength: '8', dir: 'ltr', class: 'ltr' });
  const pwStatus = h('p', { role: 'alert', style: { color: 'var(--mistake)', margin: '0.25rem 0 0' } });
  const status = h('span', { class: 'sync-status' });
  queueMicrotask(() => app.updateSyncStatus());
  return section(
    'account',
    t('acct.title'),
    h('p', null, t('acct.signedInAs', { email: '' }), h('strong', { dir: 'ltr' }, account.email)),
    h('p', { class: 'muted', role: 'status' }, status),
    h('div', { class: 'row' },
      h('button', { type: 'button', 'data-key': 'acct-sync', onclick: () => void account.sync.syncNow({ full: true }) }, t('acct.syncNow')),
      h('button', { type: 'button', 'data-key': 'acct-signout', onclick: () => void account.signOut() }, t('acct.signOut')),
    ),
    h('p', { class: 'muted', style: { 'margin-top': '0.5rem' } }, t('acct.signOutNote')),
    h('h3', { style: { 'margin-top': '1rem' } }, t('acct.changePassword')),
    h('form', {
      class: 'fields', novalidate: true,
      onsubmit: async (e: Event) => {
        e.preventDefault();
        pwStatus.textContent = '';
        if (pw.value.length < 8) { pwStatus.textContent = t('auth.vPassword'); return; }
        if (pw.value !== pw2.value) { pwStatus.textContent = t('auth.vMatch'); return; }
        try {
          await account.changePassword(pw.value);
          pw.value = '';
          pw2.value = '';
          app.toast(t('acct.passwordChanged'));
        } catch (err) {
          pwStatus.textContent = authErrorText(err);
        }
      },
    },
      h('label', { class: 'field' }, h('span', null, t('auth.newPassword')), pw, h('small', { class: 'muted' }, t('auth.passwordHint'))),
      h('label', { class: 'field' }, h('span', null, t('auth.confirmPassword')), pw2),
      h('div', { class: 'field', style: { 'justify-content': 'flex-end' } }, h('button', { type: 'submit' }, t('acct.changePassword'))),
    ),
    pwStatus,
    h('h3', { style: { 'margin-top': '1rem' } }, t('acct.delete')),
    h('p', { class: 'muted' }, t('acct.deleteHelp')),
    h('button', {
      type: 'button', class: 'danger', 'data-key': 'acct-delete',
      onclick: async () => {
        if (await confirmDialog(t('acct.deleteTitle'), t('acct.deleteBody'), t('acct.deleteConfirm'), true)) await app.act(() => account.deleteAccount());
      },
    }, t('acct.delete')),
  );
}

function privacySection(app: App): HTMLElement {
  const file = h('input', { type: 'file', accept: 'application/json,.json', 'aria-label': t('set.backupFile') });
  let mode: 'replace' | 'merge' = 'merge';
  const hasDemo = app.data.mistakes.some((m) => m.demo);
  return section(
    'privacy',
    t('set.privacy'),
    app.deps.account
      ? [h('p', null, t('set.privacyCloudP1')), h('p', { class: 'muted' }, t('set.privacyCloudP2'))]
      : [h('p', null, t('set.privacyP1'), app.s.store.kind === 'memory' ? h('strong', null, t('set.privacyMemory')) : '', t('set.privacyP1End')), h('p', { class: 'muted' }, t('set.privacyP2'))],
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary', onclick: async () => { const b = await exportBackup(app.s.store, app.now()); download(`hafeez-helfer-backup-${app.today()}.json`, JSON.stringify(b, null, 2), 'application/json'); app.toast(t('set.exported')); } }, t('set.export')),
      h('button', { type: 'button', class: 'quiet', onclick: async () => { const r = await requestPersistentStorage(); app.toast(r === null ? t('set.persistUnsupported') : r ? t('set.persistOk') : t('set.persistNo')); } }, t('set.persist')),
    ),
    h('h3', { style: { 'margin-top': '1rem' } }, t('set.restoreTitle')),
    h('div', { class: 'row' },
      file,
      h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'restore', checked: true, onchange: () => { mode = 'merge'; } }), h('span', null, t('set.merge'))),
      h('label', { class: 'choice' }, h('input', { type: 'radio', name: 'restore', onchange: () => { mode = 'replace'; } }), h('span', null, t('set.replace'))),
      h('button', {
        type: 'button',
        onclick: async () => {
          const f = file.files?.[0];
          if (!f) { app.toast(t('error.chooseBackup'), 'error'); return; }
          await app.act(async () => {
            const backup = parseBackup(await readJsonFile(f));
            if (mode === 'replace' && !(await confirmDialog(t('set.replaceTitle'), t('set.replaceBody'), t('set.replaceBtn'), true))) return;
            const res = await restoreBackup(app.s.store, backup, mode);
            if (res.preferences) await app.savePrefs(res.preferences);
            await app.refresh();
            app.toast(t('set.restored', { mistakes: res.summary.mistakes, reviews: res.summary.reviews }));
          });
        },
      }, t('set.restore')),
    ),
    h('h3', { style: { 'margin-top': '1rem' } }, t('set.demo')),
    h('p', { class: 'muted' }, t('set.demoHelp')),
    h('div', { class: 'row' },
      hasDemo
        ? h('button', { type: 'button', onclick: () => void app.act(async () => { await removeDemoData(app.s.store); await app.refresh(); }, t('set.demoRemoved')) }, t('set.demoRemove'))
        : h('button', { type: 'button', 'data-key': 'load-demo', onclick: () => void app.act(async () => { await seedDemoData(app.s.store, app.s.clock, app.s.ids); await app.refresh(); }, t('set.demoLoaded')) }, t('set.demoLoad')),
      h('button', { type: 'button', class: 'danger', onclick: async () => { if (await confirmDialog(t('set.wipeTitle'), app.deps.account ? t('set.wipeBodyCloud') : t('set.wipeBody'), t('set.wipeBtn'), true)) await app.act(async () => { const keep = app.prefs.language; await wipePersonalData(app.s.store); app.prefs = await app.s.preferences.load(); await app.savePrefs({ ...app.prefs, language: keep }); await app.refresh(); }, t('set.wiped')); } }, t('set.wipe')),
    ),
  );
}

export function settingsView(app: App): Node {
  const focus = app.route.params.get('section');
  if (focus) queueMicrotask(() => document.getElementById(`settings-${focus}`)?.scrollIntoView({ block: 'start' }));
  return h(
    'div',
    null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, t('set.title')))),
    h('div', { class: 'stack' },
      accountSection(app),
      section('language', t('set.language'), h('p', { class: 'muted' }, t('set.languageHelp')), app.languageSwitch()),
      quranDataSection(app),
      audioSection(app),
      playbackSection(app),
      appearanceSection(app),
      remindersSection(app),
      privacySection(app),
      section('about', t('set.about'), h('p', null, t('set.aboutP1')), h('p', { class: 'muted' }, t('set.aboutP2'))),
    ),
  );
}
