# Privacy model

The app has two modes, decided when it is built (see [DEPLOY.md](DEPLOY.md)):

* **Local-only** (no Supabase settings): no account and no server. Everything below applies as written.
* **Accounts** (Supabase configured, e.g. the public GitHub Pages site): sign-in with email and
  password is required. Personal data is stored on the device **and** synced to the site
  operator's Supabase project, in one table protected by Row Level Security so each user can read
  and write only their own rows. Synced: mistakes (including notes), recall answers, history
  events, plans, sessions, preferences and reading position. Not synced: Quran text, audio,
  reminder state. Passwords are handled by Supabase Auth and never stored by the app; the session
  token is kept in the browser's local storage. Signing out deletes the account's copy from the
  device; *Delete account* deletes the user and all their rows on the server. There are still no
  analytics and no tracking.

## Local data

* **No analytics, no tracking.** The app is static files.
* **Personal data stays in the browser** (IndexedDB database `hafeez-helfer`): mistakes,
  notes, recall answers, review history, plans, sessions, preferences. If IndexedDB is not
  available, the app runs in memory and warns that data will be lost on close.
* **Network requests** happen only for:
  1. downloading the Quran text and metadata (AlQuran.cloud, or its official mirror), on request;
  2. streaming recitation audio from the selected host (the URL contains only the ayah number);
  3. testing an audio source, or saving audio for offline use, on request.
  No request ever contains notes, mistakes or progress.
* **Backups** are JSON files the user downloads and restores (merge or replace), validated
  with a schema before anything is written. Quran text and audio are not part of backups.
* **Deletion:** "Delete all personal data" in Settings wipes every personal record; individual
  mistakes can be deleted permanently from their details dialog. Nothing is deleted automatically.
* **Offline:** the app shell is cached by a service worker; Quran text and divisions are cached
  in IndexedDB after the first download; mistakes work fully offline; audio works offline only
  for files the user saved. Missing audio is reported as an error, never skipped silently.
* **Reminders** are local: in-app notifications while the app is open, plus a downloadable
  calendar (.ics) event. There is no push server.
