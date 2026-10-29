# Hafeez Helfer

An open-source, local-first assistant for people who have memorized Quran and want to keep
their Hifz strong. You mark the words and ayat where you make mistakes; Hafeez Helfer remembers
them and builds a personal audio revision playlist of exactly those ayat, in Quran order, for
today's portion, repeated as many times as you choose.

No account, no tracking, and no AI service required. Your data stays on your device.

## What it does

* **Accounts and synced history** (optional at build time): sign in with email and password and
  your mistakes, answers and plans follow you to any device, while the app keeps working offline.
  Free hosting on GitHub Pages with a free Supabase project; see [docs/DEPLOY.md](docs/DEPLOY.md).
  Without Supabase settings the app runs local-only with no sign-in.
* **Arabic and English interface** (Arabic by default, right-to-left; English left-to-right).
  Switch any time from the sidebar, the top bar on phones, or Settings; your choice is saved on
  the device. The Quran text is always shown exactly as supplied by the verified source.
* **Quran reader** with Uthmani text, right-to-left, adjustable size, light and dark themes.
  Navigate by surah, ayah, juz, hizb, quarter, eighth (if imported) and page. A division panel
  shows the exact start and end of the portion, its quarters and eighths with their starting
  ayat, your reading position, and how many mistakes are marked, unresolved and resolved there.
* **Mistake marking**: tap a word, or an ayah number for the whole ayah. Choose a type (forgotten,
  hesitation, incorrect word, similar ayah, ayah ending, tajweed, other), severity, confidence,
  "confused with", and a private note. Tapping the **first word** of an ayah pre-selects
  *Linking ayat (transition)*, because the difficulty is usually connecting the previous ayah to it. Marking the same place again records a recurrence instead
  of a duplicate. Lifecycle: new, needs practice, under review, improved, resolved, reopened;
  resolved mistakes stay in your history.
* **Personal audio revision**: today's hizb (or any juz, quarter, eighth, page, surahs, ayah range,
  date range, type or status) becomes a playlist of only the relevant unresolved ayat, sorted in
  Quran order, one entry per ayah even when several words are marked. Settings: reciter, total
  plays per ayah, passes per group and per playlist, pauses, speed, neighbouring ayat, word
  practice, mistake types. Controls: play/pause, previous/next, restart ayah, next mistake,
  restart playlist, stop, repetition indicator (3/5), progress, lock-screen controls.
* **Recall-based progress**: after each marked ayah you answer *correct*, *correct but
  difficult*, *needed a prompt* or *mistake again*. Only these answers move statuses, the review
  schedule and the score. Listening never counts as memorizing, and nothing is resolved for you.
* **Test** (between My mistakes and Progress): choose a surah, juz, hizb or quarter. Every question
  shows the previous ayah in full. For a mistake inside an ayah, the ayah is shown up to the
  mistaken word and the rest is hidden; for a linking mistake (or a first-word or whole-ayah
  mistake) the whole ayah is hidden. With several mistakes in one ayah, each is asked in turn:
  "Reveal" stops just before the next mistake, which stays hidden until you answer.
  Answering "Correct without difficulty" (without hints) marks that mistake resolved, and it turns
  from red to green everywhere. "Also test old resolved mistakes" (off by default) re-checks them;
  a resolved mistake that fails is reopened. "Hint" uncovers one word at a time (then the answer counts as *needed a prompt*),
  "Reveal" shows the rest, and your answer updates status, schedule and progress. Unresolved
  mistakes by default, resolved ones optionally; Quran order or mixed.
* **Daily revision planner** with mistakes-only, full, or combined revision, estimated
  duration, completion status, last revision date, "continue tomorrow", a separate
  memorization plan, and local reminders (in-app notification and a calendar `.ics`).
* **Dashboard and progress**: unresolved, resolved and returning mistakes, ayat recalled today,
  streak, a transparent *estimated revision quality* score with its formula, 30-day trend,
  performance by surah, juz, hizb, quarter and eighth, ayat needing most practice, ayat not
  reviewed recently, due and upcoming reviews.
* **Privacy and data**: backup/restore (merge or replace), demo data that is clearly labelled and
  removable, delete-everything, offline app shell, optional offline audio.

## Quick start

Requirements: Node.js **22.18 or newer** (runs the TypeScript tests natively).

```bash
npm install
npm run build
npm start                # http://127.0.0.1:5173
```

Development with rebuild on change: `npm run dev`.

**First run:** open *Settings → Quran text and divisions → Download Quran data* (about 2.5 MB,
once). The download is verified (counts, order, cross-check with `/meta`, and the bundled
verified juz/hizb anchors) and stored for offline use. Alternatively, run `npm run data:fetch`
before building to ship the verified data with the app (`public/data/`). Without the data,
the reader lists ayat by reference and you can still mark ayat and listen.

To look around before using it for real: *Settings → Privacy, backup and data → Load demo data*.

### Publish on GitHub Pages (free) with accounts

Follow [docs/DEPLOY.md](docs/DEPLOY.md): push to GitHub, create a free Supabase project, run
`supabase/schema.sql`, add two repository variables, and the included workflow builds, tests and
publishes the site.

