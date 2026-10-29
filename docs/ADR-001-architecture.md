# ADR-001: Architecture of Hafeez Helfer

Status: accepted (2026-10-28)

## Context

The repository was empty. The requirements call for a local-first, privacy-respecting Quran
memorization assistant with verified Quran navigation, mistake tracking, a deterministic audio
revision engine, scheduling, scoring and a dashboard, without a paid AI service.

Constraints of the build environment used for the first implementation:

* No package-registry or general web access (npm returned HTTP 403, URL fetching was blocked).
  Only Node 22, TypeScript 7, esbuild, and zod were available locally. React, a test runner such
  as Vitest, Playwright and a browser were **not** available.
* Quran text and division datasets could not be downloaded inside the build environment.

## Decisions

1. **Progressive Web App, TypeScript, no UI framework.** The UI is written with a tiny typed DOM
   helper (`src/ui/dom.ts`) and view functions. This keeps the dependency surface to `zod` at
   runtime and lets the entire app be type-checked, bundled and tested with the tools that were
   actually available. All business logic lives in `src/core` and has no DOM dependency, so a
   React/React Native or native client could reuse it later.
2. **Local-first persistence in IndexedDB** behind a `Store` interface (`src/core/storage`).
   An in-memory implementation is used in tests and as a fallback when IndexedDB is unavailable
   (the UI shows a warning in that case). Schema is versioned with explicit migrations.
3. **No backend.** Nothing in the MVP needs one. Sync is a future enhancement; backups are
   JSON export/import.
4. **Quran data is never typed by hand.** Text and per-ayah division metadata are obtained from
   AlQuran.cloud (`quran-uthmani` edition, derived from Tanzil, CC BY 3.0), either at runtime
   in the browser (one request, cached in IndexedDB) or ahead of time with
   `npm run data:fetch`, which also cross-checks against Tanzil's `quran-data.js`.
   The app bundles only small, independently verified **anchors** (114 surah ayah counts,
   30 juz starts, hizb 1–11 starts, with citations) and uses them to *reject* any downloaded
   dataset that disagrees.
5. **Division boundaries are derived from per-ayah metadata**, never from arithmetic.
   Eighths (thumn) are not part of the Hafs/Madani metadata; they are supported through an
   importable, validated division dataset (see `docs/DATA_SOURCES.md`).
6. **The Quran.com/Quran Foundation API is not used from the browser.** Its current Content APIs
   require OAuth2 client credentials, which cannot be kept secret in a client-only app. Word
   references therefore use the position of a whitespace-delimited word token in the stored
   edition text (`edition + surah + ayah + position`), together with a snapshot of the token for
   integrity checks. Pause marks and other symbol-only tokens are not selectable words.
7. **Audio** is streamed per-ayah from configurable URL templates (EveryAyah and the
   Islamic Network CDN presets, or a custom template). Nothing is bundled. Optional offline
   caching stores files the user explicitly downloads, if the source allows CORS.
8. **Deterministic engines.** Playlist building, the playback state machine, the review
   scheduler and the quality score are pure/injected modules with exhaustive unit tests.
   Playback never counts as a recall; only explicit review outcomes feed scores.
9. **Testing** uses Node's built-in `node:test` runner on TypeScript sources (Node ≥ 22.18
   strips types natively). Browser journeys are covered by an in-page harness
   (`harness/`) that drives the real UI against the real IndexedDB adapter with a mocked audio
   backend and a synthetic, clearly-labelled fixture text.

## Consequences

* The app is small, auditable and has one runtime dependency.
* Until the user downloads the Quran dataset (one click, or `npm run data:fetch`), the reader can
  navigate references and divisions anchored by the verified juz/hizb data but cannot show text.
* Word-level audio positioning is not available (no verified timing data is integrated);
  the UI states this explicitly and plays the whole ayah.