### Docker

```bash
docker build -t hafeez-helfer .                              # add --build-arg FETCH_QURAN_DATA=1 to bundle the data
docker run --rm -p 8080:80 hafeez-helfer                     # http://localhost:8080
```

No environment variables or secrets are needed (`.env.example` lists the optional local server
`PORT`/`HOST`).

## A walk through the main journey

1. **Dashboard → Set today's revision**, choose *Hizb 5*. The planner shows that Hizb 5 runs from
   Al-Baqarah 2:253 to Al 'Imran 3:14, lists its quarters with their starting ayat, and counts your
   marked and unresolved mistakes in it.
2. While reciting, open **Quran → Hizb 5**, tap the word you got wrong (or the ayah number) and
   choose the mistake type. It turns red and is saved immediately.
3. Back in **Daily revision**, pick *Mistake revision* and **Start revision**. The preview lists
   the ayat in Quran order with their mistake types and the exact number of plays; mistakes in
   other portions are excluded and counted.
4. Press **Start**. Each ayah plays the configured number of times (5 means five plays). After a
   marked ayah the player pauses and asks how you recalled it.
5. **Finish session**: today's plan is marked done. Your mistakes keep their status until you
   resolve them yourself. The dashboard and Progress update from your answers.

## Project structure

```
src/
  core/                 platform-independent domain logic (no DOM; enforced by lint)
    quran/              surahs, verified anchors, references, divisions, validation, scopes, text, tokenizer
    data/               AlQuran.cloud and Tanzil parsers, data service, eighths import
    mistakes/           mistake service (marking, dedupe, lifecycle, reviews), filters
    review/             review policy, scheduler, quality score
    test/               recall-test cards (what to show, what to hide), hints, allowed answers
    playlist/           playlist generator, repetition sequence expander
    audio/              reciter presets and URL templates, playback state machine
    plan/ session/      daily plans and sessions, session assembly
    dashboard/          aggregation
    storage/            Store interface, in-memory store, backup/restore with validation
    settings/           preferences schema
    sync/               Supabase sign-in client and local-first sync engine (HTTP injected)
  browser/              IndexedDB store, HTML audio backend, offline audio cache, reminders, session storage
  ui/                   tiny DOM helper, app controller, views, components, styles
    i18n/               interface translations (locales/ar.ts, locales/en.ts), Intl formatting, localized labels
    auth/               sign-in screens and account controller
harness/                in-browser end-to-end journeys
tests/                  node:test unit/integration tests and synthetic fixtures
supabase/               database schema (one table with Row Level Security)
.github/workflows/      GitHub Pages deployment
scripts/                build, serve, lint, data fetch
docs/                   ADR, data sources, scoring, privacy, research, testing
```

## Documentation

* [Architecture decision record](docs/ADR-001-architecture.md)
* [Interface design and Arabic/English localization](docs/ADR-002-ui-and-i18n.md)
* [Publish for free: GitHub Pages + Supabase accounts](docs/DEPLOY.md)
* [Quran data and audio: provenance, verification, licences](docs/DATA_SOURCES.md)
* [Review policy, scheduler and quality score](docs/SCORING_AND_SCHEDULING.md)
* [Privacy model](docs/PRIVACY.md)
* [Testing](docs/TESTING.md)
* [Reference project research](docs/RESEARCH.md)

## Reciters and audio

Presets stream per-ayah MP3s from EveryAyah.com (Mahmoud Khalil Al-Husary murattal and
mujawwad, Al-Hudhaify, Muhammad Ayyoub, and unverified presets for Al-Minshawi, Abdul Basit and
Alafasy) and the Islamic Network CDN (Al-Husary). Use **Test** in Settings to check a source, or
add your own with a URL template such as `https://host/path/{surah3}{ayah3}.mp3` or
`…/{global}.mp3`. No audio is bundled; offline copies are made only when you ask.

## Known limitations

* **Eighths (thumn)** are not in the Madani/Hafs metadata; they work after importing a verified list.
* **Word-level audio** (starting playback at a marked word) is not available: no verified word timings are integrated, so the whole ayah plays and the app says so.
* **Word references** are positions in the stored Tanzil edition, not Quran.com word IDs.
* **Reminders** fire only while the app is open; use the calendar file for reliable reminders.
* **Not exercised in the build environment** (no internet, Docker or browser automation available):
  real AlQuran.cloud downloads, real audio playback, and Docker builds.
  See [docs/TESTING.md](docs/TESTING.md).
* Sync between devices needs the optional Supabase setup (otherwise use backup/restore). The
  sign-in and sync code is tested against a simulated Supabase server; it was not run against a
  live project from the build environment. No speech recognition.

## Roadmap

Optional backend proxy for Quran Foundation word IDs and word-timed audio; Playwright CI running
the harness; multi-device sync; mutashabihat suggestions; speech-recognition experiments
(only with proper evaluation on Quran recitation data).

## Licence

MIT, see [LICENSE](LICENSE). Quran text: Tanzil.net (CC BY 3.0) via AlQuran.cloud. Recitations
belong to their reciters and publishers.
